import type { SupabaseClient } from '@supabase/supabase-js'

// Shared "what deserves the creator's attention" selection. The Highlights page
// renders the full list; Agent Home previews the top few. Keeping the logic here
// means the preview can never disagree with the page it links to.

export type Highlight = {
  id: string
  text: string
  postedAt: string
  authorName: string
  postId: string
  videoTitle: string
  reason: 'pending_draft' | 'repeated' | 'escalated'
  category: string | null
  draftReply: string | null
  finalReplyText: string | null
  draftConfidence: string | null
  escalationFlag: string | null
  repeatCount: number | null
}

export type HighlightsResult = {
  draftHighlights: Highlight[]
  /** Comments a human must answer personally — never carry a drafted reply. */
  escalatedHighlights: Highlight[]
  repeatedHighlights: Highlight[]
  /** Every pending draft, before the display cap — used for badge counts. */
  totalPendingDrafts: number
}

const EMPTY: HighlightsResult = {
  draftHighlights: [],
  escalatedHighlights: [],
  repeatedHighlights: [],
  totalPendingDrafts: 0,
}

function normalizeText(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ')
}

type CommentRow = {
  id: string
  text: string
  posted_at: string
  post_id: string
  audience_member_id: string | null
  audience_members: unknown
  comment_categories: unknown
}

type CategoryInfo = {
  category: string
  draft_reply: string | null
  draft_reply_approved_at: string | null
  draft_reply_created_at: string | null
  final_reply_text: string | null
  draft_confidence: string | null
  escalation_flag: string | null
}

function getAuthorName(row: CommentRow): string {
  return (row.audience_members as { display_name: string } | null)?.display_name || 'Unknown'
}

function getCategoryInfo(row: CommentRow): CategoryInfo | null {
  return row.comment_categories as CategoryInfo | null
}

/**
 * Assembles this creator's highlights in priority order:
 *   1. purchase_intent with a pending draft reply (highest priority)
 *   2. complaint with a pending draft reply
 *   3. question with a pending draft reply
 *   4. repeated/trending comments (kept separate from the above)
 *
 * "Noticed" (reward_events) is deliberately not a highlight criterion.
 *
 * Errors degrade to an empty result rather than throwing, so a page embedding this
 * as one section among many still renders.
 */
export async function loadHighlights(
  supabase: SupabaseClient,
  creatorId: string,
  limit: number
): Promise<HighlightsResult> {
  const { data: posts, error: postsError } = await supabase
    .from('posts')
    .select('id, title')
    .eq('creator_id', creatorId)

  if (postsError) {
    console.error('Highlights posts fetch error:', JSON.stringify(postsError, Object.getOwnPropertyNames(postsError), 2))
    return EMPTY
  }

  const postList = posts || []
  const postIds = postList.map(p => p.id)
  const postMap = new Map(postList.map(p => [p.id, p.title]))

  if (postIds.length === 0) return EMPTY

  const allComments: CommentRow[] = []
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
        comment_categories ( category, draft_reply, draft_reply_approved_at, draft_reply_created_at, final_reply_text, draft_confidence, escalation_flag )
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

  function sortByDraftRecency(a: CommentRow, b: CommentRow): number {
    const aTime = getCategoryInfo(a)?.draft_reply_created_at || a.posted_at
    const bTime = getCategoryInfo(b)?.draft_reply_created_at || b.posted_at
    return new Date(bTime).getTime() - new Date(aTime).getTime()
  }

  function pendingDraftsFor(category: string): CommentRow[] {
    return allComments
      .filter(c => {
        const cat = getCategoryInfo(c)
        // escalation_flag wins unconditionally: a flagged comment must not surface
        // as a draft even if one was written before the flag existed.
        return (
          cat?.category === category &&
          !cat.escalation_flag &&
          cat.draft_reply &&
          !cat.draft_reply_approved_at
        )
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
    const info = getCategoryInfo(comment)
    return {
      id: comment.id,
      text: comment.text,
      postedAt: comment.posted_at,
      authorName: getAuthorName(comment),
      postId: comment.post_id,
      videoTitle: postMap.get(comment.post_id) || 'Untitled video',
      reason,
      category: info?.category || null,
      draftReply: info?.draft_reply || null,
      finalReplyText: info?.final_reply_text || null,
      draftConfidence: info?.draft_confidence || null,
      escalationFlag: info?.escalation_flag || null,
      repeatCount: repeatCountByCommentId.get(comment.id) || null,
    }
  }

  // Escalated comments come first in the selection: they are the only category the
  // agent explicitly refused to handle, so they must never be crowded out of the
  // capped list by ordinary drafts.
  const escalated = allComments
    .filter(c => getCategoryInfo(c)?.escalation_flag)
    .sort(sortByDraftRecency)

  const draftPriorityOrder = [
    ...pendingDraftsFor('purchase_intent'),
    ...pendingDraftsFor('complaint'),
    ...pendingDraftsFor('question'),
  ]

  // Dedup via selectedIds so a comment matching multiple criteria (e.g. a
  // pending-draft purchase_intent comment that's also repeated) only appears once,
  // under its highest-priority reason.
  const selectedIds = new Set<string>()
  const highlights: Highlight[] = []

  for (const comment of escalated) {
    selectedIds.add(comment.id)
    highlights.push(toHighlight(comment, 'escalated'))
  }

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

  const capped = highlights.slice(0, limit)

  // filter() preserves the priority ordering established above within each group.
  return {
    draftHighlights: capped.filter(h => h.reason === 'pending_draft'),
    escalatedHighlights: capped.filter(h => h.reason === 'escalated'),
    repeatedHighlights: capped.filter(h => h.reason === 'repeated'),
    totalPendingDrafts: draftPriorityOrder.length,
  }
}
