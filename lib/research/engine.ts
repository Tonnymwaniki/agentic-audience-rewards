import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchInBatches } from '@/lib/supabase-helpers'
// Shared with the Research page's "Trending Topics" sidebar card, so the panel and
// the get_trending tool can never disagree about what's trending.
import { computeTrendingGroups, computeSentiment, sentimentForCategory, SENTIMENTS, type Sentiment } from '@/lib/trending'
import { hybridSearchComments, listFilteredComments, HybridSearchUnavailableError } from '@/lib/hybrid-search'
import { loadAudienceInsights, themeForTopic } from '@/lib/audience-insights'
import { COMMENT_LANGUAGES, type CommentLanguage } from '@/lib/categorize'
import { EvidenceRegistry, extractCitations, type Evidence } from '@/lib/research/evidence'
import { verifyResearchAnswer, withNote, UNVERIFIED_NOTE, type AnswerVerification, type ToolCallDigest } from '@/lib/research/verify-answer'

const MAX_TOOL_ROUNDS = 5
const ANTHROPIC_TIMEOUT_MS = 25000
/** The route's maxDuration is 60s; the turn plans to finish inside this. */
const TURN_BUDGET_MS = 55_000
/** Below this much remaining time, answer verification is skipped. */
const MIN_VERIFY_MS = 9_000
const VERIFY_TIMEOUT_MS = 20_000
/** Kept back for citation extraction and sending the response. */
const VERIFY_SAFETY_MS = 3_000

// --- Shared context every tool executes against. postIds/postMap are the ONLY
// source of truth for "what belongs to this creator" — every tool below either
// queries within postIds, or filters by creator_id directly. A post id supplied
// by Claude (from its own tool input) is never trusted until checked against
// postIds/postMap, so a tool call can never reach another creator's data. ---
export type ToolContext = {
  supabase: SupabaseClient
  creatorId: string
  postIds: string[]
  postMap: Map<string, string>
  postThumbnails: Map<string, string | null>
  /** Comments and videos returned by tools this turn, addressable by short ref for citations. */
  evidence: EvidenceRegistry
}

export type VideoCard = {
  post_id: string
  video_ref?: string
  title: string
  thumbnail_url: string | null
  total_comments: number
  category_counts: Record<string, number>
  top_topics: Array<{ topic: string; count: number }>
}

export type StatsCard = {
  title: string
  stats: Array<{ label: string; value: string | number }>
}

export type IdeaCard = {
  number: number
  title: string
  description: string
  signal: string
}

export type AnomalyCard = {
  hasAnomaly: boolean
  findings: Array<{ description: string; severity: 'high' | 'medium' }>
}

export type PersonCard = {
  display_name: string
  reason: string
  comment_count: number
}

type RichCommentRow = {
  id: string
  text: string
  post_id: string
  posted_at: string
  audience_member_id: string | null
  audience_members: unknown
  comment_categories: unknown
}

type CategoryInfo = {
  category: string
  topic: string | null
  /** Absent until migration 20240101000024; null when none was detected. */
  language?: string | null
  draft_reply: string | null
  draft_reply_approved_at: string | null
  draft_reply_created_at: string | null
}

function getCatInfo(row: RichCommentRow): CategoryInfo | null {
  return row.comment_categories as CategoryInfo | null
}

function getAuthor(row: RichCommentRow): string {
  return (row.audience_members as { display_name: string } | null)?.display_name || 'Unknown'
}

// Generic words a user (or the model) tends to tack on that never appear in an
// actual video title — ignored so "my baby shop video" still matches.
const TITLE_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'my', 'me', 'on', 'in', 'for', 'and', 'to',
  'video', 'videos', 'vid', 'clip', 'show', 'about', 'one', 'that', 'this',
])

// Lowercase, strip punctuation to spaces, collapse runs of whitespace.
function normalizeTitle(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function significantWords(text: string): string[] {
  return normalizeTitle(text)
    .split(' ')
    .filter(word => word.length >= 2 && !TITLE_STOPWORDS.has(word))
}

// Resolves a post by exact id (must belong to this creator) or by fuzzy title
// match — never returns a post outside postMap.
//
// Matching is word-based rather than a single substring check, because real
// requests don't arrive as literal substrings: "nila babyshop" has to match
// "Secrets Of Running A Successful Mitumba Baby Shop Business~ CEO Nila Baby
// Shop" despite different word order and missing spaces. Each search word is
// tested against both the normalized title AND a space-stripped ("compact")
// version of it, so "babyshop" matches "baby shop" and vice versa.
function resolvePostId(ctx: ToolContext, idOrTitle: string): string | null {
  if (ctx.postMap.has(idOrTitle)) return idOrTitle

  const normalizedQuery = normalizeTitle(idOrTitle)
  if (!normalizedQuery) return null

  // If the query was nothing but stopwords, fall back to using them anyway
  // rather than matching nothing at all.
  const filtered = significantWords(idOrTitle)
  const words = filtered.length > 0 ? filtered : normalizedQuery.split(' ').filter(Boolean)
  if (words.length === 0) return null

  let best: { id: string; matched: number; titleLength: number } | null = null

  for (const [id, rawTitle] of ctx.postMap.entries()) {
    const normalizedTitle = normalizeTitle(rawTitle || '')
    if (!normalizedTitle) continue

    const compactTitle = normalizedTitle.replace(/ /g, '')

    let matched = 0
    for (const word of words) {
      if (normalizedTitle.includes(word) || compactTitle.includes(word)) matched++
    }

    if (matched === 0) continue

    // Most matching words wins; ties break toward the shorter (more specific) title.
    if (
      !best ||
      matched > best.matched ||
      (matched === best.matched && normalizedTitle.length < best.titleLength)
    ) {
      best = { id, matched, titleLength: normalizedTitle.length }
    }
  }

  if (!best) return null

  // Accept a full match, or a majority one — but not a single incidental word
  // ("shop") dragging in an unrelated video.
  const allMatched = best.matched === words.length
  const majorityMatched = best.matched * 2 >= words.length

  return allMatched || majorityMatched ? best.id : null
}

// Single shared, batched, creator-scoped comment fetch (with category/author
// joins) reused by every tool that needs comment-level data. `postIds` passed in
// must already be a subset of ctx.postIds — callers are responsible for that
// check via resolvePostId/ctx.postIds.includes(...) before calling this.
// False once the database reports comment_categories.language missing (migration
// 20240101000024 not run). Every Research tool loads comments through here, so a
// missing column must degrade to "no language data", never to "no comments".
let commentLanguageColumnAvailable = true

async function fetchRichComments(supabase: SupabaseClient, postIds: string[]): Promise<RichCommentRow[]> {
  if (postIds.length === 0) return []

  const rows: RichCommentRow[] = []
  let offset = 0
  const batchSize = 1000
  let hasMore = true

  const selectBatch = (from: number) =>
    supabase
      .from('comments')
      .select(
        `
        id,
        text,
        post_id,
        posted_at,
        audience_member_id,
        audience_members ( display_name ),
        comment_categories ( category, topic, draft_reply, draft_reply_approved_at, draft_reply_created_at${commentLanguageColumnAvailable ? ', language' : ''} )
      `
      )
      .in('post_id', postIds)
      .range(from, from + batchSize - 1)

  while (hasMore) {
    let { data: batch, error } = await selectBatch(offset)
    if (error && commentLanguageColumnAvailable && /language/.test(error.message ?? '')) {
      commentLanguageColumnAvailable = false
      ;({ data: batch, error } = await selectBatch(offset))
    }

    if (error) {
      console.error('Research tool comments fetch error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
      break
    }

    if (batch && batch.length > 0) {
      rows.push(...(batch as unknown as RichCommentRow[]))
      offset += batchSize
    }

    if (!batch || batch.length < batchSize) {
      hasMore = false
    }
  }

  return rows
}

function videoBreakdown(comments: RichCommentRow[]) {
  const categoryCounts: Record<string, number> = {}
  const topicCounts: Record<string, number> = {}

  for (const c of comments) {
    const cat = getCatInfo(c)
    if (!cat) continue
    categoryCounts[cat.category] = (categoryCounts[cat.category] || 0) + 1
    if (cat.topic) topicCounts[cat.topic] = (topicCounts[cat.topic] || 0) + 1
  }

  const topTopics = Object.fromEntries(
    Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)
  )

  return { total_comments: comments.length, category_counts: categoryCounts, top_topics: topTopics }
}

// ---------------------------------------------------------------------------
// Tool implementations — all read-only. None of these write to any table, call
// generateDraftReply, or trigger reward evaluation.
// ---------------------------------------------------------------------------

type CommentSearchFilters = {
  postId?: string
  category?: string
  /** Inclusive ISO lower bound on posted_at. */
  postedFrom?: string
  /** Exclusive ISO upper bound on posted_at. */
  postedBefore?: string
  sentiment?: Sentiment
  language?: CommentLanguage
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * A date_from / date_to value from the model, as an ISO bound.
 *
 * A bare date means the whole day (UTC): date_from 2026-09-03 starts at 00:00 that
 * day, and date_to 2026-09-17 runs to the START of 2026-09-18 as an exclusive
 * bound, so comments posted any time on the 17th are included. A full timestamp is
 * used as given.
 */
function parseDateBound(value: unknown, bound: 'from' | 'to'): { iso?: string; error?: string } {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value !== 'string') return { error: `date_${bound} must be a date like 2026-09-01` }
  const trimmed = value.trim()
  if (DATE_ONLY.test(trimmed)) {
    const start = new Date(`${trimmed}T00:00:00Z`)
    if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== trimmed) {
      return { error: `date_${bound} "${value}" is not a real date` }
    }
    if (bound === 'from') return { iso: start.toISOString() }
    return { iso: new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString() }
  }
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) return { error: `date_${bound} "${value}" is not a valid date (use YYYY-MM-DD)` }
  return { iso: new Date(parsed).toISOString() }
}

function commentMatchesFilters(c: RichCommentRow, filters: CommentSearchFilters): boolean {
  const category = getCatInfo(c)?.category ?? null
  if (filters.category && category !== filters.category) return false
  if (filters.sentiment && sentimentForCategory(category) !== filters.sentiment) return false
  if (filters.language && getCatInfo(c)?.language !== filters.language) return false
  const postedAt = c.posted_at ? Date.parse(c.posted_at) : NaN
  if (filters.postedFrom && !(postedAt >= Date.parse(filters.postedFrom))) return false
  if (filters.postedBefore && !(postedAt < Date.parse(filters.postedBefore))) return false
  return true
}

/** Top themes and videos listed in a period breakdown. */
const PERIOD_BREAKDOWN_THEMES = 10
const PERIOD_BREAKDOWN_VIDEOS = 5

/**
 * Theme, sentiment, category and video counts over EVERY comment matching a date-
 * filtered search, not just the 20 results listed — so questions about a period
 * ("what were people saying last month?") get counts scoped to that period, and
 * there's no reason to reach for get_audience_insights' all-time counts.
 *
 * Built with the same loader and filter predicate as the fallback search, and the
 * same theme grouping as the daily audience insights, so a period's themes are
 * directly comparable with the all-time ones.
 */
async function computePeriodBreakdown(
  ctx: ToolContext,
  filters: CommentSearchFilters,
  describe: string,
  preloaded?: RichCommentRow[]
) {
  const comments = preloaded ?? (await fetchRichComments(ctx.supabase, filters.postId ? [filters.postId] : ctx.postIds))
  const matching = comments.filter(c => commentMatchesFilters(c, filters))
  const languages: Record<string, number> = {}
  for (const c of matching) {
    const language = getCatInfo(c)?.language || 'not_detected'
    languages[language] = (languages[language] || 0) + 1
  }

  const categories: Record<string, number> = {}
  const themes = new Map<string, { count: number; positive: number; negative: number; neutral: number }>()
  const videos = new Map<string, number>()
  let uncategorized = 0

  for (const c of matching) {
    const info = getCatInfo(c)
    if (!info?.category) uncategorized++
    else categories[info.category] = (categories[info.category] || 0) + 1

    const theme = themeForTopic(info?.topic)
    if (theme) {
      const entry = themes.get(theme) ?? { count: 0, positive: 0, negative: 0, neutral: 0 }
      entry.count++
      const sentiment = sentimentForCategory(info?.category)
      if (sentiment) entry[sentiment]++
      themes.set(theme, entry)
    }
    videos.set(c.post_id, (videos.get(c.post_id) || 0) + 1)
  }

  return {
    scope: `Counts over ALL ${matching.length} comments ${describe} — every matching comment, not only the results listed. Use these figures, not get_audience_insights, for this period.`,
    total_comments: matching.length,
    // Counts and percentages under separate, explicit names. With both under plain
    // "positive"/"negative" keys, the answer check read "9% negative" as "9 negative
    // comments" and "corrected" it.
    sentiment_counts: {
      positive: matching.filter(c => sentimentForCategory(getCatInfo(c)?.category) === 'positive').length,
      negative: matching.filter(c => sentimentForCategory(getCatInfo(c)?.category) === 'negative').length,
      neutral: matching.filter(c => sentimentForCategory(getCatInfo(c)?.category) === 'neutral').length,
      uncategorized,
    },
    sentiment_percent: (({ positive, negative, neutral }) => ({ positive, negative, neutral }))(
      computeSentiment(matching.map(c => ({ category: getCatInfo(c)?.category ?? null })))
    ),
    sentiment_percent_note: `Percent of the ${matching.length - uncategorized} categorized comments, rounded so the three add up to 100 (so one can differ by 1 from dividing the count yourself). Use these exact percentages; do not recompute them.`,
    categories,
    languages,
    top_themes: [...themes]
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .slice(0, PERIOD_BREAKDOWN_THEMES)
      .map(([theme, t]) => ({ theme, ...t })),
    top_videos: [...videos]
      .sort((a, b) => b[1] - a[1])
      .slice(0, PERIOD_BREAKDOWN_VIDEOS)
      .map(([postId, count]) => ({ video: ctx.postMap.get(postId) || 'Untitled video', comments: count })),
  }
}

/** "posted 2026-08-01 to 2026-08-31" for the breakdown's scope line. */
function describeWindow(filters: CommentSearchFilters): string {
  const from = filters.postedFrom?.slice(0, 10)
  // posted_before is exclusive: the last included day is the one before it.
  const to = filters.postedBefore ? new Date(Date.parse(filters.postedBefore) - 1).toISOString().slice(0, 10) : undefined
  const window = from && to ? `posted ${from} to ${to}` : from ? `posted on or after ${from}` : `posted on or before ${to}`
  const extra = [
    filters.sentiment && `${filters.sentiment} sentiment`,
    filters.category && `category ${filters.category}`,
    filters.language && `written in ${filters.language}`,
    filters.postId && 'on the chosen video',
  ]
    .filter(Boolean)
    .join(', ')
  return extra ? `${window} (${extra})` : window
}

async function toolSearchComments(
  ctx: ToolContext,
  input: {
    query?: unknown
    category?: unknown
    post_id?: unknown
    date_from?: unknown
    date_to?: unknown
    sentiment?: unknown
    language?: unknown
  }
) {
  const query = typeof input.query === 'string' ? input.query.trim() : ''

  const filters: CommentSearchFilters = {}
  if (typeof input.post_id === 'string' && input.post_id) {
    const resolved = resolvePostId(ctx, input.post_id)
    if (!resolved) return { error: `No video found matching "${input.post_id}"` }
    filters.postId = resolved
  }
  if (typeof input.category === 'string' && input.category) filters.category = input.category

  if (input.sentiment !== undefined && input.sentiment !== null && input.sentiment !== '') {
    if (!SENTIMENTS.includes(input.sentiment as Sentiment)) {
      return { error: `sentiment must be one of ${SENTIMENTS.join(', ')}` }
    }
    filters.sentiment = input.sentiment as Sentiment
  }

  if (input.language !== undefined && input.language !== null && input.language !== '') {
    if (!COMMENT_LANGUAGES.includes(input.language as CommentLanguage)) {
      return { error: `language must be one of ${COMMENT_LANGUAGES.join(', ')}` }
    }
    filters.language = input.language as CommentLanguage
  }

  const from = parseDateBound(input.date_from, 'from')
  const to = parseDateBound(input.date_to, 'to')
  if (from.error || to.error) return { error: from.error || to.error }
  filters.postedFrom = from.iso
  filters.postedBefore = to.iso
  if (filters.postedFrom && filters.postedBefore && filters.postedFrom >= filters.postedBefore) {
    return { error: 'date_from must be on or before date_to' }
  }

  const hasFilter = !!(filters.postId || filters.category || filters.sentiment || filters.language || filters.postedFrom || filters.postedBefore)
  if (!query && !hasFilter) {
    return { error: 'Provide a query, or at least one filter (date_from, date_to, sentiment, language, category, post_id).' }
  }

  // Echoed back so the answer can state the exact window and filters it covers.
  const filtersApplied = {
    ...(filters.postedFrom ? { posted_on_or_after: filters.postedFrom } : {}),
    ...(filters.postedBefore ? { posted_before: filters.postedBefore } : {}),
    ...(filters.sentiment ? { sentiment: filters.sentiment } : {}),
    ...(filters.language ? { language: filters.language } : {}),
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.postId ? { video: ctx.postMap.get(filters.postId) || 'Untitled video' } : {}),
  }

  const toResult = (r: {
    id: string
    text: string
    author: string
    post_id: string
    category: string | null
    posted_at: string | null
    language?: string | null
  }) => {
    const video = ctx.postMap.get(r.post_id) || 'Untitled video'
    return {
      ref: ctx.evidence.comment({ id: r.id, text: r.text, author: r.author, post_id: r.post_id, video_title: video }),
      author: r.author,
      text: r.text,
      video,
      category: r.category || 'other',
      sentiment: sentimentForCategory(r.category),
      language: r.language ?? null,
      posted_at: r.posted_at,
    }
  }

  // ctx.creatorId is session-derived (see POST below), and postId has just been
  // checked against this creator's own videos — the two things the SQL functions
  // behind hybridSearchComments and listFilteredComments rely on the caller to
  // guarantee.
  const searchOptions = { ...filters, supabase: ctx.supabase }
  const hasDateFilter = !!(filters.postedFrom || filters.postedBefore)
  // Started alongside the search itself. Covers the filters only (not the query's
  // words): it answers "what happened in this period", whatever was searched for.
  const breakdownPromise = hasDateFilter ? computePeriodBreakdown(ctx, filters, describeWindow(filters)) : null

  try {
    if (!query) {
      const listed = await listFilteredComments(ctx.creatorId, 20, searchOptions)
      return {
        count: listed.total_matches,
        search_mode: 'filter',
        filters_applied: filtersApplied,
        note: 'count = every comment matching the filters; results are the newest 20 of them.',
        ...(breakdownPromise ? { period_breakdown: await breakdownPromise } : {}),
        results: listed.results.map(toResult),
      }
    }

    const hybrid = await hybridSearchComments(query, ctx.creatorId, 20, searchOptions)

    return {
      // Same meaning as before: how many comments actually contain the query's
      // words. The results list below also includes semantically related comments
      // that use different words, so its length is not a mention count.
      count: hybrid.keyword_match_count,
      search_mode: hybrid.semantic_unavailable ? 'keyword' : 'hybrid',
      ...(hasFilter ? { filters_applied: filtersApplied } : {}),
      note: hybrid.semantic_unavailable
        ? 'Keyword matches only (semantic search unavailable right now).'
        : "count = comments containing the query's words. results also include comments with related meaning that use different words (matched_by: semantic); judge those by their text.",
      ...(breakdownPromise
        ? {
            period_breakdown: {
              ...(await breakdownPromise),
              note: "Covers every comment matching the date and other filters, regardless of the query's words.",
            },
          }
        : {}),
      results: hybrid.results.map(r => ({ ...toResult(r), matched_by: r.matched_by })),
    }
  } catch (err) {
    if (!(err instanceof HybridSearchUnavailableError)) throw err
    // Search SQL functions not installed yet (migration 20240101000020 for hybrid
    // search, 20240101000023 for the date/sentiment filters): keep the tool working
    // with a substring search that applies the SAME filters in code, so a filtered
    // question never silently gets unfiltered results.
    console.warn('Search functions unavailable, using substring search:', err.message)
    const fallback = await legacySubstringSearch(ctx, query, filters, hasFilter ? filtersApplied : undefined)
    return breakdownPromise ? { ...fallback, period_breakdown: await breakdownPromise } : fallback
  }
}

// The original search_comments behaviour, kept only as the fallback above.
async function legacySubstringSearch(
  ctx: ToolContext,
  query: string,
  filters: CommentSearchFilters,
  filtersApplied: Record<string, string> | undefined
) {
  const comments = await fetchRichComments(ctx.supabase, filters.postId ? [filters.postId] : ctx.postIds)
  const lowerQuery = query.toLowerCase()

  const matches = comments
    .filter(c => (!lowerQuery || c.text.toLowerCase().includes(lowerQuery)) && commentMatchesFilters(c, filters))
    // Newest first, matching the filter-only SQL listing.
    .sort((a, b) => (b.posted_at || '').localeCompare(a.posted_at || ''))

  return {
    count: matches.length,
    search_mode: 'substring',
    ...(filtersApplied ? { filters_applied: filtersApplied } : {}),
    results: matches.slice(0, 20).map(c => {
      const video = ctx.postMap.get(c.post_id) || 'Untitled video'
      const category = getCatInfo(c)?.category ?? null
      return {
        ref: ctx.evidence.comment({ id: c.id, text: c.text, author: getAuthor(c), post_id: c.post_id, video_title: video }),
        author: getAuthor(c),
        text: c.text,
        video,
        category: category || 'other',
        sentiment: sentimentForCategory(category),
        language: getCatInfo(c)?.language ?? null,
        posted_at: c.posted_at,
      }
    }),
  }
}

/** Below this many categorized comments, a period's percentages are flagged as unstable. */
const SMALL_PERIOD_SAMPLE = 30

type PeriodBreakdown = Awaited<ReturnType<typeof computePeriodBreakdown>>

const signed = (n: number, unit = '') => `${n > 0 ? '+' : ''}${n}${unit}`
const round1 = (n: number) => Math.round(n * 10) / 10

/**
 * Two period breakdowns side by side, with the differences already computed, so a
 * question like "how has sentiment changed since last month?" is one tool call and
 * the model reports differences rather than doing arithmetic across two results.
 * Changes are always period_2 minus period_1.
 */
async function toolComparePeriods(
  ctx: ToolContext,
  input: {
    period_1_start?: unknown
    period_1_end?: unknown
    period_2_start?: unknown
    period_2_end?: unknown
    language?: unknown
    category?: unknown
    post_id?: unknown
  }
) {
  const bounds = {
    p1From: parseDateBound(input.period_1_start, 'from'),
    p1To: parseDateBound(input.period_1_end, 'to'),
    p2From: parseDateBound(input.period_2_start, 'from'),
    p2To: parseDateBound(input.period_2_end, 'to'),
  }
  for (const [key, b] of Object.entries(bounds)) {
    if (b.error) return { error: b.error.replace(/date_(from|to)/, key) }
    if (!b.iso) return { error: 'period_1_start, period_1_end, period_2_start and period_2_end are all required (YYYY-MM-DD).' }
  }
  const p1 = { from: bounds.p1From.iso!, before: bounds.p1To.iso! }
  const p2 = { from: bounds.p2From.iso!, before: bounds.p2To.iso! }
  if (p1.from >= p1.before || p2.from >= p2.before) return { error: 'Each period must start on or before its end date.' }

  const base: CommentSearchFilters = {}
  if (typeof input.post_id === 'string' && input.post_id) {
    const resolved = resolvePostId(ctx, input.post_id)
    if (!resolved) return { error: `No video found matching "${input.post_id}"` }
    base.postId = resolved
  }
  if (typeof input.category === 'string' && input.category) base.category = input.category
  if (input.language !== undefined && input.language !== null && input.language !== '') {
    if (!COMMENT_LANGUAGES.includes(input.language as CommentLanguage)) {
      return { error: `language must be one of ${COMMENT_LANGUAGES.join(', ')}` }
    }
    base.language = input.language as CommentLanguage
  }

  // One load, filtered twice: both periods are computed from the same snapshot.
  const comments = await fetchRichComments(ctx.supabase, base.postId ? [base.postId] : ctx.postIds)
  const f1 = { ...base, postedFrom: p1.from, postedBefore: p1.before }
  const f2 = { ...base, postedFrom: p2.from, postedBefore: p2.before }
  const [b1, b2] = await Promise.all([
    computePeriodBreakdown(ctx, f1, describeWindow(f1), comments),
    computePeriodBreakdown(ctx, f2, describeWindow(f2), comments),
  ])

  const days = (p: { from: string; before: string }) => Math.round((Date.parse(p.before) - Date.parse(p.from)) / 86_400_000)
  const [d1, d2] = [days(p1), days(p2)]
  const label = (p: { from: string; before: string }) => `${p.from.slice(0, 10)} to ${new Date(Date.parse(p.before) - 1).toISOString().slice(0, 10)}`

  const summary: string[] = []
  const caveats: string[] = []

  const total = {
    period_1: b1.total_comments,
    period_2: b2.total_comments,
    change: b2.total_comments - b1.total_comments,
    change_pct: b1.total_comments > 0 ? round1(((b2.total_comments - b1.total_comments) / b1.total_comments) * 100) : null,
    per_day: { period_1: round1(b1.total_comments / d1), period_2: round1(b2.total_comments / d2) },
  }
  summary.push(
    `Comments went from ${b1.total_comments} (${d1} days, ${total.per_day.period_1}/day) to ${b2.total_comments} (${d2} days, ${total.per_day.period_2}/day).`
  )
  if (d1 !== d2) caveats.push(`The periods differ in length (${d1} vs ${d2} days): compare per_day rates and percentages, not raw counts.`)

  const sentiment = Object.fromEntries(
    (['positive', 'negative', 'neutral'] as const).map(k => {
      const change = {
        period_1_percent: b1.sentiment_percent[k],
        period_2_percent: b2.sentiment_percent[k],
        change_points: b2.sentiment_percent[k] - b1.sentiment_percent[k],
        period_1_count: b1.sentiment_counts[k],
        period_2_count: b2.sentiment_counts[k],
      }
      summary.push(
        `${k[0].toUpperCase()}${k.slice(1)} sentiment went from ${change.period_1_percent}% to ${change.period_2_percent}% (${signed(change.change_points, ' points')}).`
      )
      return [k, change]
    })
  )

  const share = (count: number, b: PeriodBreakdown) => (b.total_comments > 0 ? round1((count / b.total_comments) * 100) : 0)
  const themeNames = [...new Set([...b1.top_themes, ...b2.top_themes].map(t => t.theme))]
  const themes = themeNames
    .map(theme => {
      const c1 = b1.top_themes.find(t => t.theme === theme)?.count ?? 0
      const c2 = b2.top_themes.find(t => t.theme === theme)?.count ?? 0
      const s1 = share(c1, b1)
      const s2 = share(c2, b2)
      return { theme, period_1_count: c1, period_2_count: c2, period_1_share_percent: s1, period_2_share_percent: s2, share_change_points: round1(s2 - s1) }
    })
    .sort((a, b) => Math.abs(b.share_change_points) - Math.abs(a.share_change_points) || a.theme.localeCompare(b.theme))
  for (const t of themes.slice(0, 3)) {
    summary.push(
      `"${t.theme}" went from ${t.period_1_share_percent}% of comments (${t.period_1_count}) to ${t.period_2_share_percent}% (${t.period_2_count}) (${signed(t.share_change_points, ' points')}).`
    )
  }

  for (const [name, b] of [['period_1', b1], ['period_2', b2]] as const) {
    const categorized = b.total_comments - b.sentiment_counts.uncategorized
    if (categorized < SMALL_PERIOD_SAMPLE) {
      caveats.push(`${name} has only ${categorized} categorized comments, so its percentages can swing a lot; say so when reporting changes.`)
    }
  }

  return {
    scope:
      'period_1 is the baseline, period_2 the comparison; every change is period_2 minus period_1. Sentiment changes are in percentage POINTS of each period\'s categorized comments; theme shares are percent of each period\'s comments. Use the summary sentences and these figures as given.',
    period_1: { dates: label(p1), days: d1, ...b1 },
    period_2: { dates: label(p2), days: d2, ...b2 },
    changes: { total_comments: total, sentiment, themes: themes.slice(0, 10) },
    summary,
    caveats,
  }
}

/** Stated in both the tool description and its output, so the timeframe can't be lost. */
const INSIGHTS_SCOPE =
  'These counts cover ALL comments ever posted, not any specific date range — only the trend figure compares the last 30 days vs the prior 30. Do not use these counts to answer questions naming a specific time period (e.g. "last month", "this week"); use search_comments with date_from/date_to instead, whose period_breakdown gives that period\'s own counts.'

/** Exported for the Research report pages, which reuse this exact logic. */
export async function toolGetAudienceInsights(ctx: ToolContext, input: { topic?: unknown }) {
  const topic = typeof input.topic === 'string' && input.topic.trim() ? input.topic.trim() : undefined

  let insights
  try {
    insights = await loadAudienceInsights(ctx.supabase, ctx.creatorId, topic)
  } catch (err) {
    console.error('Research tool get_audience_insights error:', err instanceof Error ? err.message : err)
    return { error: 'Audience insights are not available yet (they are computed by a daily job).' }
  }

  if (insights.length === 0) {
    return topic
      ? { found: false, note: `No precomputed theme matches "${topic}". Try search_comments for specific wording.` }
      : { found: false, note: 'No audience insights have been computed for this channel yet.' }
  }

  // Representative comments are stored as ids; fetch their text so the model can
  // quote them and cite them. Scoped to this creator's own posts.
  const commentIds = [...new Set(insights.flatMap(i => i.representative_comment_ids))]
  const { data: commentRows } = await ctx.supabase
    .from('comments')
    .select('id, text, post_id, audience_members ( display_name )')
    .in('id', commentIds)
    .in('post_id', ctx.postIds)
  const commentsById = new Map((commentRows || []).map(c => [c.id as string, c]))

  const computedAt = insights[0].computed_at
  const ageHours = Math.round((Date.now() - new Date(computedAt).getTime()) / 36e5)

  return {
    scope: INSIGHTS_SCOPE,
    computed_at: computedAt,
    age_hours: ageHours,
    note:
      'Precomputed daily. "topic" is a theme grouping similar comment topics (e.g. content_quality and video_quality are both "quality"). ' +
      'Sentiment is derived from comment categories (praise = positive, complaint = negative, everything else neutral). ' +
      'trend_pct is the change in the theme\'s SHARE of all comments, last 30 days vs the 30 before; on small themes it swings widely, so weigh it with confidence (0-1, grows with sample size).',
    insights: insights.map(i => ({
      topic: i.topic,
      comment_count: i.comment_count,
      sentiment_breakdown: i.sentiment_breakdown,
      trend: { direction: i.trend_direction, pct: i.trend_pct === null ? null : Number(i.trend_pct) },
      confidence: Number(i.confidence),
      representative_comments: i.representative_comment_ids
        .map(id => commentsById.get(id))
        .filter(Boolean)
        .map(c => {
          const video = ctx.postMap.get(c!.post_id as string) || 'Untitled video'
          const author = (c!.audience_members as unknown as { display_name: string } | null)?.display_name || 'Unknown'
          return {
            ref: ctx.evidence.comment({ id: c!.id as string, text: c!.text as string, author, post_id: c!.post_id as string, video_title: video }),
            text: c!.text,
            author,
            video,
          }
        }),
      videos: i.related_post_ids
        .filter(id => ctx.postIds.includes(id))
        .map(id => ({ video_ref: ctx.evidence.video(id, ctx.postMap.get(id) || 'Untitled video'), title: ctx.postMap.get(id) || 'Untitled video' })),
    })),
  }
}

async function toolGetVideoBreakdown(ctx: ToolContext, input: { post_id_or_title?: unknown }) {
  const idOrTitle = typeof input.post_id_or_title === 'string' ? input.post_id_or_title : ''
  if (!idOrTitle) return { error: 'post_id_or_title is required' }

  const postId = resolvePostId(ctx, idOrTitle)
  if (!postId) return { error: `No video found matching "${idOrTitle}"` }

  const comments = await fetchRichComments(ctx.supabase, [postId])

  const title = ctx.postMap.get(postId) || 'Untitled video'
  return { video_ref: ctx.evidence.video(postId, title), video_title: title, ...videoBreakdown(comments) }
}

// Same underlying data as get_video_breakdown, reshaped specifically for a rich
// visual card on the client (thumbnail, array-of-topics instead of an object) —
// use this instead of get_video_breakdown when the user wants to SEE the video,
// not just hear the numbers.
async function toolShowVideoCard(ctx: ToolContext, input: { post_id_or_title?: unknown }): Promise<VideoCard | { error: string }> {
  const idOrTitle = typeof input.post_id_or_title === 'string' ? input.post_id_or_title : ''
  if (!idOrTitle) return { error: 'post_id_or_title is required' }

  const postId = resolvePostId(ctx, idOrTitle)
  if (!postId) return { error: `No video found matching "${idOrTitle}"` }

  const comments = await fetchRichComments(ctx.supabase, [postId])
  const { category_counts, top_topics } = videoBreakdown(comments)

  return {
    post_id: postId,
    video_ref: ctx.evidence.video(postId, ctx.postMap.get(postId) || 'Untitled video'),
    title: ctx.postMap.get(postId) || 'Untitled video',
    thumbnail_url: ctx.postThumbnails.get(postId) || null,
    total_comments: comments.length,
    category_counts,
    top_topics: Object.entries(top_topics)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([topic, count]) => ({ topic, count })),
  }
}

async function toolCompareVideos(ctx: ToolContext, input: { post_id_a?: unknown; post_id_b?: unknown }) {
  const a = typeof input.post_id_a === 'string' ? input.post_id_a : ''
  const b = typeof input.post_id_b === 'string' ? input.post_id_b : ''
  if (!a || !b) return { error: 'post_id_a and post_id_b are both required' }

  const [videoA, videoB] = await Promise.all([
    toolGetVideoBreakdown(ctx, { post_id_or_title: a }),
    toolGetVideoBreakdown(ctx, { post_id_or_title: b }),
  ])

  return { video_a: videoA, video_b: videoB }
}

async function toolLookupPerson(ctx: ToolContext, input: { display_name?: unknown }) {
  const displayName = typeof input.display_name === 'string' ? input.display_name.trim() : ''
  if (!displayName) return { error: 'display_name is required' }

  const { data: members, error } = await ctx.supabase
    .from('audience_members')
    .select('id, display_name, profile_summary')
    .eq('creator_id', ctx.creatorId)
    .ilike('display_name', `%${displayName}%`)
    .limit(5)

  if (error) {
    console.error('Research tool lookup_person error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
    return { error: 'Failed to look up that person' }
  }

  if (!members || members.length === 0) {
    return { found: false }
  }

  const member = members[0]

  // count: 'exact' gives the true total alongside the 20 rows we display, so
  // "commented N times" isn't silently capped at the page size.
  const { data: comments, error: commentsError, count } = await ctx.supabase
    .from('comments')
    .select('id, text, post_id, posted_at', { count: 'exact' })
    .eq('audience_member_id', member.id)
    .order('posted_at', { ascending: false })
    .limit(20)

  if (commentsError) {
    console.error('Research tool lookup_person comments error:', JSON.stringify(commentsError, Object.getOwnPropertyNames(commentsError), 2))
  }

  return {
    found: true,
    display_name: member.display_name,
    profile_summary: member.profile_summary || 'No profile built up yet',
    total_comments: count ?? (comments || []).length,
    recent_comments: (comments || []).map(c => {
      const video = ctx.postMap.get(c.post_id) || 'Untitled video'
      return {
        ref: ctx.evidence.comment({ id: c.id, text: c.text, author: member.display_name, post_id: c.post_id, video_title: video }),
        text: c.text,
        video,
        posted_at: c.posted_at,
      }
    }),
    other_possible_matches: members.slice(1).map(m => m.display_name),
  }
}

type RewardEventRow = {
  id: string
  post_id: string | null
  audience_member_id: string
  reason: string
  status: string
  created_at: string
  audience_members: unknown
}

// All reward events belonging to this creator's own audience members. Scoped by
// resolving the creator's member ids first, then querying reward_events only
// within that set — never by a caller-supplied filter.
async function fetchCreatorRewardEvents(ctx: ToolContext): Promise<RewardEventRow[]> {
  const { data: members, error: membersError } = await ctx.supabase
    .from('audience_members')
    .select('id')
    .eq('creator_id', ctx.creatorId)

  if (membersError) {
    console.error('Research tool reward events members error:', JSON.stringify(membersError, Object.getOwnPropertyNames(membersError), 2))
    return []
  }

  const memberIds = (members || []).map(m => m.id)
  if (memberIds.length === 0) return []

  return fetchInBatches<RewardEventRow>(ctx.supabase, {
    table: 'reward_events',
    select: 'id, post_id, audience_member_id, reason, status, created_at, audience_members ( display_name )',
    inColumn: 'audience_member_id',
    inValues: memberIds,
  })
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

function topEntries(counts: Record<string, number>, limit: number): Array<{ name: string; count: number }> {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }))
}

/** Exported for the Research report pages, which reuse this exact logic. */
export async function toolGetTrending(ctx: ToolContext, input: { min_repeat_count?: unknown }) {
  const minCount = typeof input.min_repeat_count === 'number' && input.min_repeat_count > 1
    ? Math.floor(input.min_repeat_count)
    : 2

  const comments = await fetchRichComments(ctx.supabase, ctx.postIds)
  const groups = computeTrendingGroups(comments, ctx.postMap, minCount)

  return { count: groups.length, groups: groups.slice(0, 15) }
}

async function toolGetRewardHistory(ctx: ToolContext) {
  const events = await fetchCreatorRewardEvents(ctx)
  if (events.length === 0) return { count: 0, events: [] }

  events.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

  return {
    count: events.length,
    events: events.slice(0, 30).map(e => ({
      person: (e.audience_members as { display_name: string } | null)?.display_name || 'Unknown',
      reason: e.reason,
      status: e.status,
      video: e.post_id ? ctx.postMap.get(e.post_id) || 'Untitled video' : 'General',
      created_at: e.created_at,
    })),
  }
}

async function toolGetPendingActions(ctx: ToolContext) {
  const comments = await fetchRichComments(ctx.supabase, ctx.postIds)

  const pending = comments.filter(c => {
    const cat = getCatInfo(c)
    return cat?.draft_reply && !cat.draft_reply_approved_at
  })

  const priority = (category: string) => (category === 'purchase_intent' ? 0 : category === 'complaint' ? 1 : category === 'question' ? 2 : 3)

  pending.sort((a, b) => {
    const diff = priority(getCatInfo(a)!.category) - priority(getCatInfo(b)!.category)
    if (diff !== 0) return diff
    const aTime = getCatInfo(a)?.draft_reply_created_at || a.posted_at
    const bTime = getCatInfo(b)?.draft_reply_created_at || b.posted_at
    return new Date(bTime).getTime() - new Date(aTime).getTime()
  })

  return {
    count: pending.length,
    items: pending.slice(0, 20).map(c => ({
      author: getAuthor(c),
      text: c.text,
      category: getCatInfo(c)!.category,
      drafted_reply: getCatInfo(c)!.draft_reply,
      video: ctx.postMap.get(c.post_id) || 'Untitled video',
    })),
  }
}

async function toolGetTimingInsights(ctx: ToolContext, input: { post_id?: unknown }) {
  let postIds = ctx.postIds

  if (typeof input.post_id === 'string' && input.post_id) {
    const resolved = resolvePostId(ctx, input.post_id)
    if (!resolved) return { error: `No video found matching "${input.post_id}"` }
    postIds = [resolved]
  }

  const comments = await fetchRichComments(ctx.supabase, postIds)

  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const buckets = new Map<string, number>()

  for (const c of comments) {
    const date = new Date(c.posted_at)
    if (isNaN(date.getTime())) continue
    const key = `${date.getUTCDay()}-${date.getUTCHours()}`
    buckets.set(key, (buckets.get(key) || 0) + 1)
  }

  const total = comments.length
  const topWindows = Array.from(buckets.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, count]) => {
      const [day, hour] = key.split('-').map(Number)
      return {
        day: DAY_NAMES[day],
        hour_utc: hour,
        count,
        percentage: total > 0 ? Math.round((count / total) * 100) : 0,
      }
    })

  return { total_comments: total, top_windows: topWindows, note: 'Hours are in UTC — no per-creator timezone is stored.' }
}

async function toolGetBusinessInquiries(ctx: ToolContext, input: { category?: unknown }) {
  const category = typeof input.category === 'string' ? input.category : ''
  if (!['purchase_intent', 'question', 'complaint'].includes(category)) {
    return { error: 'category must be one of purchase_intent, question, complaint' }
  }

  const comments = await fetchRichComments(ctx.supabase, ctx.postIds)

  const matches = comments.filter(c => {
    const cat = getCatInfo(c)
    if (!cat || cat.category !== category) return false
    // purchase_intent is inherently business-relevant by definition; question/complaint
    // only "pass" if they got a drafted reply, i.e. the relevance check said business.
    return category === 'purchase_intent' || !!cat.draft_reply
  })

  return {
    category,
    count: matches.length,
    items: matches.slice(0, 20).map(c => {
      const video = ctx.postMap.get(c.post_id) || 'Untitled video'
      return {
        ref: ctx.evidence.comment({ id: c.id, text: c.text, author: getAuthor(c), post_id: c.post_id, video_title: video }),
        author: getAuthor(c),
        text: c.text,
        video,
        posted_at: c.posted_at,
      }
    }),
  }
}

async function toolGetChannelOverview(ctx: ToolContext) {
  const comments = await fetchRichComments(ctx.supabase, ctx.postIds)
  const events = await fetchCreatorRewardEvents(ctx)

  const categoryCounts: Record<string, number> = {}
  const topicCounts: Record<string, number> = {}
  let categorized = 0
  let pendingInquiries = 0

  for (const c of comments) {
    const cat = getCatInfo(c)
    if (!cat) continue

    categorized++
    categoryCounts[cat.category] = (categoryCounts[cat.category] || 0) + 1
    if (cat.topic) topicCounts[cat.topic] = (topicCounts[cat.topic] || 0) + 1
    if (cat.draft_reply && !cat.draft_reply_approved_at) pendingInquiries++
  }

  const categoryPercentages: Record<string, number> = {}
  for (const [category, count] of Object.entries(categoryCounts)) {
    categoryPercentages[category] = categorized > 0 ? Math.round((count / categorized) * 100) : 0
  }

  return {
    total_videos: ctx.postIds.length,
    total_comments: comments.length,
    total_categorized: categorized,
    category_counts: categoryCounts,
    category_percentages: categoryPercentages,
    top_topics: topEntries(topicCounts, 5),
    total_people_recognized: new Set(events.map(e => e.audience_member_id)).size,
    total_reward_events: events.length,
    pending_business_inquiries: pendingInquiries,
  }
}

// Deliberately returns raw signal, not generated ideas — the conversation turn
// does the synthesis, so suggestions stay grounded in the data below.
/** Exported for the Research report pages, which reuse this exact logic. */
export async function toolSuggestContentIdeas(ctx: ToolContext) {
  const comments = await fetchRichComments(ctx.supabase, ctx.postIds)
  const trending = computeTrendingGroups(comments, ctx.postMap, 2)

  const topicCounts: Record<string, number> = {}
  const questions: RichCommentRow[] = []
  const purchaseIntent: RichCommentRow[] = []
  const contentRequests: RichCommentRow[] = []

  for (const c of comments) {
    const cat = getCatInfo(c)
    if (!cat) continue

    if (cat.topic) topicCounts[cat.topic] = (topicCounts[cat.topic] || 0) + 1
    // Only business-relevant questions (they cleared the relevance check and got
    // a drafted reply) — casual "when's the next upload" noise isn't a content signal.
    if (cat.category === 'question' && cat.draft_reply) questions.push(c)
    if (cat.category === 'purchase_intent') purchaseIntent.push(c)
    if (cat.category === 'content_request') contentRequests.push(c)
  }

  return {
    instruction:
      'Synthesize 3-5 concrete content ideas from this data, grounding each in a specific content request, repeated comment, question, or topic below. Then call present_content_ideas with those ideas so they render as cards.',
    trending_comments: trending.slice(0, 10),
    audience_questions: questions.slice(0, 15).map(c => ({
      text: c.text,
      video: ctx.postMap.get(c.post_id) || 'Untitled video',
    })),
    content_requests: contentRequests.slice(0, 15).map(c => ({
      text: c.text,
      video: ctx.postMap.get(c.post_id) || 'Untitled video',
    })),
    purchase_intent_signals: purchaseIntent.slice(0, 10).map(c => ({
      text: c.text,
      video: ctx.postMap.get(c.post_id) || 'Untitled video',
    })),
    top_topics: topEntries(topicCounts, 10),
  }
}

async function toolDetectAnomalies(ctx: ToolContext) {
  const comments = await fetchRichComments(ctx.supabase, ctx.postIds)

  const recentCutoff = daysAgo(7)
  const baselineCutoff = daysAgo(37) // the 30 days immediately before the recent window

  const recentCategories: Record<string, number> = {}
  const baselineCategories: Record<string, number> = {}
  const recentTopics: Record<string, number> = {}
  const baselineTopics: Record<string, number> = {}
  let recentTotal = 0
  let baselineTotal = 0

  for (const c of comments) {
    const posted = new Date(c.posted_at)
    if (isNaN(posted.getTime())) continue

    const isRecent = posted >= recentCutoff
    const isBaseline = posted >= baselineCutoff && posted < recentCutoff
    if (!isRecent && !isBaseline) continue

    if (isRecent) recentTotal++
    else baselineTotal++

    const cat = getCatInfo(c)
    if (!cat) continue

    const categoryBucket = isRecent ? recentCategories : baselineCategories
    categoryBucket[cat.category] = (categoryBucket[cat.category] || 0) + 1

    if (cat.topic) {
      const topicBucket = isRecent ? recentTopics : baselineTopics
      topicBucket[cat.topic] = (topicBucket[cat.topic] || 0) + 1
    }
  }

  const anomalies: Array<{
    kind: 'category' | 'topic' | 'volume'
    name: string
    direction: 'spike' | 'drop'
    recent_per_day: number
    baseline_per_day: number
    ratio: number | null
  }> = []

  const MIN_VOLUME = 3 // ignore tiny numbers where ratios are meaningless

  function compare(kind: 'category' | 'topic' | 'volume', name: string, recentCount: number, baselineCount: number) {
    if (recentCount < MIN_VOLUME && baselineCount < MIN_VOLUME) return

    const recentPerDay = recentCount / 7
    const baselinePerDay = baselineCount / 30

    if (baselinePerDay === 0) {
      if (recentCount >= MIN_VOLUME) {
        anomalies.push({
          kind,
          name,
          direction: 'spike',
          recent_per_day: Number(recentPerDay.toFixed(2)),
          baseline_per_day: 0,
          ratio: null, // brand new — no prior baseline to divide by
        })
      }
      return
    }

    const ratio = recentPerDay / baselinePerDay
    if (ratio >= 2 || ratio <= 0.5) {
      anomalies.push({
        kind,
        name,
        direction: ratio >= 2 ? 'spike' : 'drop',
        recent_per_day: Number(recentPerDay.toFixed(2)),
        baseline_per_day: Number(baselinePerDay.toFixed(2)),
        ratio: Number(ratio.toFixed(2)),
      })
    }
  }

  compare('volume', 'overall comment volume', recentTotal, baselineTotal)

  for (const category of new Set([...Object.keys(recentCategories), ...Object.keys(baselineCategories)])) {
    compare('category', category, recentCategories[category] || 0, baselineCategories[category] || 0)
  }

  for (const topic of new Set([...Object.keys(recentTopics), ...Object.keys(baselineTopics)])) {
    compare('topic', topic, recentTopics[topic] || 0, baselineTopics[topic] || 0)
  }

  anomalies.sort((a, b) => (b.ratio ?? Infinity) - (a.ratio ?? Infinity))

  return {
    window: 'last 7 days vs the prior 30-day average',
    recent_comments: recentTotal,
    baseline_comments: baselineTotal,
    anomalies_found: anomalies.length,
    anomalies: anomalies.slice(0, 10),
    ...(anomalies.length === 0
      ? { summary: 'No unusual spikes or drops — activity is in line with the prior 30-day average. Say so plainly rather than inventing a finding.' }
      : {}),
  }
}

async function toolGetWeeklyDigest(ctx: ToolContext) {
  const comments = await fetchRichComments(ctx.supabase, ctx.postIds)
  const events = await fetchCreatorRewardEvents(ctx)

  const weekCutoff = daysAgo(7)

  const categoryCounts: Record<string, number> = {}
  const topicCounts: Record<string, number> = {}
  const videoCounts: Record<string, number> = {}
  let weekComments = 0
  let pendingInquiries = 0

  for (const c of comments) {
    const cat = getCatInfo(c)

    // Pending inquiries are current state, not a this-week-only measure.
    if (cat?.draft_reply && !cat.draft_reply_approved_at) pendingInquiries++

    const posted = new Date(c.posted_at)
    if (isNaN(posted.getTime()) || posted < weekCutoff) continue

    weekComments++
    const videoTitle = ctx.postMap.get(c.post_id) || 'Untitled video'
    videoCounts[videoTitle] = (videoCounts[videoTitle] || 0) + 1

    if (!cat) continue
    categoryCounts[cat.category] = (categoryCounts[cat.category] || 0) + 1
    if (cat.topic) topicCounts[cat.topic] = (topicCounts[cat.topic] || 0) + 1
  }

  const weekEvents = events.filter(e => {
    const created = new Date(e.created_at)
    return !isNaN(created.getTime()) && created >= weekCutoff
  })

  return {
    period: 'last 7 days',
    total_comments_this_week: weekComments,
    category_breakdown_this_week: categoryCounts,
    top_topics_this_week: topEntries(topicCounts, 3),
    most_active_videos_this_week: topEntries(videoCounts, 3),
    pending_business_inquiries: pendingInquiries,
    people_recognized_this_week: new Set(weekEvents.map(e => e.audience_member_id)).size,
    reward_events_this_week: weekEvents.length,
  }
}

// Maps a channel-overview / weekly-digest tool result into the stat-grid shape the
// client renders. Only the headline numbers make it in — the full tool payload
// still goes back to Claude for its text answer, this is purely the visual layer.
function buildStatsCard(toolName: string, output: Record<string, unknown>): StatsCard | null {
  const num = (key: string): number | null => (typeof output[key] === 'number' ? (output[key] as number) : null)

  const stats: Array<{ label: string; value: string | number }> = []
  const push = (label: string, value: number | null) => {
    if (value !== null) stats.push({ label, value })
  }

  if (toolName === 'get_channel_overview') {
    push('VIDEOS', num('total_videos'))
    push('COMMENTS UNDERSTOOD', num('total_comments'))
    push('CATEGORIES ASSIGNED', num('total_categorized'))
    push('PEOPLE RECOGNIZED', num('total_people_recognized'))
    push('PENDING REPLIES', num('pending_business_inquiries'))

    return stats.length > 0 ? { title: 'Channel Overview', stats } : null
  }

  if (toolName === 'get_weekly_digest') {
    push('COMMENTS THIS WEEK', num('total_comments_this_week'))
    push('PEOPLE RECOGNIZED', num('people_recognized_this_week'))
    push('REWARDS ISSUED', num('reward_events_this_week'))
    push('PENDING REPLIES', num('pending_business_inquiries'))

    const topTopics = output.top_topics_this_week
    if (Array.isArray(topTopics) && topTopics.length > 0) {
      const top = topTopics[0] as { name?: unknown }
      if (typeof top?.name === 'string') {
        stats.push({ label: 'TOP TOPIC', value: top.name })
      }
    }

    return stats.length > 0 ? { title: 'This Week', stats } : null
  }

  return null
}

// detect_anomalies already returns structured findings, so its card is built
// deterministically from the tool's own output — no model involvement needed.
function buildAnomalyCard(output: Record<string, unknown>): AnomalyCard | null {
  const anomalies = output.anomalies
  if (!Array.isArray(anomalies)) return null

  const findings: AnomalyCard['findings'] = []

  for (const raw of anomalies) {
    const a = raw as {
      name?: unknown
      direction?: unknown
      recent_per_day?: unknown
      baseline_per_day?: unknown
      ratio?: unknown
    }

    if (typeof a.name !== 'string') continue

    const label = a.name.replace(/_/g, ' ')
    const recent = typeof a.recent_per_day === 'number' ? a.recent_per_day : 0
    const baseline = typeof a.baseline_per_day === 'number' ? a.baseline_per_day : 0
    const ratio = typeof a.ratio === 'number' ? a.ratio : null

    let description: string
    let severity: 'high' | 'medium'

    if (ratio === null) {
      // No prior baseline — this signal is new rather than N times bigger.
      description = `${label} is new — ${recent}/day over the last 7 days, with nothing comparable in the prior 30`
      severity = 'high'
    } else if (a.direction === 'drop') {
      description = `${label} dropped to ${ratio}x normal — ${recent}/day now vs ${baseline}/day before`
      severity = ratio <= 0.34 ? 'high' : 'medium'
    } else {
      description = `${label} spiked ${ratio}x — ${recent}/day now vs ${baseline}/day before`
      severity = ratio >= 3 ? 'high' : 'medium'
    }

    findings.push({ description, severity })
  }

  return { hasAnomaly: findings.length > 0, findings }
}

// present_content_ideas is a display tool: the model passes its synthesized ideas
// in as tool INPUT, and we lift them straight onto the response as cards. This
// keeps suggest_content_ideas returning raw signal only (no idea generation inside
// a tool function) while still producing structured, renderable output.
function buildIdeaCards(input: Record<string, unknown>): IdeaCard[] {
  const ideas = input.ideas
  if (!Array.isArray(ideas)) return []

  const cards: IdeaCard[] = []

  for (const raw of ideas) {
    const idea = raw as { title?: unknown; description?: unknown; signal?: unknown }
    if (typeof idea.title !== 'string' || typeof idea.description !== 'string') continue

    cards.push({
      number: cards.length + 1,
      title: idea.title,
      description: idea.description,
      signal: typeof idea.signal === 'string' ? idea.signal : 'audience signal',
    })
  }

  return cards.slice(0, 5)
}

function buildPersonCardFromLookup(output: Record<string, unknown>): PersonCard | null {
  if (output.found !== true || typeof output.display_name !== 'string') return null

  return {
    display_name: output.display_name,
    reason: typeof output.profile_summary === 'string' ? output.profile_summary : '',
    comment_count: typeof output.total_comments === 'number' ? output.total_comments : 0,
  }
}

// Verified server-side rather than trusting a model-supplied number — the model
// provides who and why, we provide the actual count. Scoped to this creator.
async function countCommentsForMember(ctx: ToolContext, displayName: string): Promise<number> {
  const { data: members } = await ctx.supabase
    .from('audience_members')
    .select('id')
    .eq('creator_id', ctx.creatorId)
    .ilike('display_name', displayName)
    .limit(1)

  const member = members?.[0]
  if (!member) return 0

  const { count } = await ctx.supabase
    .from('comments')
    .select('id', { count: 'exact', head: true })
    .eq('audience_member_id', member.id)

  return count || 0
}

// present_people is a display tool: the model passes who it wants to show and why,
// and we attach a real comment count to each before rendering.
async function buildPersonCardsFromInput(
  ctx: ToolContext,
  input: Record<string, unknown>
): Promise<PersonCard[]> {
  const people = input.people
  if (!Array.isArray(people)) return []

  const cards: PersonCard[] = []

  for (const raw of people.slice(0, 8)) {
    const person = raw as { display_name?: unknown; reason?: unknown }
    if (typeof person.display_name !== 'string') continue

    cards.push({
      display_name: person.display_name,
      reason: typeof person.reason === 'string' ? person.reason : '',
      comment_count: await countCommentsForMember(ctx, person.display_name),
    })
  }

  return cards
}

const TOOLS = [
  {
    name: 'get_audience_insights',
    description:
      "Precomputed daily, ALL-TIME summary of what this creator's audience talks about: the top themes, each with comment count, sentiment mix, 30-day trend, confidence, representative comments and the videos that discuss it most. These counts cover ALL comments ever posted, not any specific date range — only the trend figure compares the last 30 days vs the prior 30. Use this FIRST for broad, all-time questions about themes, what people talk about or trends. Do not use this tool's counts to answer questions naming a specific time period (e.g. 'last month', 'this week', 'the last 2 weeks') — use search_comments with date filters instead for those. For what people feel negative or positive about, use search_comments with its sentiment filter.",
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Optional theme to narrow to, e.g. "quality", "request", "delivery"' },
      },
    },
  },
  {
    name: 'search_comments',
    description:
      "Search this creator's comments by wording and meaning, and/or filter them by when they were posted, sentiment, category or video. Combine filters in ONE call rather than approximating with several tools. Use date_from/date_to for time questions (\"what were people saying last month\", \"complaints from before the price change\", \"the last 2 weeks\"), working the dates out from today's date. \"Last month\" ALWAYS means the previous FULL CALENDAR MONTH, never a rolling 30-day window: if today is 2026-09-17, \"last month\" is date_from 2026-08-01, date_to 2026-08-31. Use a rolling window ending today only for phrases that say so, like \"the last 30 days\" or \"the past 4 weeks\"; for looser phrases such as \"the past month\", use judgment. Use sentiment for questions phrased in feelings (\"what are people unhappy about\" = negative, \"what do people love\" = positive). query is optional: leave it out to list comments that match the filters alone, newest first, with an exact count.",
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words or a topic to search for. Omit when the question is only about a time range, sentiment or category.',
        },
        date_from: {
          type: 'string',
          description: 'Only comments posted on or after this date, YYYY-MM-DD (UTC, inclusive).',
        },
        date_to: {
          type: 'string',
          description: 'Only comments posted on or before this date, YYYY-MM-DD (UTC, the whole day is included).',
        },
        sentiment: {
          type: 'string',
          enum: ['positive', 'negative', 'neutral'],
          description: 'Derived from category: praise = positive, complaint = negative, every other category = neutral. Uncategorized comments match no sentiment.',
        },
        language: {
          type: 'string',
          enum: ['english', 'swahili', 'sheng', 'mixed'],
          description:
            'Only comments written in this language, as detected during categorization: english, swahili, sheng (Nairobi street slang), or mixed (code-switched between English and Swahili/Sheng). Use for questions like "what are Sheng-speaking commenters saying". Comments analyzed before language detection existed have no language and match no language filter.',
        },
        category: {
          type: 'string',
          enum: ['question', 'praise', 'complaint', 'purchase_intent', 'content_request', 'spam', 'other'],
          description: 'Optional category filter',
        },
        post_id: { type: 'string', description: "Optional video id or title to restrict the search to" },
      },
    },
  },
  {
    name: 'compare_periods',
    description:
      "Compare two date ranges in ONE call: total comments (and per day), sentiment percentages and counts, theme shares and languages for each period, plus the computed changes and plain-language summary sentences (e.g. \"Negative sentiment went from 15% to 22% (+7 points)\"). Use this for any question about change over time — \"how has sentiment changed since last month\", \"this month vs last month\", \"are complaints up\" — instead of two search_comments calls. period_1 is the earlier/baseline period and period_2 the later one. \"Compared to last month\" with no other period named means last month (full calendar month) vs this month so far (the 1st of this month to today). Dates are YYYY-MM-DD, inclusive.",
    input_schema: {
      type: 'object',
      properties: {
        period_1_start: { type: 'string', description: 'Baseline period first day, YYYY-MM-DD' },
        period_1_end: { type: 'string', description: 'Baseline period last day, YYYY-MM-DD (inclusive)' },
        period_2_start: { type: 'string', description: 'Comparison period first day, YYYY-MM-DD' },
        period_2_end: { type: 'string', description: 'Comparison period last day, YYYY-MM-DD (inclusive)' },
        language: { type: 'string', enum: ['english', 'swahili', 'sheng', 'mixed'], description: 'Optional: compare only comments in this language' },
        category: {
          type: 'string',
          enum: ['question', 'praise', 'complaint', 'purchase_intent', 'content_request', 'spam', 'other'],
          description: 'Optional: compare only this category',
        },
        post_id: { type: 'string', description: 'Optional video id or title to restrict both periods to' },
      },
      required: ['period_1_start', 'period_1_end', 'period_2_start', 'period_2_end'],
    },
  },
  {
    name: 'get_video_breakdown',
    description: 'Category counts and top topics for one specific video, identified by its post id or (partial) title.',
    input_schema: {
      type: 'object',
      properties: {
        post_id_or_title: { type: 'string', description: "The video's post id or title" },
      },
      required: ['post_id_or_title'],
    },
  },
  {
    name: 'compare_videos',
    description: 'Side-by-side category-count comparison between two videos.',
    input_schema: {
      type: 'object',
      properties: {
        post_id_a: { type: 'string', description: "First video's post id or title" },
        post_id_b: { type: 'string', description: "Second video's post id or title" },
      },
      required: ['post_id_a', 'post_id_b'],
    },
  },
  {
    name: 'lookup_person',
    description: "Look up one audience member by display name: their comment history and any built-up profile summary.",
    input_schema: {
      type: 'object',
      properties: {
        display_name: { type: 'string', description: "The audience member's display name (or partial match)" },
      },
      required: ['display_name'],
    },
  },
  {
    name: 'get_trending',
    description: 'Repeated/trending comments — the same thing said by multiple different people, with which video(s) they appeared on.',
    input_schema: {
      type: 'object',
      properties: {
        min_repeat_count: { type: 'number', description: 'Minimum number of occurrences to include (default 2)' },
      },
    },
  },
  {
    name: 'get_reward_history',
    description: "All reward events (on-chain recognitions) issued to this creator's audience, with the reasoning behind each.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_pending_actions',
    description: 'Comments that currently have a drafted reply awaiting the creator\'s approval, in priority order (purchase intent, then complaints, then questions).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_timing_insights',
    description: 'When this audience is most active, by day of week and hour (UTC) — optionally scoped to one video.',
    input_schema: {
      type: 'object',
      properties: {
        post_id: { type: 'string', description: 'Optional video id or title to scope the analysis to' },
      },
    },
  },
  {
    name: 'get_business_inquiries',
    description: 'Comments in a given category that were confirmed as genuine business inquiries (i.e. they have a drafted reply), excluding casual/off-topic ones.',
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['purchase_intent', 'question', 'complaint'],
          description: 'Which category to pull confirmed business inquiries from',
        },
      },
      required: ['category'],
    },
  },
  {
    name: 'show_video_card',
    description: "Look up one video and return it formatted for a rich visual card (thumbnail, title, category breakdown, top topics). Use this when the user wants to SEE a specific video, not just hear numbers about it. Accepts a partial title match (like 'baby shop' or 'robotics') — you do not need the exact full title. Try calling this directly with whatever the user says, rather than asking them to confirm the exact title first. Example: if the user says 'show me my baby shop video', call this tool immediately with post_id_or_title: 'baby shop' — do not ask the user to clarify the exact title first, since this tool performs partial matching internally.",
    input_schema: {
      type: 'object',
      properties: {
        post_id_or_title: {
          type: 'string',
          description: "The video's post id, or any partial/approximate title fragment the user mentioned — pass it as-is, don't ask the user to clarify first.",
        },
      },
      required: ['post_id_or_title'],
    },
  },
  {
    name: 'get_channel_overview',
    description: 'One channel-wide snapshot across ALL videos: total comments, how many are categorized, category breakdown with percentages, top 5 topics, total people recognized, and pending business inquiries. Use this when the user asks how their channel is doing broadly ("how am I doing", "overview", "summary of everything") — NOT when they ask about one specific video (use get_video_breakdown for that).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'suggest_content_ideas',
    description: "Returns the raw audience-demand signal behind content ideas: trending/repeated comments, real business questions being asked, purchase-intent comments, and top topics. Use this when the user asks what to make next, what to post about, or what their audience wants. The tool returns DATA, not ideas — you synthesize 3-5 concrete content ideas from it yourself, citing which signal each came from.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'detect_anomalies',
    description: "Compares the last 7 days against the prior 30-day average and reports categories, topics, or overall comment volume that spiked or dropped significantly (roughly 2x up or half down). Use this when the user asks what changed, what's unusual, whether anything is off, or why things feel different. If it reports no anomalies, say so plainly — do not manufacture a finding.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'present_people',
    description: "Display specific audience members as visual person cards. Call this whenever your answer is about particular people — most loyal, most engaged, who to reward, who keeps asking about X. Gather the underlying data first (get_reward_history, search_comments, lookup_person, get_trending), then pass the people and your reason for each. Comment counts are filled in automatically — don't guess them. After calling this, write only a brief intro; the cards already list the people.",
    input_schema: {
      type: 'object',
      properties: {
        people: {
          type: 'array',
          description: 'The people to show, up to 8',
          items: {
            type: 'object',
            properties: {
              display_name: { type: 'string', description: "The audience member's display name, exactly as it appears in the data" },
              reason: { type: 'string', description: 'One sentence on why this person stands out for the question asked' },
            },
            required: ['display_name', 'reason'],
          },
        },
      },
      required: ['people'],
    },
  },
  {
    name: 'present_content_ideas',
    description: "Display your synthesized content ideas as visual cards. Call this AFTER suggest_content_ideas, passing the 3-5 ideas you came up with. After calling it, write only a brief conversational intro — do NOT restate the ideas in your text, the cards already show them.",
    input_schema: {
      type: 'object',
      properties: {
        ideas: {
          type: 'array',
          description: '3-5 content ideas synthesized from the audience signal',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short, punchy title for the video idea' },
              description: { type: 'string', description: '1-2 sentences on what it would cover and why the audience wants it' },
              signal: { type: 'string', description: 'The audience signal behind it, e.g. "repeated requests" or "purchase intent"' },
            },
            required: ['title', 'description', 'signal'],
          },
        },
      },
      required: ['ideas'],
    },
  },
  {
    name: 'get_weekly_digest',
    description: "This week's numbers as structured fields: comments this week, category breakdown, top 3 topics, most active videos, pending business inquiries, and people recognized this week. Use this when the user asks for a weekly summary, recap, digest, or something they can share.",
    input_schema: { type: 'object', properties: {} },
  },
]

/** Runs one tool. Exported so tools can be exercised directly in tests. */
export async function executeTool(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'search_comments':
        return await toolSearchComments(ctx, input)
      case 'compare_periods':
        return await toolComparePeriods(ctx, input)
      case 'get_video_breakdown':
        return await toolGetVideoBreakdown(ctx, input)
      case 'show_video_card':
        return await toolShowVideoCard(ctx, input)
      case 'compare_videos':
        return await toolCompareVideos(ctx, input)
      case 'lookup_person':
        return await toolLookupPerson(ctx, input)
      case 'get_trending':
        return await toolGetTrending(ctx, input)
      case 'get_reward_history':
        return await toolGetRewardHistory(ctx)
      case 'get_pending_actions':
        return await toolGetPendingActions(ctx)
      case 'get_timing_insights':
        return await toolGetTimingInsights(ctx, input)
      case 'get_business_inquiries':
        return await toolGetBusinessInquiries(ctx, input)
      case 'get_channel_overview':
        return await toolGetChannelOverview(ctx)
      case 'suggest_content_ideas':
        return await toolSuggestContentIdeas(ctx)
      case 'present_people': {
        // Pure display tool — the cards are captured from block.input.
        const count = Array.isArray(input.people) ? input.people.length : 0
        return {
          displayed: count,
          note: 'Person cards rendered for the user. Write only a short intro line — do not re-list the people.',
        }
      }
      case 'present_content_ideas': {
        // Pure display tool — touches no data, just acknowledges so the model can
        // write its intro. The ideas themselves are captured from block.input.
        const count = Array.isArray(input.ideas) ? input.ideas.length : 0
        return {
          displayed: count,
          note: 'Idea cards rendered for the user. Write only a short intro line — do not repeat the ideas.',
        }
      }
      case 'detect_anomalies':
        return await toolDetectAnomalies(ctx)
      case 'get_weekly_digest':
        return await toolGetWeeklyDigest(ctx)
      case 'get_audience_insights':
        return await toolGetAudienceInsights(ctx, input)
      default:
        return { error: `Unknown tool: ${name}` }
    }
  } catch (err) {
    console.error(`Research tool "${name}" error:`, JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return { error: 'This tool failed to run — try a different approach.' }
  }
}

type AnthropicContentBlock = {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

async function callClaude(
  system: string,
  messages: Array<{ role: string; content: unknown }>,
  tools: typeof TOOLS | undefined
): Promise<{ content: AnthropicContentBlock[]; stop_reason: string }> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS)

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system,
        messages,
        ...(tools ? { tools } : {}),
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`)
    }

    const data = await response.json()
    return { content: data.content || [], stop_reason: data.stop_reason }
  } finally {
    clearTimeout(timeoutId)
  }
}

export type ResearchTurnResult = {
  reply: string
  videoCards?: VideoCard[]
  statsCards?: StatsCard[]
  ideaCards?: IdeaCard[]
  anomalyCard?: AnomalyCard
  personCards?: PersonCard[]
  /** Evidence cited in `reply`, in citation order. */
  sources?: Evidence[]
  verification: AnswerVerification
}

/**
 * Builds the per-request tool context for one creator. `creatorId` must come
 * from the authenticated session — every tool is scoped by it.
 */
export async function buildResearchContext(supabase: SupabaseClient, creator_id: string): Promise<ToolContext> {
    const { data: posts, error: postsError } = await supabase
      .from('posts')
      .select('id, title, thumbnail_url')
      .eq('creator_id', creator_id)

    if (postsError) {
      console.error('Research posts fetch error:', JSON.stringify(postsError, Object.getOwnPropertyNames(postsError), 2))
      throw new Error('Failed to fetch posts')
    }

    const postList = posts || []
    const ctx: ToolContext = {
      supabase,
      creatorId: creator_id,
      postIds: postList.map(p => p.id),
      postMap: new Map(postList.map(p => [p.id, p.title])),
      postThumbnails: new Map(postList.map(p => [p.id, p.thumbnail_url as string | null])),
      evidence: new EvidenceRegistry(),
    }

  return ctx
}

/**
 * One Research chat turn: the tool loop, then the final answer and any cards.
 *
 * Lives outside the route file so it can be exercised directly — a Next.js route
 * module may only export request handlers and route config.
 */
export async function runResearchTurn(
  ctx: ToolContext,
  message: string,
  conversation_history: unknown
): Promise<ResearchTurnResult> {
    const turnStartedAt = Date.now()
    // Every tool call this turn, in order — the evidence the verifier checks against.
    const toolCallLog: ToolCallDigest[] = []

    // The model has no clock of its own; relative dates ("last 2 weeks") are worked
    // out from this before calling search_comments with date_from/date_to.
    const now = new Date()
    const today = now.toISOString().slice(0, 10)
    // "Last month" as a full calendar month, computed here rather than left to the
    // model: given only today's date it tended to pick a rolling 30-day window.
    const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10)
    const lastMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10)
    const thisMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10)
    const systemPrompt = `Today's date is ${today} (UTC).

Relative dates: "last month" always means the previous full calendar month — ${lastMonthStart} to ${lastMonthEnd} — never a rolling 30-day window. Use a rolling window ending today only when the wording says so ("the last 30 days", "the past 4 weeks"); for looser phrases like "the past month", use judgment. "This month" means ${thisMonthStart} to ${today}.

For questions about change over time ("how has sentiment changed compared to last month", "are complaints up this month"), call compare_periods once with both periods rather than searching each period separately.

You are an audience research assistant for a content creator. You have tools that query their real, live audience data — use them whenever a question needs specific facts rather than guessing. You can call more than one tool across a conversation turn if needed (e.g. look up a video, then compare it to another). Reference specific numbers and real quotes from tool results. Keep answers concise (2-5 sentences unless the data genuinely warrants a short list) and conversational. Light markdown is supported and rendered in the UI — use **bold** for key numbers, names, or video titles, and bullet or numbered lists when presenting several items. Don't over-format short answers; a one-line reply needs no formatting at all.

Citations: tool results tag individual comments with a "ref" like "C4" and videos with a "video_ref" like "V2". When a sentence states something drawn from specific comments or videos — a quote, an example, a count about a video — put the matching refs in square brackets right after that claim, like "Several viewers ask about delivery [C2][C5]." Only use refs that appear in this turn's tool results; never invent one. Greetings, general statements and suggestions need no citation.

For broad, all-time questions about what the audience talks about, themes or trends, call get_audience_insights before searching comment by comment. Its counts cover ALL comments ever posted, so never use them for a question naming a time period ("last month", "this week", "the last 2 weeks"): call search_comments with date_from/date_to and use its period_breakdown for that period's themes, sentiment and totals. When the question is about how people feel (what they're unhappy about, what they love) or about a period of time, use search_comments with its sentiment and/or date_from/date_to filters, together in one call, so the answer rests on the actual matching comments and an exact count.`

    const history: Array<{ role: string; content: string }> = Array.isArray(conversation_history)
      ? conversation_history
          .filter((m: unknown): m is { role: string; content: string } =>
            !!m &&
            typeof m === 'object' &&
            ((m as Record<string, unknown>).role === 'user' || (m as Record<string, unknown>).role === 'assistant') &&
            typeof (m as Record<string, unknown>).content === 'string'
          )
          .slice(-20)
      : []

    const messages: Array<{ role: string; content: unknown }> = [
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ]

    let finalText: string | null = null
    // Accumulated across every round of this turn, not just the last one — Claude
    // might call show_video_card early then keep reasoning in a later round, and
    // the card should still reach the client either way.
    const videoCards: VideoCard[] = []
    const statsCards: StatsCard[] = []
    const ideaCards: IdeaCard[] = []
    const personCards: PersonCard[] = []
    // Singular, unlike the arrays above: repeat calls in one turn would return the
    // same current anomaly state, so the last one simply wins.
    let anomalyCard: AnomalyCard | null = null

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result = await callClaude(systemPrompt, messages, TOOLS)
      const toolUseBlocks = result.content.filter(b => b.type === 'tool_use')

      console.log("RESEARCH TOOLS CALLED THIS TURN:", toolUseBlocks.map(t => ({ name: t.name, input: t.input })))

      if (toolUseBlocks.length === 0) {
        finalText = result.content.find(b => b.type === 'text')?.text || null
        break
      }

      messages.push({ role: 'assistant', content: result.content })

      const toolResults = await Promise.all(
        toolUseBlocks.map(async block => {
          const output = await executeTool(ctx, block.name!, block.input || {})
          toolCallLog.push({ tool: block.name!, input: block.input || {}, output })

          const usableOutput = output && typeof output === 'object' && !('error' in output)

          if (block.name === 'show_video_card' && usableOutput) {
            videoCards.push(output as VideoCard)
          }

          if ((block.name === 'get_channel_overview' || block.name === 'get_weekly_digest') && usableOutput) {
            const card = buildStatsCard(block.name, output as Record<string, unknown>)
            if (card) statsCards.push(card)
          }

          if (block.name === 'detect_anomalies' && usableOutput) {
            anomalyCard = buildAnomalyCard(output as Record<string, unknown>)
          }

          // Captured from the model's tool INPUT, not the tool's output.
          if (block.name === 'present_content_ideas') {
            ideaCards.push(...buildIdeaCards(block.input || {}))
          }

          if (block.name === 'present_people') {
            personCards.push(...(await buildPersonCardsFromInput(ctx, block.input || {})))
          }

          if (block.name === 'lookup_person' && usableOutput) {
            const card = buildPersonCardFromLookup(output as Record<string, unknown>)
            if (card) personCards.push(card)
          }

          return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(output),
          }
        })
      )

      messages.push({ role: 'user', content: toolResults })
    }

    // Hit MAX_TOOL_ROUNDS while Claude still wanted to call tools — force one
    // final answer without tools so the user isn't left with nothing.
    if (finalText === null) {
      const result = await callClaude(systemPrompt, messages, undefined)
      finalText = result.content.find(b => b.type === 'text')?.text || null
    }

    if (!finalText) {
      throw new Error('Empty response from Anthropic')
    }

    // Verify before citing, so a revision that removes an unsupported claim also
    // removes that claim's citation. Bounded by the route's time limit: the check
    // is skipped rather than risk the whole reply timing out.
    const remainingMs = TURN_BUDGET_MS - (Date.now() - turnStartedAt)
    let verification: AnswerVerification
    if (remainingMs < MIN_VERIFY_MS) {
      // Same fail-safe as a crashed check: an answer that couldn't be checked says so.
      finalText = withNote(finalText, UNVERIFIED_NOTE)
      verification = {
        checked: false,
        mode: 'none',
        reduced_confidence: true,
        unresolved_claims: [],
        attempt_failures: [],
        revised: false,
        unsupported_claims: [],
        fixes_applied: 0,
        fixes_rejected: 0,
        skipped_reason: 'not enough time left in this request',
      }
    } else {
      const verified = await verifyResearchAnswer({
        question: message,
        answer: finalText,
        toolCalls: toolCallLog,
        timeoutMs: Math.min(VERIFY_TIMEOUT_MS, remainingMs - VERIFY_SAFETY_MS),
      })
      finalText = verified.answer
      verification = verified.verification
    }

    const cited = extractCitations(finalText, ctx.evidence)
    if (cited.invalid_refs.length > 0) {
      console.warn('Research answer cited refs no tool returned (removed):', cited.invalid_refs)
    }

    return {
      reply: cited.text,
      ...(cited.sources.length > 0 ? { sources: cited.sources } : {}),
      verification,
      ...(videoCards.length > 0 ? { videoCards } : {}),
      ...(statsCards.length > 0 ? { statsCards } : {}),
      ...(ideaCards.length > 0 ? { ideaCards } : {}),
      ...(anomalyCard ? { anomalyCard } : {}),
      // Deduped by name — lookup_person and present_people can both fire in one
      // turn and surface the same person twice.
      ...(personCards.length > 0
        ? {
            personCards: personCards.filter(
              (card, i) => personCards.findIndex(c => c.display_name === card.display_name) === i
            ),
          }
        : {}),
    }
}
