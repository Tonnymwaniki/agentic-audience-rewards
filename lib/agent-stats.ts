import { countsAsRecognition } from '@/lib/rewards/status'

/**
 * Agent Home's header cards, as a pure function of already-loaded rows so the page
 * and its tests run exactly the same arithmetic.
 *
 * Every "last 24h" figure measures what the AGENT did in the window:
 * - Comments read: comments.ingested_at — when the agent first read the comment.
 *   (It used to be the comment's YouTube posted_at, so analyzing an older video
 *   showed 0 however many comments were read. Re-ingesting doesn't rewrite it.)
 * - Replies drafted: a draft that exists AND was written in the window. The
 *   timestamp alone isn't enough: it used to be stamped on every row (migration 39).
 * - People recognized: distinct people with a genuine (non-voided) reward created
 *   in the window.
 * Replies ready is a current snapshot, not windowed: pending drafts on channels
 * whose ownership is verified — the only drafts that can be approved.
 */

export const SUMMARY_WINDOW_HOURS = 24

export type StatsComment = { id: string; post_id: string; ingested_at: string | null }
export type StatsCategory = {
  comment_id: string
  category: string
  draft_reply: string | null
  draft_reply_approved_at: string | null
  draft_reply_created_at: string | null
}
export type StatsRewardEvent = { audience_member_id: string; created_at: string; status: string }

export type AgentHeaderStats = {
  commentsReadCount: number
  draftsWrittenCount: number
  repliesReadyCount: number
  purchaseIntentReadyCount: number
  recognizedTodayCount: number
  totalCommentsCount: number
  totalDraftsCount: number
  totalRecognizedCount: number
}

export function computeAgentHeaderStats(input: {
  comments: StatsComment[]
  categories: StatsCategory[]
  rewardEvents: StatsRewardEvent[]
  actionablePostIds: Set<string>
  now?: number
}): AgentHeaderStats {
  const since = (input.now ?? Date.now()) - SUMMARY_WINDOW_HOURS * 60 * 60 * 1000
  const inWindow = (iso: string | null) => Boolean(iso) && new Date(iso as string).getTime() >= since

  const postIdOfComment = new Map(input.comments.map(c => [c.id, c.post_id]))
  const pending = input.categories.filter(
    c => c.draft_reply && !c.draft_reply_approved_at && input.actionablePostIds.has(postIdOfComment.get(c.comment_id) ?? '')
  )

  const genuine = input.rewardEvents.filter(e => countsAsRecognition(e.status))
  // People, not events: someone recognized on two videos is one person — the same
  // rule the Me and Rewards pages use.
  const people = (events: StatsRewardEvent[]) => new Set(events.map(e => e.audience_member_id)).size

  return {
    commentsReadCount: input.comments.filter(c => inWindow(c.ingested_at)).length,
    draftsWrittenCount: input.categories.filter(c => c.draft_reply && inWindow(c.draft_reply_created_at)).length,
    repliesReadyCount: pending.length,
    purchaseIntentReadyCount: pending.filter(c => c.category === 'purchase_intent').length,
    recognizedTodayCount: people(genuine.filter(e => inWindow(e.created_at))),
    totalCommentsCount: input.comments.length,
    totalDraftsCount: input.categories.filter(c => c.draft_reply).length,
    totalRecognizedCount: people(genuine),
  }
}
