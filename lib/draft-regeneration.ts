import { createServiceClient } from '@/lib/supabase/service'
import { fetchInBatches } from '@/lib/supabase-helpers'
import { loadCustomProfileFields, customFieldsToContext } from '@/lib/custom-profile-fields'
import { applyFactStatusesForDrafts, loadFactStatuses } from '@/lib/profile-fact-status'
import {
  generateDraftReply,
  loadStyleExamples,
  isBusinessRelevant,
  BUSINESS_PROFILE_COLUMNS,
  type BusinessProfile,
} from '@/lib/categorize'
import { detectEscalation } from '@/lib/escalation'
import { logError, logInfo } from '@/lib/logger'
import { checkPostVerification } from '@/lib/channel-verification'

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
  /** Comments whose channel has no verified ownership grant, so no draft was made. */
  skippedUnverified: number
  failed: number
  remaining: number
}

type CommentRow = {
  id: string
  text: string
  post_id: string
  owner_replied_at?: string | null
}

type CategoryRow = {
  comment_id: string
  category: string
  draft_reply: string | null
  draft_reply_approved_at: string | null
  draft_reply_checked_at: string | null
  escalation_flag: string | null
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
    skippedUnverified: 0,
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
    logError('drafts.regenerate', postsError, { creator_id, stage: 'fetch_posts' })
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
    logError('drafts.regenerate', profileError, { creator_id, stage: 'fetch_business_profile' })
  } else if (creator) {
    businessProfile = creator as unknown as BusinessProfile
  }

  // Also once per run, not per comment: a 25-comment sweep would otherwise issue 25
  // identical style queries. Empty for a creator who has never edited a draft, in
  // which case the prompt is unchanged from before this feature.
  const styleExamples = await loadStyleExamples(supabase, creator_id)
  // Regeneration must see the same facts a first-pass draft sees, custom fields
  // included — otherwise re-drafting silently drops them from every reply.
  // Contradicted profile facts come out of the verified set and go in as uncertain.
  const adjusted = applyFactStatusesForDrafts(businessProfile, await loadCustomProfileFields(supabase, creator_id), await loadFactStatuses(supabase, creator_id))
  businessProfile = adjusted.profile
  const customFieldContext = customFieldsToContext(adjusted.customFields)
  const uncertainFacts = adjusted.uncertain

  // owner_replied_at (migration 55) may not exist yet on this database — dropped
  // on the specific "column does not exist" error rather than failing the run.
  let ownerReplyColumnAvailable = true
  const comments: CommentRow[] = []
  let offset = 0
  const batchSize = 1000
  let hasMore = true

  while (hasMore) {
    let batch: unknown[] | null
    let commentsError: { code?: string; message?: string } | null

    if (ownerReplyColumnAvailable) {
      const result = await supabase.from('comments').select('id, text, post_id, owner_replied_at').in('post_id', postIds).range(offset, offset + batchSize - 1)
      batch = result.data
      commentsError = result.error
      if (commentsError && (commentsError.code === 'PGRST204' || commentsError.code === '42703') && (commentsError.message ?? '').includes('owner_replied_at')) {
        ownerReplyColumnAvailable = false
        const fallback = await supabase.from('comments').select('id, text, post_id').in('post_id', postIds).range(offset, offset + batchSize - 1)
        batch = fallback.data
        commentsError = fallback.error
      }
    } else {
      const result = await supabase.from('comments').select('id, text, post_id').in('post_id', postIds).range(offset, offset + batchSize - 1)
      batch = result.data
      commentsError = result.error
    }

    if (commentsError) {
      logError('drafts.regenerate', commentsError, { creator_id, stage: 'fetch_comments' })
      return { ...empty, success: false }
    }

    if (batch && batch.length > 0) {
      comments.push(...(batch as unknown as CommentRow[]))
      offset += batchSize
    }

    if (!batch || batch.length < batchSize) {
      hasMore = false
    }
  }

  if (comments.length === 0) return empty

  const categories = await fetchInBatches<CategoryRow>(supabase, {
    table: 'comment_categories',
    select: 'comment_id, category, draft_reply, draft_reply_approved_at, draft_reply_checked_at, escalation_flag',
    inColumn: 'comment_id',
    inValues: comments.map(c => c.id),
  })

  const categoriesByCommentId = new Map(categories.map(c => [c.comment_id, c]))

  const targets = comments.filter(comment => {
    const category = categoriesByCommentId.get(comment.id)
    if (!category || !DRAFTABLE_CATEGORIES.has(category.category)) return false
    // Never clobber a draft the creator has already approved.
    if (category.draft_reply_approved_at) return false
    // Already personally answered by the channel owner — no draft needed, however
    // stale the last check. Handled explicitly below (not just filtered out here)
    // so the skip reason gets recorded even the first time this runs after the
    // backfill/an owner reply lands.
    return true
  })

  // Eligibility can't shrink as work completes (an unapproved draft stays eligible
  // by design, so profile changes can refresh it), so ordering is what makes a
  // capped run progress. Least-recently-checked first, never-checked first of all;
  // every comment processed below gets stamped, sending it to the back.
  const lastCheckedAt = (commentId: string): number => {
    const checked = categoriesByCommentId.get(commentId)?.draft_reply_checked_at
    return checked ? new Date(checked).getTime() : 0
  }

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

  let skippedUnverified = 0

  let regenerated = 0
  let skippedCasual = 0
  let failed = 0

  // draft_skip_reason (migration 53) may not exist yet on this database — same
  // self-healing pattern used throughout: drop it from every future call rather
  // than letting every markChecked in this run fail over one missing column.
  let skipReasonColumnAvailable = true

  // Stamps draft_reply_checked_at (plus any draft fields) so this comment moves to
  // the back of the queue. Called for EVERY outcome — drafted, skipped, or failed —
  // because an unstamped comment stays at the front and blocks the next run.
  async function markChecked(commentId: string, extra: Record<string, unknown> = {}) {
    // Clearing a draft clears its creation time too — a draft_reply_created_at
    // with no draft_reply reads as "a draft was written" to anything counting them.
    const cleared = 'draft_reply' in extra && extra.draft_reply === null ? { draft_reply_created_at: null } : {}
    const payload: Record<string, unknown> = { draft_reply_checked_at: new Date().toISOString(), ...extra, ...cleared }
    if (!skipReasonColumnAvailable) delete payload.draft_skip_reason

    const { error } = await supabase.from('comment_categories').update(payload).eq('comment_id', commentId)

    if (error && (error.code === 'PGRST204' || error.code === '42703') && (error.message ?? '').includes('draft_skip_reason')) {
      skipReasonColumnAvailable = false
      delete payload.draft_skip_reason
      const retry = await supabase.from('comment_categories').update(payload).eq('comment_id', commentId)
      if (retry.error) {
        logError('drafts.regenerate', retry.error, { creator_id, stage: 'mark_checked_retry' })
        return false
      }
      return true
    }

    if (error) {
      logError('drafts.regenerate', error, { creator_id, stage: 'mark_checked' })
      return false
    }
    return true
  }

  for (const comment of batchToProcess) {
    const category = categoriesByCommentId.get(comment.id)!
    const meta = postMeta.get(comment.post_id)

    try {
      // Already personally answered by the channel owner (migration 55) — no draft
      // needed, and no API call to find that out; checked before anything else.
      if (ownerReplyColumnAvailable && comment.owner_replied_at) {
        await markChecked(comment.id, { draft_reply: null, draft_skip_reason: 'owner_already_replied' })
        skippedCasual++
        continue
      }

      // Regeneration runs over rows categorized at some earlier time, so it can't
      // use a fresh batch result. Fast path first: an already-flagged row needs no
      // API call at all.
      if (category.escalation_flag) {
        await markChecked(comment.id, { draft_reply: null })
        skippedCasual++
        continue
      }

      // A null flag is ambiguous — it means EITHER screened-and-clean OR categorized
      // before escalation screening existed. Every one of the existing rows is the
      // latter, so reading null as "clean" would silently un-guard all of them. The
      // standalone check remains the fallback for exactly this case.
      const { escalation, checkFailed } = await detectEscalation(comment.text)

      if (escalation) {
        await markChecked(comment.id, { escalation_flag: escalation, draft_reply: null })
        skippedCasual++
        continue
      }

      if (checkFailed) {
        console.warn(`Escalation check failed for comment ${comment.id}; skipping regeneration.`)
        // Same "we don't know it's safe" case as an unscreened comment in the
        // categorizePost path — recorded so it can be found and surfaced rather than
        // just logged to the console.
        await markChecked(comment.id, { draft_skip_reason: 'unscreened' })
        skippedCasual++
        continue
      }

      if (RELEVANCE_CHECK_CATEGORIES.has(category.category)) {
        const relevance = await isBusinessRelevant(
          comment.text,
          meta?.title || '',
          meta?.description || ''
        )
        if (!relevance.relevant) {
          // Casual comments get no draft, but must still be stamped — otherwise
          // they'd be re-evaluated on every future run forever. A failed check (vs a
          // genuine "this is casual" judgment) is recorded distinctly, same as the
          // categorizePost path, so it doesn't read as an intentional filter.
          await markChecked(comment.id, {
            draft_skip_reason: relevance.checkFailed ? 'relevance_check_failed' : 'not_business_relevant',
          })
          skippedCasual++
          continue
        }
      }

      // CAPABILITY GATE, per post: regeneration must not become a way to produce
      // drafts for a channel the creator has not proven they own.
      const verification = await checkPostVerification(supabase, creator_id, comment.post_id)
      if (!verification.verified) {
        skippedUnverified++
        await markChecked(comment.id, { draft_skip_reason: 'unverified_channel' })
        continue
      }

      const draft = await generateDraftReply(comment.text, category.category, businessProfile, styleExamples, customFieldContext, uncertainFacts)

      const stamped = await markChecked(comment.id, {
        draft_reply: draft.text,
        draft_confidence: draft.confidence,
        draft_reply_created_at: new Date().toISOString(),
        draft_skip_reason: null,
      })

      if (stamped) {
        regenerated++
      } else {
        failed++
      }
    } catch (err) {
      logError('drafts.regenerate', err, { creator_id, stage: 'regenerate_draft' })
      // Stamp failures too, so one comment that reliably errors can't permanently
      // occupy a slot at the front of the queue. Best-effort — if this write also
      // fails, markChecked logs it and we simply retry the comment next run.
      await markChecked(comment.id)
      failed++
    }
  }

  if (skippedUnverified > 0) {
    logInfo('drafts.regenerate', 'Some drafts skipped: channel ownership not verified', {
      creator_id, skipped_unverified: skippedUnverified,
    })
  }

  return {
    success: true,
    considered: targets.length,
    regenerated,
    skippedCasual,
    skippedUnverified,
    failed,
    remaining,
  }
}
