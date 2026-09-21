import type { SupabaseClient } from '@supabase/supabase-js'
import { sentimentForRow } from '@/lib/trending'
import { logError } from '@/lib/logger'

/**
 * A person's segment, computed from their own comment history by fixed rules — not
 * asked of a model per person. The rules are deliberately simple so a creator can be
 * told exactly why someone is in a segment, and so the answer doesn't drift between
 * runs on the same data.
 */
export type AudienceSegment = 'potential_customer' | 'critic' | 'loyal_fan' | 'content_requester' | 'casual_viewer'

/** In priority order: the first rule a person matches wins. */
export const SEGMENTS: readonly AudienceSegment[] = [
  'potential_customer',
  'critic',
  'loyal_fan',
  'content_requester',
  'casual_viewer',
]

/** One line each, used in the search tool's description so the model uses these names. */
export const SEGMENT_RULES: Record<AudienceSegment, string> = {
  potential_customer: 'has at least one comment showing buying interest (purchase_intent)',
  critic: 'has 2+ NEGATIVE comments and at least half of their comments are negative',
  loyal_fan: '3+ comments across 2+ videos, at least 70% positive',
  content_requester: 'has 2+ comments asking for content (content_request)',
  casual_viewer: 'everyone else',
}

export type SegmentSignals = {
  totalComments: number
  distinctPosts: number
  purchaseIntentCount: number
  contentRequestCount: number
  positiveCount: number
  negativeCount: number
  /** Comments that have a sentiment at all — the denominator for the shares below. */
  sentimentTotal: number
}

/**
 * The segment for one person's aggregates.
 *
 * Priority — potential_customer > critic > loyal_fan > content_requester >
 * casual_viewer — because a buying signal or a sustained complaint is more
 * decision-relevant to a creator than general fandom: someone who both praises the
 * channel and asks to buy should surface as a customer, not a fan.
 *
 * Pure, so it can be tested against hand-picked cases without a database.
 */
export function computeSegment(signals: SegmentSignals): AudienceSegment {
  const { totalComments, distinctPosts, purchaseIntentCount, contentRequestCount, positiveCount, negativeCount, sentimentTotal } = signals
  const share = (n: number) => (sentimentTotal > 0 ? n / sentimentTotal : 0)

  if (purchaseIntentCount >= 1) return 'potential_customer'
  // Two conditions, not one: the share alone labelled someone a critic for a single
  // complaint sitting beside a single compliment (1 of 2 = 50%). A critic has to have
  // complained more than once AND be mostly negative overall.
  if (negativeCount >= 2 && share(negativeCount) >= 0.5) return 'critic'
  if (totalComments >= 3 && distinctPosts >= 2 && share(positiveCount) >= 0.7) return 'loyal_fan'
  if (contentRequestCount >= 2) return 'content_requester'
  return 'casual_viewer'
}

type CommentRow = {
  post_id: string
  comment_categories: { category: string | null; sentiment?: string | null } | null
}

/** Aggregates for one person, from the comments already stored for them. */
export function signalsFromComments(comments: CommentRow[]): SegmentSignals {
  let purchaseIntentCount = 0
  let contentRequestCount = 0
  let positiveCount = 0
  let negativeCount = 0
  let sentimentTotal = 0
  const posts = new Set<string>()

  for (const c of comments) {
    posts.add(c.post_id)
    const category = c.comment_categories?.category ?? null
    if (category === 'purchase_intent') purchaseIntentCount++
    if (category === 'content_request') contentRequestCount++
    // The classifier's own sentiment where stored, the category-derived value
    // otherwise — the same precedence every other reader uses.
    const sentiment = sentimentForRow({ category, sentiment: c.comment_categories?.sentiment })
    if (sentiment) {
      sentimentTotal++
      if (sentiment === 'positive') positiveCount++
      if (sentiment === 'negative') negativeCount++
    }
  }

  return {
    totalComments: comments.length,
    distinctPosts: posts.size,
    purchaseIntentCount,
    contentRequestCount,
    positiveCount,
    negativeCount,
    sentimentTotal,
  }
}

/** False once the database reports the column missing (migration 20240101000028). */
let segmentColumnAvailable = true

/**
 * Recomputes and stores one person's segment. Returns null when there is nothing to
 * compute from, or when the column doesn't exist yet.
 *
 * Cheap and deterministic — two reads and one write, no model call — so it can run
 * inside the audience-memory refresh without slowing it down.
 */
export async function updateAudienceSegment(
  supabase: SupabaseClient,
  audienceMemberId: string
): Promise<{ segment: AudienceSegment; signals: SegmentSignals } | null> {
  if (!segmentColumnAvailable) return null

  const { data, error } = await supabase
    .from('comments')
    .select('post_id, comment_categories ( category, sentiment )')
    .eq('audience_member_id', audienceMemberId)
  if (error) {
    logError('segments.update', error, { audience_member_id: audienceMemberId, stage: 'fetch_comments' })
    return null
  }
  const comments = (data ?? []) as unknown as CommentRow[]
  if (comments.length === 0) return null

  const signals = signalsFromComments(comments)
  const segment = computeSegment(signals)

  const { error: updateError } = await supabase.from('audience_members').update({ segment }).eq('id', audienceMemberId)
  if (updateError) {
    if (updateError.code === 'PGRST204' || updateError.code === '42703') {
      segmentColumnAvailable = false
      console.warn('audience_members.segment does not exist yet (migration 20240101000028); skipping segmentation')
      return null
    }
    logError('segments.update', updateError, { audience_member_id: audienceMemberId, stage: 'write_segment' })
    return null
  }
  return { segment, signals }
}
