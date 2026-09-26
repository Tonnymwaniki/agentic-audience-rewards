import type { SupabaseClient } from '@supabase/supabase-js'
import { computeSentiment, type SentimentBreakdown } from '@/lib/trending'
import { fetchInBatches } from '@/lib/supabase-helpers'

/** Themes stored per creator per run. */
export const TOP_THEMES = 10
/** A theme needs at least this many comments to be summarised at all. */
export const MIN_THEME_COMMENTS = 5
/** Trend compares the last TREND_WINDOW_DAYS against the TREND_WINDOW_DAYS before. */
export const TREND_WINDOW_DAYS = 30
/**
 * Below this many comments in either window, or this many for the theme across
 * both, a percentage change is noise and the trend is reported as insufficient.
 */
const MIN_PERIOD_COMMENTS = 20
const MIN_THEME_TREND_COMMENTS = 5
/** Share changes smaller than this (relative %) count as stable. */
const STABLE_BAND_PCT = 15
/** Confidence = n / (n + K): 5 comments -> 0.33, 10 -> 0.5, 40 -> 0.8. */
const CONFIDENCE_K = 10
const REPRESENTATIVE_COUNT = 3
const RELATED_POST_COUNT = 3
/** Shortest comment (after cleanup) that can stand for a theme. "nice" can't. */
const MIN_REPRESENTATIVE_CHARS = 15

/**
 * Head words that group unrelated things. Measured on this project's topics:
 * "content" gathered relatable_content, off_topic_content and
 * podcast_finance_content; "reference", "observation" and "reaction" were
 * similar grab-bags. A theme built on one of these would be a count with no
 * meaning, so those comments are left out rather than mislabelled.
 */
const NON_THEMATIC_HEADS = new Set([
  'content', 'reference', 'observation', 'reaction', 'comment', 'commentary',
  'general', 'other', 'unclear', 'unknown', 'misc', 'statement', 'response',
])

export type TrendDirection = 'rising' | 'falling' | 'stable' | 'new' | 'insufficient_data'

export type AudienceInsight = {
  creator_id: string
  topic: string
  comment_count: number
  sentiment_breakdown: SentimentBreakdown
  trend_direction: TrendDirection
  trend_pct: number | null
  representative_comment_ids: string[]
  related_post_ids: string[]
  confidence: number
  computed_at: string
}

/**
 * The theme a raw comment_categories.topic belongs to: its head word, the last
 * word of the label. Raw topics are too fragmented to summarise — one creator has
 * 464 distinct values across 684 comments — while head words group
 * content_quality, video_quality and show_quality into "quality", more than
 * doubling how much of the audience the top ten themes cover (15.5% -> 38.7%).
 *
 * Known limit: it groups by wording, not intent, so "request" joins
 * contact_request (a lead) with content_request (a video idea).
 */
export function themeForTopic(topic: string | null | undefined): string | null {
  if (!topic) return null
  const words = topic.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const head = words.at(-1)
  if (!head || head.length < 3 || NON_THEMATIC_HEADS.has(head)) return null
  return head
}

/**
 * Every distinct theme a comment belongs to. Multi-topic comments (migration
 * 20240101000027) map to one theme per topic; older rows fall back to their single
 * `topic`. Deduplicated, because two topics can share a head word ("video_quality"
 * and "content_quality" are both "quality").
 */
export function themesForRow(row: { topic: string | null; topics?: string[] | null }): string[] {
  const source = row.topics && row.topics.length > 0 ? row.topics : [row.topic]
  const themes = new Set<string>()
  for (const topic of source) {
    const theme = themeForTopic(topic)
    if (theme) themes.add(theme)
  }
  return [...themes]
}

export function confidenceForSampleSize(n: number): number {
  return Math.round((n / (n + CONFIDENCE_K)) * 100) / 100
}

/**
 * Trend in a theme's SHARE of all comments, not its raw count. Raw counts mostly
 * track how many videos went up that month; share says whether the audience is
 * talking about this more or less.
 */
export function computeTrend(
  themeRecent: number,
  themePrevious: number,
  totalRecent: number,
  totalPrevious: number
): { direction: TrendDirection; pct: number | null } {
  if (
    totalRecent < MIN_PERIOD_COMMENTS ||
    totalPrevious < MIN_PERIOD_COMMENTS ||
    themeRecent + themePrevious < MIN_THEME_TREND_COMMENTS
  ) {
    return { direction: 'insufficient_data', pct: null }
  }
  const shareRecent = themeRecent / totalRecent
  const sharePrevious = themePrevious / totalPrevious
  if (sharePrevious === 0) return { direction: 'new', pct: null }

  const pct = Math.round(((shareRecent - sharePrevious) / sharePrevious) * 1000) / 10
  if (Math.abs(pct) < STABLE_BAND_PCT) return { direction: 'stable', pct }
  return { direction: pct > 0 ? 'rising' : 'falling', pct }
}

function cleanText(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

type CommentRow = {
  id: string
  post_id: string
  text: string
  posted_at: string | null
  audience_member_id: string | null
  category: string | null
  /** The classifier's own sentiment, when it has been stored; else null. */
  sentiment?: string | null
  /** Every topic the comment covers; falls back to [topic] for older rows. */
  topics?: string[] | null
  topic: string | null
}

// False once the database reports comment_categories.sentiment missing (migration
// 20240101000026 not run); the breakdown then falls back to category-derived
// sentiment for every comment, exactly as before.
let sentimentColumnAvailable = true
// Same for comment_categories.topics (migration 20240101000027): until it exists,
// themes come from the single `topic` column exactly as before.
let topicsColumnAvailable = true

async function loadCreatorComments(supabase: SupabaseClient, creatorId: string): Promise<CommentRow[]> {
  const { data: posts, error: postsError } = await supabase.from('posts').select('id').eq('creator_id', creatorId)
  if (postsError) throw new Error(`Could not load posts: ${postsError.message}`)
  const postIds = (posts ?? []).map(p => p.id as string)
  if (postIds.length === 0) return []

  const rows: CommentRow[] = []
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('comments')
      .select(
        `id, post_id, text, posted_at, audience_member_id, comment_categories ( category, topic${topicsColumnAvailable ? ', topics' : ''}${sentimentColumnAvailable ? ', sentiment' : ''} )`
      )
      .in('post_id', postIds)
      .order('id')
      .range(from, from + pageSize - 1)
    if (error && sentimentColumnAvailable && /sentiment/.test(error.message ?? '')) {
      sentimentColumnAvailable = false
      console.warn('comment_categories.sentiment does not exist yet (migration 20240101000026); using category-derived sentiment')
      from -= pageSize // retry this page without the column
      continue
    }
    if (error && topicsColumnAvailable && /topics/.test(error.message ?? '')) {
      topicsColumnAvailable = false
      console.warn('comment_categories.topics does not exist yet (migration 20240101000027); grouping themes by the single topic')
      from -= pageSize
      continue
    }
    if (error) throw new Error(`Could not load comments: ${error.message}`)
    if (!data || data.length === 0) break
    for (const r of data) {
      const cat = r.comment_categories as unknown as { category: string | null; topic: string | null } | null
      rows.push({
        id: r.id as string,
        post_id: r.post_id as string,
        text: (r.text as string) ?? '',
        posted_at: (r.posted_at as string | null) ?? null,
        audience_member_id: (r.audience_member_id as string | null) ?? null,
        category: cat?.category ?? null,
        sentiment: (cat as { sentiment?: string | null } | null)?.sentiment ?? null,
        topics: (cat as { topics?: string[] | null } | null)?.topics ?? null,
        topic: cat?.topic ?? null,
      })
    }
    if (data.length < pageSize) break
  }
  return rows
}

/**
 * Picks comments that stand for the theme: closest to the average meaning of all
 * its comments (the embedding centroid), from different people, and long enough
 * to say something. Falls back to the longest comments when no embeddings exist.
 */
function pickRepresentatives(members: CommentRow[], embeddings: Map<string, number[]>): string[] {
  const usable = members.filter(m => cleanText(m.text).length >= MIN_REPRESENTATIVE_CHARS)
  const pool = usable.length > 0 ? usable : members

  const withVectors = pool.filter(m => embeddings.has(m.id))
  let ordered: CommentRow[]
  if (withVectors.length > 0) {
    const dim = embeddings.get(withVectors[0].id)!.length
    const centroid = new Array<number>(dim).fill(0)
    for (const m of withVectors) {
      const v = embeddings.get(m.id)!
      for (let i = 0; i < dim; i++) centroid[i] += v[i]
    }
    const norm = Math.sqrt(centroid.reduce((s, x) => s + x * x, 0)) || 1
    const score = (m: CommentRow) => {
      const v = embeddings.get(m.id)!
      let dot = 0
      for (let i = 0; i < dim; i++) dot += v[i] * centroid[i]
      return dot / norm
    }
    ordered = [...withVectors].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))
  } else {
    ordered = [...pool].sort((a, b) => cleanText(b.text).length - cleanText(a.text).length || a.id.localeCompare(b.id))
  }

  const picked: string[] = []
  const authors = new Set<string>()
  for (const m of ordered) {
    const author = m.audience_member_id ?? `anon:${m.id}`
    if (authors.has(author)) continue
    authors.add(author)
    picked.push(m.id)
    if (picked.length === REPRESENTATIVE_COUNT) break
  }
  return picked
}

/**
 * What a theme's trend was computed from — the two windows' counts and the recent
 * comments themselves. Not stored; the Insight Agent (lib/insight-agent.ts) uses it
 * to judge whether a swing rests on enough comments to mean anything, and to show
 * Claude what is actually being said.
 */
export type TrendWindow = {
  recent: number
  previous: number
  totalRecent: number
  totalPrevious: number
  windowDays: number
  recentSentiment: SentimentBreakdown
  previousSentiment: SentimentBreakdown
  /** Recent-window comments on this theme per video, most first. */
  recentByPost: Array<{ post_id: string; comments: number }>
  /** Up to 8 recent comments on this theme, cleaned, longest first. */
  recentSamples: Array<{ id: string; post_id: string; text: string }>
}

/**
 * Computes one creator's insights without writing anything. Deterministic for a
 * given `now` and data, so it can be inspected or tested before being stored.
 */
export async function computeAudienceInsights(
  supabase: SupabaseClient,
  creatorId: string,
  now: Date = new Date()
): Promise<AudienceInsight[]> {
  return (await computeAudienceInsightsDetailed(supabase, creatorId, now)).insights
}

/** computeAudienceInsights plus each stored theme's trend window (keyed by topic). */
export async function computeAudienceInsightsDetailed(
  supabase: SupabaseClient,
  creatorId: string,
  now: Date = new Date()
): Promise<{ insights: AudienceInsight[]; windows: Map<string, TrendWindow> }> {
  const comments = await loadCreatorComments(supabase, creatorId)
  const computedAt = now.toISOString()

  const byTheme = new Map<string, CommentRow[]>()
  for (const c of comments) {
    // A comment tagged "price" and "delivery" counts toward BOTH themes, so a
    // theme's comment_count is a MENTION count: the theme counts can add up to more
    // than the number of comments. Every total used as a denominator below
    // (totalRecent/totalPrevious, and the channel's comment count) still counts each
    // comment exactly once, so shares and trends stay comparable.
    for (const theme of themesForRow(c)) {
      byTheme.set(theme, [...(byTheme.get(theme) ?? []), c])
    }
  }

  const top = [...byTheme]
    .filter(([, members]) => members.length >= MIN_THEME_COMMENTS)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, TOP_THEMES)
  if (top.length === 0) return { insights: [], windows: new Map() }

  const day = 24 * 60 * 60 * 1000
  const recentStart = now.getTime() - TREND_WINDOW_DAYS * day
  const previousStart = now.getTime() - 2 * TREND_WINDOW_DAYS * day
  const period = (c: CommentRow): 'recent' | 'previous' | null => {
    if (!c.posted_at) return null
    const t = new Date(c.posted_at).getTime()
    if (t >= recentStart && t <= now.getTime()) return 'recent'
    if (t >= previousStart && t < recentStart) return 'previous'
    return null
  }
  const totalRecent = comments.filter(c => period(c) === 'recent').length
  const totalPrevious = comments.filter(c => period(c) === 'previous').length

  // Embeddings only for comments in the themes being stored — not the whole channel.
  const memberIds = top.flatMap(([, members]) => members.map(m => m.id))
  const embeddingRows = await fetchInBatches<{ id: string; embedding: string | null }>(supabase, {
    table: 'comments',
    select: 'id, embedding',
    inColumn: 'id',
    inValues: memberIds,
  })
  const embeddings = new Map<string, number[]>()
  for (const row of embeddingRows) {
    if (row.embedding) embeddings.set(row.id, typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding)
  }

  const windows = new Map<string, TrendWindow>()
  const insights = top.map(([theme, members]) => {
    const recentMembers = members.filter(m => period(m) === 'recent')
    const previousMembers = members.filter(m => period(m) === 'previous')
    const recentPosts = new Map<string, number>()
    for (const m of recentMembers) recentPosts.set(m.post_id, (recentPosts.get(m.post_id) ?? 0) + 1)
    windows.set(theme, {
      recent: recentMembers.length,
      previous: previousMembers.length,
      totalRecent,
      totalPrevious,
      windowDays: TREND_WINDOW_DAYS,
      recentSentiment: computeSentiment(recentMembers),
      previousSentiment: computeSentiment(previousMembers),
      recentByPost: [...recentPosts].sort((a, b) => b[1] - a[1]).map(([post_id, n]) => ({ post_id, comments: n })),
      recentSamples: recentMembers
        .map(m => ({ id: m.id, post_id: m.post_id, text: cleanText(m.text) }))
        .filter(m => m.text.length >= MIN_REPRESENTATIVE_CHARS)
        .sort((a, b) => b.text.length - a.text.length)
        .slice(0, 8)
        .map(m => ({ ...m, text: m.text.slice(0, 280) })),
    })

    const trend = computeTrend(
      members.filter(m => period(m) === 'recent').length,
      members.filter(m => period(m) === 'previous').length,
      totalRecent,
      totalPrevious
    )
    const postCounts = new Map<string, number>()
    for (const m of members) postCounts.set(m.post_id, (postCounts.get(m.post_id) ?? 0) + 1)

    return {
      creator_id: creatorId,
      topic: theme,
      comment_count: members.length,
      sentiment_breakdown: computeSentiment(members),
      trend_direction: trend.direction,
      trend_pct: trend.pct,
      representative_comment_ids: pickRepresentatives(members, embeddings),
      related_post_ids: [...postCounts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, RELATED_POST_COUNT)
        .map(([postId]) => postId),
      confidence: confidenceForSampleSize(members.length),
      computed_at: computedAt,
    }
  })
  return { insights, windows }
}

/**
 * Recomputes and stores one creator's insights.
 *
 * Inserts the new set first and only then deletes older rows, so a reader never
 * sees an empty table mid-refresh, and a failed insert leaves yesterday's
 * insights in place rather than none.
 */
export async function refreshAudienceInsights(
  supabase: SupabaseClient,
  creatorId: string,
  now: Date = new Date(),
  options: { insightAgent?: InsightAgentHook } = {}
): Promise<{ stored: number; insightAgent?: unknown }> {
  const { insights, windows } = await computeAudienceInsightsDetailed(supabase, creatorId, now)
  const computedAt = now.toISOString()

  if (insights.length > 0) {
    const { error: insertError } = await supabase.from('audience_insights').insert(insights)
    if (insertError) throw new Error(`Could not store insights: ${insertError.message}`)
  }

  const { error: deleteError } = await supabase
    .from('audience_insights')
    .delete()
    .eq('creator_id', creatorId)
    .lt('computed_at', computedAt)
  if (deleteError) throw new Error(`Could not clear old insights: ${deleteError.message}`)

  // Proactive step: surface genuinely notable swings to the creator's inbox. Runs
  // only after the insights are safely stored, and can never fail the refresh.
  let insightAgent: unknown
  if (options.insightAgent) {
    try {
      insightAgent = await options.insightAgent(supabase, creatorId, insights, windows, now)
    } catch (err) {
      insightAgent = { error: err instanceof Error ? err.message : String(err) }
    }
  }
  return { stored: insights.length, ...(insightAgent !== undefined ? { insightAgent } : {}) }
}

/** The Insight Agent's entry point, injected so this module doesn't import it. */
export type InsightAgentHook = (
  supabase: SupabaseClient,
  creatorId: string,
  insights: AudienceInsight[],
  windows: Map<string, TrendWindow>,
  now: Date
) => Promise<unknown>

export type StoredInsight = AudienceInsight & { id: string }

/** The latest stored insights for one creator, optionally narrowed to a theme. */
export async function loadAudienceInsights(
  supabase: SupabaseClient,
  creatorId: string,
  topic?: string
): Promise<StoredInsight[]> {
  const { data, error } = await supabase
    .from('audience_insights')
    .select('*')
    .eq('creator_id', creatorId)
    .order('computed_at', { ascending: false })
    .order('comment_count', { ascending: false })
  if (error) throw new Error(error.message)

  const rows = (data ?? []) as StoredInsight[]
  if (rows.length === 0) return []
  // Only the newest run, in case an interrupted refresh left an older set behind.
  const latest = rows.filter(r => r.computed_at === rows[0].computed_at)
  if (!topic) return latest

  // Accept a theme ("quality"), a raw topic ("video_quality"), or loose wording.
  const wanted = topic.toLowerCase().trim()
  const wantedTheme = themeForTopic(wanted)
  return latest.filter(r => r.topic === wanted || r.topic === wantedTheme || wanted.includes(r.topic))
}
