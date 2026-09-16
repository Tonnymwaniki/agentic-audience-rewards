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
  topic: string | null
}

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
      .select('id, post_id, text, posted_at, audience_member_id, comment_categories ( category, topic )')
      .in('post_id', postIds)
      .order('id')
      .range(from, from + pageSize - 1)
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
 * Computes one creator's insights without writing anything. Deterministic for a
 * given `now` and data, so it can be inspected or tested before being stored.
 */
export async function computeAudienceInsights(
  supabase: SupabaseClient,
  creatorId: string,
  now: Date = new Date()
): Promise<AudienceInsight[]> {
  const comments = await loadCreatorComments(supabase, creatorId)
  const computedAt = now.toISOString()

  const byTheme = new Map<string, CommentRow[]>()
  for (const c of comments) {
    const theme = themeForTopic(c.topic)
    if (!theme) continue
    byTheme.set(theme, [...(byTheme.get(theme) ?? []), c])
  }

  const top = [...byTheme]
    .filter(([, members]) => members.length >= MIN_THEME_COMMENTS)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, TOP_THEMES)
  if (top.length === 0) return []

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

  return top.map(([theme, members]) => {
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
  now: Date = new Date()
): Promise<{ stored: number }> {
  const insights = await computeAudienceInsights(supabase, creatorId, now)
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

  return { stored: insights.length }
}

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
