import type { SupabaseClient } from '@supabase/supabase-js'
import { logError } from '@/lib/logger'
import { VOIDED_UNVERIFIED_STATUS } from '@/lib/rewards/status'

/**
 * A person's level, combining how often the creator has recognized them with how
 * much they actually engage. Computed from stored data by fixed rules — no model
 * call — so a creator can be told exactly why someone is a Super Fan, and the
 * answer doesn't drift between runs on the same data.
 *
 * Deliberately separate from `segment` (lib/segments.ts). A segment says what KIND
 * of person this is (potential customer, critic, content requester); a level says
 * how INVESTED they are. Someone can be a potential_customer at level 'new' or a
 * potential_customer at level 'super_fan', and both facts are useful.
 */
export type AudienceLevel = 'new' | 'regular' | 'rising_fan' | 'super_fan'

/** Highest tier first: computeLevel returns the first rule that matches. */
export const LEVELS: readonly AudienceLevel[] = ['super_fan', 'rising_fan', 'regular', 'new']

/** Ordered low to high, for any UI that needs to rank or sort by tier. */
export const LEVEL_ORDER: Record<AudienceLevel, number> = {
  new: 0,
  regular: 1,
  rising_fan: 2,
  super_fan: 3,
}

export const LEVEL_LABELS: Record<AudienceLevel, string> = {
  new: 'New',
  regular: 'Regular',
  rising_fan: 'Rising Fan',
  super_fan: 'Super Fan',
}

/** One line each — shown to the creator, and usable in tool descriptions later. */
export const LEVEL_RULES: Record<AudienceLevel, string> = {
  super_fan: 'recognized 2+ times, or 10+ comments across 3+ videos',
  rising_fan: 'recognized once, or 5+ comments across 2+ videos',
  regular: '2+ comments and never recognized',
  new: 'a single comment and never recognized',
}

export type LevelSignals = {
  totalComments: number
  distinctPosts: number
  /**
   * GENUINE reward_events for this person — voided rows (issued before ownership
   * verification) are not recognition and never raise a level. They belong to one
   * creator, so this is already creator-scoped.
   */
  recognitionCount: number
}

/**
 * The level for one person's aggregates.
 *
 * Checked highest tier first, so when several rules qualify the strongest wins —
 * someone recognized 4 times with 30 comments is a super_fan, not a regular.
 *
 * The recognition threshold for super_fan is 2, not 3. Measured against the live
 * database on 2026-09-20: across 331 recognized people the maximum recognition
 * count was 2, so a threshold of 3 left the tier permanently empty and the badge
 * was decoration rather than information. Raise it again once creators recognize
 * people often enough for 3+ to be common.
 *
 * Note the two independent routes into each fan tier: recognition OR sustained
 * engagement. A creator who rarely uses rewards still gets their most engaged
 * people surfaced, and a creator who recognizes generously still sees who they
 * have singled out.
 *
 * Pure, so it can be tested against hand-built cases without a database.
 */
export function computeLevel(signals: LevelSignals): AudienceLevel {
  const { totalComments, distinctPosts, recognitionCount } = signals

  if (recognitionCount >= 2 || (totalComments >= 10 && distinctPosts >= 3)) return 'super_fan'
  if (recognitionCount >= 1 || (totalComments >= 5 && distinctPosts >= 2)) return 'rising_fan'
  if (totalComments >= 2) return 'regular'
  // Everyone else, including the zero-comment case that only arises for a member
  // row created before their first comment landed.
  return 'new'
}

type CommentRow = { post_id: string }

/** Aggregates for one person, from their stored comments plus their recognition count. */
export function signalsFromHistory(comments: CommentRow[], recognitionCount: number): LevelSignals {
  const posts = new Set<string>()
  for (const c of comments) posts.add(c.post_id)

  return {
    totalComments: comments.length,
    distinctPosts: posts.size,
    recognitionCount,
  }
}

/** False once the database reports the column missing (migration 20240101000031). */
let levelColumnAvailable = true

/**
 * Recomputes and stores one person's level. Returns null when the column doesn't
 * exist yet or the read fails.
 *
 * Two cheap reads and one write, no model call — same shape as
 * updateAudienceSegment — so it runs inside the audience-memory refresh without
 * slowing it down.
 *
 * Unlike the segment, this does NOT bail out when the person has no comments: a
 * member can be recognized on the strength of a single comment that was later
 * removed, and 'new' is still the right answer for them.
 */
export async function updateAudienceLevel(
  supabase: SupabaseClient,
  audienceMemberId: string
): Promise<{ level: AudienceLevel; signals: LevelSignals } | null> {
  if (!levelColumnAvailable) return null

  const { data: commentRows, error } = await supabase
    .from('comments')
    .select('post_id')
    .eq('audience_member_id', audienceMemberId)
  if (error) {
    logError('levels.updateAudienceLevel', error, { audience_member_id: audienceMemberId, stage: 'fetch_comments' })
    return null
  }

  // head:true — only the number matters, so no rows cross the wire.
  const { count, error: rewardError } = await supabase
    .from('reward_events')
    .select('id', { count: 'exact', head: true })
    .eq('audience_member_id', audienceMemberId)
    .neq('status', VOIDED_UNVERIFIED_STATUS)
  if (rewardError) {
    logError('levels.updateAudienceLevel', rewardError, { audience_member_id: audienceMemberId, stage: 'count_reward_events' })
    return null
  }

  const signals = signalsFromHistory((commentRows ?? []) as CommentRow[], count ?? 0)
  const level = computeLevel(signals)

  const { error: updateError } = await supabase
    .from('audience_members')
    .update({ level })
    .eq('id', audienceMemberId)
  if (updateError) {
    if (updateError.code === 'PGRST204' || updateError.code === '42703') {
      levelColumnAvailable = false
      console.warn('audience_members.level does not exist yet (migration 20240101000031); skipping levels')
      return null
    }
    logError('levels.updateAudienceLevel', updateError, { audience_member_id: audienceMemberId, stage: 'write_level' })
    return null
  }

  return { level, signals }
}

/** Accepts anything stored and narrows it, so a stray value renders as unset rather than crashing. */
export function normalizeLevel(raw: unknown): AudienceLevel | null {
  return typeof raw === 'string' && (LEVELS as readonly string[]).includes(raw)
    ? (raw as AudienceLevel)
    : null
}
