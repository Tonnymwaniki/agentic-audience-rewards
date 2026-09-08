import { createServiceClient } from '@/lib/supabase/service'
import { fetchInBatches } from '@/lib/supabase-helpers'
import {
  generateDraftReply,
  loadStyleExamples,
  isBusinessRelevant,
  BUSINESS_PROFILE_COLUMNS,
  type BusinessProfile,
} from '@/lib/categorize'

const DRAFTABLE_CATEGORIES = new Set(['purchase_intent', 'question', 'complaint'])
const RELEVANCE_CHECK_CATEGORIES = new Set(['question', 'complaint'])

// Each comment costs up to two sequential Claude calls (relevance check, then the
// draft itself), so an uncapped run over a large channel would blow past any
// Vercel function limit. Anything past the cap is reported back as `remaining`
// rather than silently dropped.
const MAX_REGENERATIONS_PER_RUN = 25

export type RegenerationResult = {
  success: boolean
  considered: number
  regenerated: number
  skippedCasual: number
  failed: number
  remaining: number
}

type CommentRow = {
  id: string
  text: string
  post_id: string
}

type CategoryRow = {
  comment_id: string
  category: string
  draft_reply: string | null
  draft_reply_approved_at: string | null
  draft_reply_checked_at: string | null
}

/**
 * Re-drafts replies for a creator's comments, optionally scoped to one post.
 *
 * Deliberately covers BOTH comments with no draft yet and comments whose existing
 * draft has not been approved — a draft written before the Business Profile
 * existed is exactly the one that needs refreshing, and limiting this to null
 * drafts would make the profile-save trigger a near no-op.
 *
 * Drafts the creator has already approved (draft_reply_approved_at set) are never
 * touched, so reviewed work is never overwritten.
 */
export async function regenerateDraftsForCreator(
  creator_id: string,
  post_id?: string
): Promise<RegenerationResult> {
  const supabase = createServiceClient()
  // Captured before any work so "already refreshed in this sweep" is well-defined.
  const runStartedAt = Date.now()
  const empty: RegenerationResult = {
    success: true,
    considered: 0,
    regenerated: 0,
    skippedCasual: 0,
    failed: 0,
    remaining: 0,
  }

  let postsQuery = supabase
    .from('posts')
    .select('id, title, content')
    .eq('creator_id', creator_id)

  if (post_id) {
    postsQuery = postsQuery.eq('id', post_id)
  }

  const { data: posts, error: postsError } = await postsQuery

  if (postsError) {
    console.error('Draft regeneration posts fetch error:', JSON.stringify(postsError, Object.getOwnPropertyNames(postsError), 2))
    return { ...empty, success: false }
  }

  const postList = posts || []
  const postIds = postList.map(p => p.id)
  if (postIds.length === 0) return empty

  const postMeta = new Map(
    postList.map(p => [p.id, { title: p.title || '', description: p.content || '' }])
  )

  // Fetched once for the whole run, not per comment.
  let businessProfile: BusinessProfile | null = null
  const { data: creator, error: profileError } = await supabase
    .from('creators')
    .select(BUSINESS_PROFILE_COLUMNS)
    .eq('id', creator_id)
    .maybeSingle()

  if (profileError) {
    console.error('Draft regeneration profile fetch error:', JSON.stringify(profileError, Object.getOwnPropertyNames(profileError), 2))
  } else if (creator) {
    businessProfile = creator as unknown as BusinessProfile
  }

  // Also once per run, not per comment: a 25-comment sweep would otherwise issue 25
  // identical style queries. Empty for a creator who has never edited a draft, in
  // which case the prompt is unchanged from before this feature.
  const styleExamples = await loadStyleExamples(supabase, creator_id)
  if (styleExamples.length > 0) {
    console.log(`Draft regeneration: applying ${styleExamples.length} style example(s) from past edits.`)
  }

  const comments: CommentRow[] = []
  let offset = 0
  const batchSize = 1000
  let hasMore = true

  while (hasMore) {
    const { data: batch, error: commentsError } = await supabase
      .from('comments')
      .select('id, text, post_id')
      .in('post_id', postIds)
      .range(offset, offset + batchSize - 1)

    if (commentsError) {
      console.error('Draft regeneration comments fetch error:', JSON.stringify(commentsError, Object.getOwnPropertyNames(commentsError), 2))
      return { ...empty, success: false }
    }

    if (batch && batch.length > 0) {
      comments.push(...batch)
      offset += batchSize
    }

    if (!batch || batch.length < batchSize) {
      hasMore = false
    }
  }

  if (comments.length === 0) return empty

  const categories = await fetchInBatches<CategoryRow>(supabase, {
    table: 'comment_categories',
    select: 'comment_id, category, draft_reply, draft_reply_approved_at, draft_reply_checked_at',
    inColumn: 'comment_id',
    inValues: comments.map(c => c.id),
  })

  const categoriesByCommentId = new Map(categories.map(c => [c.comment_id, c]))

  const targets = comments.filter(comment => {
    const category = categoriesByCommentId.get(comment.id)
    if (!category || !DRAFTABLE_CATEGORIES.has(category.category)) return false
    // Never clobber a draft the creator has already approved.
    return !category.draft_reply_approved_at
  })

  // Eligibility can't shrink as work completes (an unapproved draft stays eligible
  // by design, so profile changes can refresh it), so ordering is what makes a
  // capped run progress. Least-recently-checked first, never-checked first of all;
  // every comment processed below gets stamped, sending it to the back.
  const lastCheckedAt = (commentId: string): number => {
    const checked = categoriesByCommentId.get(commentId)?.draft_reply_checked_at
    return checked ? new Date(checked).getTime() : 0
  }

  console.log(
    "REGEN DEBUG - total targets:",
    targets.length,
    "sample checked_at values:",
    targets.slice(0, 5).map(t => ({
      id: t.id,
      checked_at: categoriesByCommentId.get(t.id)?.draft_reply_checked_at ?? null,
    }))
  )

  targets.sort((a, b) => lastCheckedAt(a.id) - lastCheckedAt(b.id))

  const batchToProcess = targets.slice(0, MAX_REGENERATIONS_PER_RUN)
  const processedIds = new Set(batchToProcess.map(c => c.id))

  // NOT `targets.length - batch.length`: eligibility never shrinks (an unapproved
  // draft stays eligible on purpose), so that subtraction is a constant and always
  // reports the same number no matter how much work is done. What the creator
  // actually wants to know is how many comments this sweep hasn't refreshed yet —
  // i.e. still carrying a checked_at from before this run started.
  const remaining = targets.filter(comment => {
    if (processedIds.has(comment.id)) return false
    const checked = categoriesByCommentId.get(comment.id)?.draft_reply_checked_at
    return !checked || new Date(checked).getTime() < runStartedAt
  }).length

  if (remaining > 0) {
    console.warn(
      `Draft regeneration: ${targets.length} eligible comments for creator ${creator_id}` +
      `${post_id ? ` (post ${post_id})` : ''} — processing ${batchToProcess.length} this run, ${remaining} left over.`
    )
  }

  let regenerated = 0
  let skippedCasual = 0
  let failed = 0

  // Stamps draft_reply_checked_at (plus any draft fields) so this comment moves to
  // the back of the queue. Called for EVERY outcome — drafted, skipped, or failed —
  // because an unstamped comment stays at the front and blocks the next run.
  async function markChecked(commentId: string, extra: Record<string, unknown> = {}) {
    const { error } = await supabase
      .from('comment_categories')
      .update({ draft_reply_checked_at: new Date().toISOString(), ...extra })
      .eq('comment_id', commentId)

    if (error) {
      console.error('Draft regeneration mark-checked error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
      return false
    }
    return true
  }

  for (const comment of batchToProcess) {
    const category = categoriesByCommentId.get(comment.id)!
    const meta = postMeta.get(comment.post_id)

    try {
      if (RELEVANCE_CHECK_CATEGORIES.has(category.category)) {
        const relevant = await isBusinessRelevant(
          comment.text,
          meta?.title || '',
          meta?.description || ''
        )
        if (!relevant) {
          // Casual comments get no draft, but must still be stamped — otherwise
          // they'd be re-evaluated on every future run forever.
          await markChecked(comment.id)
          skippedCasual++
          continue
        }
      }

      const draft = await generateDraftReply(comment.text, category.category, businessProfile, styleExamples)

      const stamped = await markChecked(comment.id, {
        draft_reply: draft.text,
        draft_confidence: draft.confidence,
        draft_reply_created_at: new Date().toISOString(),
      })

      if (stamped) {
        regenerated++
      } else {
        failed++
      }
    } catch (err) {
      console.error('Draft regeneration error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
      // Stamp failures too, so one comment that reliably errors can't permanently
      // occupy a slot at the front of the queue. Best-effort — if this write also
      // fails, markChecked logs it and we simply retry the comment next run.
      await markChecked(comment.id)
      failed++
    }
  }

  return {
    success: true,
    considered: targets.length,
    regenerated,
    skippedCasual,
    failed,
    remaining,
  }
}
