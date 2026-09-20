/**
 * When this audience is active, by day of week and hour.
 *
 * One shared implementation. Agent Home's "Best Time to Post" widget and the
 * Research chat's get_timing_insights tool both call this, so the two can never
 * disagree — they previously carried character-for-character copies of the same
 * bucketing, which meant a fix to one silently left the other wrong.
 *
 * Results are in East African Time. Comments are stored as UTC (posted_at comes
 * from the YouTube API's snippet.publishedAt, RFC-3339, into a timestamptz
 * column), and this project's audience is Kenyan, so a fixed +3 is the whole
 * conversion — EAT has never observed daylight saving.
 */

/** East Africa Time. Fixed year-round; EAT has no DST. */
export const EAT_OFFSET_HOURS = 3
export const EAT_LABEL = 'EAT'

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MS_PER_HOUR = 60 * 60 * 1000

export type ActivityWindow = {
  /** 0 = Sunday, in EAT — not the UTC day. */
  dayIndex: number
  /** e.g. "Tuesday" */
  day: string
  /** 0-23, in EAT. */
  hour: number
  /** e.g. "2 PM" — the hour a creator can actually read. */
  hourLabel: string
  count: number
  /** Share of all dated comments, 0-100, rounded. */
  percentage: number
}

export type ActivityResult = {
  /** Comments that had a usable timestamp — the denominator for percentage. */
  totalComments: number
  windows: ActivityWindow[]
}

/** 13 -> "1 PM", 0 -> "12 AM". */
export function formatHour(hour: number): string {
  const period = hour < 12 ? 'AM' : 'PM'
  const display = hour % 12 === 0 ? 12 : hour % 12
  return `${display} ${period}`
}

/**
 * Converts a UTC instant to the EAT wall-clock day and hour.
 *
 * The shift is applied to the INSTANT first, then the day and hour are read off
 * the result. Adding 3 to the UTC hour alone — which both previous copies of this
 * logic did — silently keeps the UTC day, so every comment posted between 21:00
 * and 23:59 UTC was filed under the wrong weekday. A real example from this
 * database: 2026-09-14T23:46:02Z is Monday in UTC but Tuesday 02:46 in EAT.
 *
 * getUTC* on the shifted value, deliberately: getDay()/getHours() would apply
 * whatever timezone the server happens to run in (UTC on Vercel, something else
 * locally), which is exactly the ambiguity this function exists to remove.
 */
export function toEat(date: Date): { dayIndex: number; hour: number } {
  const shifted = new Date(date.getTime() + EAT_OFFSET_HOURS * MS_PER_HOUR)
  return { dayIndex: shifted.getUTCDay(), hour: shifted.getUTCHours() }
}

/**
 * Buckets comments by EAT day-of-week and hour, returning the busiest windows.
 *
 * Comments with an unparseable timestamp are skipped and excluded from the
 * denominator, so percentages always sum against what was actually measured.
 */
export function computeActivityWindows(
  comments: Array<{ posted_at: string | null }>,
  limit = 3
): ActivityResult {
  const buckets = new Map<string, number>()
  let totalComments = 0

  for (const comment of comments) {
    if (!comment.posted_at) continue
    const date = new Date(comment.posted_at)
    if (isNaN(date.getTime())) continue

    const { dayIndex, hour } = toEat(date)
    totalComments++
    const key = `${dayIndex}-${hour}`
    buckets.set(key, (buckets.get(key) || 0) + 1)
  }

  const windows = Array.from(buckets.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]): ActivityWindow => {
      const [dayIndex, hour] = key.split('-').map(Number)
      return {
        dayIndex,
        day: DAY_NAMES[dayIndex],
        hour,
        hourLabel: formatHour(hour),
        count,
        percentage: totalComments > 0 ? Math.round((count / totalComments) * 100) : 0,
      }
    })

  return { totalComments, windows }
}
