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

export type WeekdayActivity = {
  /** 0 = Sunday, matching Date semantics, even though the list starts on Monday. */
  dayIndex: number
  /** "Mon" */
  short: string
  /** "Monday" */
  day: string
  count: number
  /** Share of all dated comments, 0-100, rounded. */
  percentage: number
}

/** Monday first: a creator planning a week reads it that way, not Sunday-first. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Comment volume for each day of the week, in EAT, Monday through Sunday.
 *
 * Always returns all seven days, including empty ones — a chart that silently
 * omits a quiet Sunday would draw a line straight from Saturday to Monday and
 * imply activity that was never there.
 *
 * Shares the same toEat() conversion as computeActivityWindows, so the curve and
 * the "most active" headline above it can never disagree about which day is which.
 */
export function computeWeeklyActivity(
  comments: Array<{ posted_at: string | null }>
): { totalComments: number; days: WeekdayActivity[] } {
  const counts = new Array(7).fill(0)
  let totalComments = 0

  for (const comment of comments) {
    if (!comment.posted_at) continue
    const date = new Date(comment.posted_at)
    if (isNaN(date.getTime())) continue
    const { dayIndex } = toEat(date)
    counts[dayIndex]++
    totalComments++
  }

  return {
    totalComments,
    days: WEEK_ORDER.map(dayIndex => ({
      dayIndex,
      short: DAY_SHORT[dayIndex],
      day: DAY_NAMES[dayIndex],
      count: counts[dayIndex],
      percentage: totalComments > 0 ? Math.round((counts[dayIndex] / totalComments) * 100) : 0,
    })),
  }
}

export type LatencyBucket = {
  /** Stable key, independent of the label wording. */
  key: string
  /** "0–1h" — the axis label, kept short enough for six side by side. */
  short: string
  /** "within the first hour" — reads inside a sentence. */
  label: string
  /**
   * How to describe everything up to and including this bucket, for the
   * cumulative headline: "within the first 6 hours of posting".
   */
  throughLabel: string
  count: number
  percentage: number
}

/**
 * Upper bound of each bucket in hours; the last is open-ended. A comment lands in
 * the first bucket whose bound it is strictly under, so the edges don't overlap:
 * exactly 1.0h after publication is "1–6h", not "0–1h".
 */
const LATENCY_BUCKETS: Array<{
  key: string
  short: string
  label: string
  throughLabel: string
  maxHours: number
}> = [
  { key: '0-1h', short: '0–1h', label: 'within the first hour', throughLabel: 'within the first hour of posting', maxHours: 1 },
  { key: '1-6h', short: '1–6h', label: '1 to 6 hours after posting', throughLabel: 'within the first 6 hours of posting', maxHours: 6 },
  { key: '6-24h', short: '6–24h', label: '6 to 24 hours after posting', throughLabel: 'within the first day of posting', maxHours: 24 },
  { key: '1-3d', short: '1–3d', label: '1 to 3 days after posting', throughLabel: 'within 3 days of posting', maxHours: 72 },
  { key: '3-7d', short: '3–7d', label: '3 to 7 days after posting', throughLabel: 'within a week of posting', maxHours: 168 },
  { key: '7d+', short: '7d+', label: 'more than a week after posting', throughLabel: 'but only after more than a week', maxHours: Infinity },
]

/**
 * How long after a video went live each comment arrived.
 *
 * Unlike the day and hour views, this one is timezone-free on purpose: it measures
 * an ELAPSED INTERVAL between two instants, and a duration is the same number of
 * hours whichever zone you read the clocks in. Converting to EAT first would be
 * wrong twice over — it would cancel out, and it would imply the answer depends on
 * where the viewer is.
 *
 * Requires posts.posted_at, the real YouTube upload time. Comments on a post with
 * no publish timestamp are skipped and excluded from the denominator rather than
 * being charged to an assumed publish date — `totalComments` reports how many were
 * actually measurable, so the caller can say so instead of implying full coverage.
 *
 * Negative intervals (a comment timestamped before its video, which YouTube
 * occasionally produces for premieres and reused ids) are clamped into the first
 * bucket rather than dropped: the comment genuinely arrived at the very start.
 */
export function computeLatencyActivity(
  comments: Array<{ posted_at: string | null; post_id: string }>,
  postPublishedAt: Map<string, string | null>
): { totalComments: number; skippedNoPublishDate: number; buckets: LatencyBucket[] } {
  const counts = new Array(LATENCY_BUCKETS.length).fill(0)
  let totalComments = 0
  let skippedNoPublishDate = 0

  for (const comment of comments) {
    if (!comment.posted_at) continue
    const commentAt = new Date(comment.posted_at)
    if (isNaN(commentAt.getTime())) continue

    const publishedRaw = postPublishedAt.get(comment.post_id)
    if (!publishedRaw) {
      skippedNoPublishDate++
      continue
    }
    const publishedAt = new Date(publishedRaw)
    if (isNaN(publishedAt.getTime())) {
      skippedNoPublishDate++
      continue
    }

    const elapsedHours = (commentAt.getTime() - publishedAt.getTime()) / MS_PER_HOUR
    const index = LATENCY_BUCKETS.findIndex(b => elapsedHours < b.maxHours)
    counts[index === -1 ? LATENCY_BUCKETS.length - 1 : index]++
    totalComments++
  }

  return {
    totalComments,
    skippedNoPublishDate,
    buckets: LATENCY_BUCKETS.map((bucket, i) => ({
      key: bucket.key,
      short: bucket.short,
      label: bucket.label,
      throughLabel: bucket.throughLabel,
      count: counts[i],
      percentage: totalComments > 0 ? Math.round((counts[i] / totalComments) * 100) : 0,
    })),
  }
}

/**
 * The headline claim for the "since posted" view: the shortest run of buckets
 * from the start that together hold at least half the comments.
 *
 * Reporting only the single biggest bucket understates how front-loaded the
 * response usually is — "31% arrive in 1–6h" hides that 78% arrived inside a day.
 * Accumulating from the fastest bucket says the useful thing: how long the window
 * actually is.
 */
export function summarizeLatency(buckets: LatencyBucket[]): {
  throughIndex: number
  percentage: number
} | null {
  const total = buckets.reduce((sum, b) => sum + b.count, 0)
  if (total === 0) return null

  let running = 0
  for (let i = 0; i < buckets.length; i++) {
    running += buckets[i].count
    if (running / total >= 0.5) {
      return { throughIndex: i, percentage: Math.round((running / total) * 100) }
    }
  }

  return { throughIndex: buckets.length - 1, percentage: 100 }
}

export type HourActivity = {
  /** 0-23, in EAT. */
  hour: number
  /** "2 PM" */
  label: string
  count: number
  percentage: number
}

/**
 * Comment volume for each hour of the day, in EAT, midnight through 11pm.
 *
 * All 24 hours are always returned, including the dead ones overnight — the shape
 * of a day is largely the gap where nobody is awake, and omitting empty hours would
 * draw a curve straight across it.
 *
 * Same toEat() conversion as the weekday and window functions, so every view of
 * this data agrees about which hour a comment belongs to.
 */
export function computeHourlyActivity(
  comments: Array<{ posted_at: string | null }>
): { totalComments: number; hours: HourActivity[] } {
  const counts = new Array(24).fill(0)
  let totalComments = 0

  for (const comment of comments) {
    if (!comment.posted_at) continue
    const date = new Date(comment.posted_at)
    if (isNaN(date.getTime())) continue
    const { hour } = toEat(date)
    counts[hour]++
    totalComments++
  }

  return {
    totalComments,
    hours: counts.map((count, hour) => ({
      hour,
      label: formatHour(hour),
      count,
      percentage: totalComments > 0 ? Math.round((count / totalComments) * 100) : 0,
    })),
  }
}
