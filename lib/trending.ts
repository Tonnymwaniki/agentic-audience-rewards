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
  /** Comments carrying both positive and negative feeling. Only real, classified
   * sentiment produces this; the category-derived fallback never does. */
  mixed: number
  /** Comments the percentages were computed from — 0 means "nothing to show". */
  total: number
}

const POSITIVE_CATEGORIES = new Set(['praise'])
const NEGATIVE_CATEGORIES = new Set(['complaint'])

export type Sentiment = 'positive' | 'negative' | 'neutral' | 'mixed'
export const SENTIMENTS: readonly Sentiment[] = ['positive', 'negative', 'neutral', 'mixed']

/** One comment's categorization, as far as sentiment is concerned. */
export type SentimentRow = { category: string | null; sentiment?: string | null }

/**
 * The sentiment of one comment: the classifier's own judgment when it has one
 * (stored since migration 20240101000026), otherwise the old category-derived
 * approximation. null when there is nothing to go on.
 *
 * The search SQL functions apply exactly this precedence, so a filter and a
 * breakdown can never disagree.
 */
export function sentimentForRow(row: SentimentRow): Sentiment | null {
  const stored = typeof row.sentiment === 'string' ? row.sentiment.trim().toLowerCase() : ''
  if ((SENTIMENTS as readonly string[]).includes(stored)) return stored as Sentiment
  return sentimentForCategory(row.category)
}

/**
 * The derived sentiment of one comment's category, or null when it has no category
 * yet (computeSentiment skips those). The comment search SQL functions
 * (search_comments_* in migration 20240101000023) apply this same mapping.
 */
export function sentimentForCategory(category: string | null | undefined): Exclude<Sentiment, 'mixed'> | null {
  if (!category) return null
  if (POSITIVE_CATEGORIES.has(category)) return 'positive'
  if (NEGATIVE_CATEGORIES.has(category)) return 'negative'
  return 'neutral'
}

/**
 * The sentiment mix of a set of comments, as percentages.
 *
 * Each comment contributes its REAL classified sentiment where one is stored, and
 * the older category-derived approximation (praise = positive, complaint = negative,
 * everything else neutral) only where it isn't — so a channel part-way through
 * re-categorization gets the best value available for every comment. "mixed" can
 * only come from a real classification.
 *
 * Percentages are rounded so they always sum to exactly 100: every bucket but the
 * largest rounds normally and the largest absorbs the remainder, because
 * independently-rounded values routinely add up to 99 or 101 and a pie chart that
 * doesn't close looks broken.
 */
export function computeSentiment(categories: SentimentRow[]): SentimentBreakdown {
  let positive = 0
  let negative = 0
  let neutral = 0
  let mixed = 0

  for (const row of categories) {
    const sentiment = sentimentForRow(row)
    if (sentiment === 'positive') positive++
    else if (sentiment === 'negative') negative++
    else if (sentiment === 'neutral') neutral++
    else if (sentiment === 'mixed') mixed++
  }

  const total = positive + negative + neutral + mixed
  if (total === 0) return { positive: 0, negative: 0, neutral: 0, mixed: 0, total: 0 }

  // The LARGEST bucket absorbs the remainder, as described above. Always giving it
  // to "positive" could go negative: 1 complaint + 7 neutral rounds to 13% + 88%,
  // which left positive at -1%.
  const counts = { positive, negative, neutral, mixed }
  const order = (Object.keys(counts) as Array<keyof typeof counts>).sort((a, b) => counts[b] - counts[a])
  const pct = { positive: 0, negative: 0, neutral: 0, mixed: 0 }
  // Every bucket but the largest rounds normally; the largest takes what's left.
  for (const key of order.slice(1)) pct[key] = Math.round((counts[key] / total) * 100)
  pct[order[0]] = 100 - order.slice(1).reduce((sum, key) => sum + pct[key], 0)

  return { ...pct, total }
}
