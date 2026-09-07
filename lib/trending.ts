// Shared repeated-comment grouping — the same normalize-and-group approach the
// Repeated Comments page uses. Lives here so the Research chat's get_trending tool
// and the Research sidebar's "Trending Topics" card can't drift apart.

export type TrendingComment = {
  text: string
  post_id: string
  audience_member_id: string | null
}

export type TrendingGroup = {
  text: string
  count: number
  unique_people: number
  video_titles: string[]
}

export function normalizeText(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ')
}

export function computeTrendingGroups(
  comments: TrendingComment[],
  postMap: Map<string, string>,
  minCount: number
): TrendingGroup[] {
  const normalizedGroups = new Map<string, TrendingComment[]>()

  for (const comment of comments) {
    const key = normalizeText(comment.text)
    const existing = normalizedGroups.get(key) || []
    existing.push(comment)
    normalizedGroups.set(key, existing)
  }

  const groups: TrendingGroup[] = []

  for (const entries of normalizedGroups.values()) {
    const uniqueMembers = new Set(entries.map(e => e.audience_member_id).filter(Boolean))
    // "Trending" means multiple different people said it — not one person repeating.
    if (uniqueMembers.size < 2 || entries.length < minCount) continue

    groups.push({
      text: entries[0].text,
      count: entries.length,
      unique_people: uniqueMembers.size,
      video_titles: Array.from(new Set(entries.map(e => postMap.get(e.post_id) || 'Untitled video'))),
    })
  }

  groups.sort((a, b) => b.count - a.count)
  return groups
}

// --- Sentiment -------------------------------------------------------------

export type SentimentBreakdown = {
  positive: number
  negative: number
  neutral: number
  /** Comments the percentages were computed from — 0 means "nothing to show". */
  total: number
}

const POSITIVE_CATEGORIES = new Set(['praise'])
const NEGATIVE_CATEGORIES = new Set(['complaint'])

/**
 * Sentiment derived from the intent categories already stored on every comment.
 *
 * There is no sentiment column in the schema and no second classifier pass here —
 * this is a mapping, not a measurement, and everything that isn't clearly praise or
 * a complaint counts as neutral (questions, purchase intent, spam, other).
 *
 * Percentages are rounded so they always sum to exactly 100: the two smaller
 * buckets round normally and the largest absorbs the remainder, because three
 * independently-rounded values routinely add up to 99 or 101 and a pie chart that
 * doesn't close looks broken.
 */
export function computeSentiment(categories: Array<{ category: string | null }>): SentimentBreakdown {
  let positive = 0
  let negative = 0
  let neutral = 0

  for (const row of categories) {
    if (!row.category) continue
    if (POSITIVE_CATEGORIES.has(row.category)) positive++
    else if (NEGATIVE_CATEGORIES.has(row.category)) negative++
    else neutral++
  }

  const total = positive + negative + neutral
  if (total === 0) return { positive: 0, negative: 0, neutral: 0, total: 0 }

  const negativePct = Math.round((negative / total) * 100)
  const neutralPct = Math.round((neutral / total) * 100)
  const positivePct = 100 - negativePct - neutralPct

  return { positive: positivePct, negative: negativePct, neutral: neutralPct, total }
}
