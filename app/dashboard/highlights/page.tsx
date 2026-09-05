import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import PageHeader from '@/components/PageHeader'
import HighlightsList, { type Highlight } from './HighlightsList'

export const dynamic = 'force-dynamic'

const HIGHLIGHTS_LIMIT = 35

function normalizeText(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ')
}

export default async function HighlightsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: creator, error: creatorError } = await supabase
    .from('creators')
    .select('id')
    .eq('user_id', user.id)
    .single()

  if (creatorError || !creator) {
    redirect('/login')
  }

  const { data: posts, error: postsError } = await supabase
    .from('posts')
    .select('id, title')
    .eq('creator_id', creator.id)

  if (postsError) {
    console.error('Highlights posts fetch error:', JSON.stringify(postsError, Object.getOwnPropertyNames(postsError), 2))
    return (
      <div className="p-6">
        <p className="text-red-500">Failed to load your videos.</p>
      </div>
    )
  }

  const postList = posts || []
  const postIds = postList.map(p => p.id)
  const postMap = new Map(postList.map(p => [p.id, p.title]))

  type CommentRow = {
    id: string
    text: string
    posted_at: string
    post_id: string
    audience_member_id: string | null
    audience_members: unknown
    comment_categories: unknown
  }

  const allComments: CommentRow[] = []

  if (postIds.length > 0) {
    let offset = 0
    const batchSize = 1000
    let hasMore = true

    while (hasMore) {
      const { data: batch, error: commentsError } = await supabase
        .from('comments')
        .select(
          `
          id,
          text,
          posted_at,
          post_id,
          audience_member_id,
          audience_members ( display_name ),
          comment_categories ( category, draft_reply, draft_reply_approved_at, draft_reply_created_at )
        `
        )
        .in('post_id', postIds)
        .range(offset, offset + batchSize - 1)

      if (commentsError) {
        console.error('Highlights comments fetch error:', JSON.stringify(commentsError, Object.getOwnPropertyNames(commentsError), 2))
        break
      }

      if (batch && batch.length > 0) {
        allComments.push(...(batch as unknown as CommentRow[]))
        offset += batchSize
      }

      if (!batch || batch.length < batchSize) {
        hasMore = false
      }
    }
  }

  function getAuthorName(row: CommentRow): string {
    return (row.audience_members as { display_name: string } | null)?.display_name || 'Unknown'
  }

  function getCategoryInfo(row: CommentRow) {
    return row.comment_categories as {
      category: string
      draft_reply: string | null
      draft_reply_approved_at: string | null
      draft_reply_created_at: string | null
    } | null
  }

  function sortByDraftRecency(a: CommentRow, b: CommentRow): number {
    const aTime = getCategoryInfo(a)?.draft_reply_created_at || a.posted_at
    const bTime = getCategoryInfo(b)?.draft_reply_created_at || b.posted_at
    return new Date(bTime).getTime() - new Date(aTime).getTime()
  }

  function pendingDraftsFor(category: string): CommentRow[] {
    return allComments
      .filter(c => {
        const cat = getCategoryInfo(c)
        return cat?.category === category && cat.draft_reply && !cat.draft_reply_approved_at
      })
      .sort(sortByDraftRecency)
  }

  // --- Repeated-comment detection — same normalize-and-group approach as the
  // Repeated Comments page, scoped to this creator's own comments only ---
  const normalizedGroups = new Map<string, Array<{ id: string; audienceMemberId: string | null }>>()
  for (const comment of allComments) {
    const key = normalizeText(comment.text)
    const existing = normalizedGroups.get(key) || []
    existing.push({ id: comment.id, audienceMemberId: comment.audience_member_id })
    normalizedGroups.set(key, existing)
  }

  const repeatCountByCommentId = new Map<string, number>()
  for (const entries of normalizedGroups.values()) {
    const uniqueMembers = new Set(entries.map(e => e.audienceMemberId).filter(Boolean))
    if (uniqueMembers.size < 2) continue
    for (const entry of entries) {
      repeatCountByCommentId.set(entry.id, entries.length)
    }
  }

  const repeated = allComments
    .filter(c => repeatCountByCommentId.has(c.id))
    .sort((a, b) => {
      const countDiff = (repeatCountByCommentId.get(b.id) || 0) - (repeatCountByCommentId.get(a.id) || 0)
      if (countDiff !== 0) return countDiff
      return new Date(b.posted_at).getTime() - new Date(a.posted_at).getTime()
    })

  function toHighlight(comment: CommentRow, reason: Highlight['reason']): Highlight {
    return {
      id: comment.id,
      text: comment.text,
      postedAt: comment.posted_at,
      authorName: getAuthorName(comment),
      postId: comment.post_id,
      videoTitle: postMap.get(comment.post_id) || 'Untitled video',
      reason,
      draftReply: getCategoryInfo(comment)?.draft_reply || null,
      repeatCount: repeatCountByCommentId.get(comment.id) || null,
    }
  }

  // --- Assemble highlights, priority order:
  //   1. purchase_intent with a pending draft reply (highest priority)
  //   2. complaint with a pending draft reply
  //   3. question with a pending draft reply
  //   4. repeated/trending comments (kept separate from the above)
  // "Noticed" (reward_events) is no longer a highlight criterion at all.
  // Dedup via selectedIds so a comment matching multiple criteria (e.g. a pending-draft
  // purchase_intent comment that's also repeated) only appears once, under its
  // highest-priority reason.
  const draftPriorityOrder = [
    ...pendingDraftsFor('purchase_intent'),
    ...pendingDraftsFor('complaint'),
    ...pendingDraftsFor('question'),
  ]

  const selectedIds = new Set<string>()
  const highlights: Highlight[] = []

  for (const comment of draftPriorityOrder) {
    if (selectedIds.has(comment.id)) continue
    selectedIds.add(comment.id)
    highlights.push(toHighlight(comment, 'pending_draft'))
  }

  for (const comment of repeated) {
    if (selectedIds.has(comment.id)) continue
    selectedIds.add(comment.id)
    highlights.push(toHighlight(comment, 'repeated'))
  }

  const cappedHighlights = highlights.slice(0, HIGHLIGHTS_LIMIT)

  // Split back out into the two sections HighlightsList renders — filter() preserves
  // the priority ordering established above within each group.
  const draftHighlights = cappedHighlights.filter(h => h.reason === 'pending_draft')
  const repeatedHighlights = cappedHighlights.filter(h => h.reason === 'repeated')

  return (
    <div className="mx-auto max-w-3xl p-6">
      <PageHeader title="Highlights" backHref="/dashboard/agent" backLabel="Agent Home" />
      <HighlightsList draftHighlights={draftHighlights} repeatedHighlights={repeatedHighlights} />
    </div>
  )
}
