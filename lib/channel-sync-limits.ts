/**
 * Limits for bringing a channel's videos into My Videos. Shared by the Connect
 * page (which shows and enforces them) and the server (which enforces them again,
 * because a request can be sent without the page) — so the two can't disagree.
 *
 * Kept free of any server-only imports so a client component can import it.
 */

/**
 * Most videos one Connect session may bring in. A guard against an accidentally
 * enormous single sync (a slip of a zero), not a limit on the channel: the
 * creator can run Connect again for more.
 */
export const MAX_VIDEOS_PER_SYNC = 500

/** Suggested when the channel has at least this many videos. */
export const DEFAULT_VIDEOS_TO_SYNC = 50

/** A valid request is a whole number from 1 to MAX_VIDEOS_PER_SYNC. */
export function isValidVideoLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_VIDEOS_PER_SYNC
}
