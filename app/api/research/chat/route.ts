import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchInBatches } from '@/lib/supabase-helpers'

// Gives the tool-use loop (up to ~6 sequential Claude calls) room to finish within
// one invocation. Vercel Hobby caps this at 60s, Pro at 300s.
export const maxDuration = 60

const MAX_TOOL_ROUNDS = 5
const ANTHROPIC_TIMEOUT_MS = 25000

// --- Shared context every tool executes against. postIds/postMap are the ONLY
// source of truth for "what belongs to this creator" — every tool below either
// queries within postIds, or filters by creator_id directly. A post id supplied
// by Claude (from its own tool input) is never trusted until checked against
// postIds/postMap, so a tool call can never reach another creator's data. ---
type ToolContext = {
  supabase: SupabaseClient
  creatorId: string
  postIds: string[]
  postMap: Map<string, string>
  postThumbnails: Map<string, string | null>
}

type VideoCard = {
  post_id: string
  title: string
  thumbnail_url: string | null
  total_comments: number
  category_counts: Record<string, number>
  top_topics: Array<{ topic: string; count: number }>
}

type StatsCard = {
  title: string
  stats: Array<{ label: string; value: string | number }>
}

type IdeaCard = {
  number: number
  title: string
  description: string
  signal: string
}

type AnomalyCard = {
  hasAnomaly: boolean
  findings: Array<{ description: string; severity: 'high' | 'medium' }>
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
  draft_reply: string | null
  draft_reply_approved_at: string | null
  draft_reply_created_at: string | null
}

function normalizeText(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ')
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
async function fetchRichComments(supabase: SupabaseClient, postIds: string[]): Promise<RichCommentRow[]> {
  if (postIds.length === 0) return []

  const rows: RichCommentRow[] = []
  let offset = 0
  const batchSize = 1000
  let hasMore = true

  while (hasMore) {
    const { data: batch, error } = await supabase
      .from('comments')
      .select(
        `
        id,
        text,
        post_id,
        posted_at,
        audience_member_id,
        audience_members ( display_name ),
        comment_categories ( category, topic, draft_reply, draft_reply_approved_at, draft_reply_created_at )
      `
      )
      .in('post_id', postIds)
      .range(offset, offset + batchSize - 1)

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

async function toolSearchComments(
  ctx: ToolContext,
  input: { query?: unknown; category?: unknown; post_id?: unknown }
) {
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  if (!query) return { error: 'query is required' }

  let postIds = ctx.postIds
  if (typeof input.post_id === 'string' && input.post_id) {
    const resolved = resolvePostId(ctx, input.post_id)
    if (!resolved) return { error: `No video found matching "${input.post_id}"` }
    postIds = [resolved]
  }

  const comments = await fetchRichComments(ctx.supabase, postIds)
  const lowerQuery = query.toLowerCase()

  let matches = comments.filter(c => c.text.toLowerCase().includes(lowerQuery))

  if (typeof input.category === 'string' && input.category) {
    matches = matches.filter(c => getCatInfo(c)?.category === input.category)
  }

  return {
    count: matches.length,
    results: matches.slice(0, 20).map(c => ({
      author: getAuthor(c),
      text: c.text,
      video: ctx.postMap.get(c.post_id) || 'Untitled video',
      category: getCatInfo(c)?.category || 'other',
      posted_at: c.posted_at,
    })),
  }
}

async function toolGetVideoBreakdown(ctx: ToolContext, input: { post_id_or_title?: unknown }) {
  const idOrTitle = typeof input.post_id_or_title === 'string' ? input.post_id_or_title : ''
  if (!idOrTitle) return { error: 'post_id_or_title is required' }

  const postId = resolvePostId(ctx, idOrTitle)
  if (!postId) return { error: `No video found matching "${idOrTitle}"` }

  const comments = await fetchRichComments(ctx.supabase, [postId])

  return { video_title: ctx.postMap.get(postId), ...videoBreakdown(comments) }
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

  const { data: comments, error: commentsError } = await ctx.supabase
    .from('comments')
    .select('text, post_id, posted_at')
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
    recent_comments: (comments || []).map(c => ({
      text: c.text,
      video: ctx.postMap.get(c.post_id) || 'Untitled video',
      posted_at: c.posted_at,
    })),
    other_possible_matches: members.slice(1).map(m => m.display_name),
  }
}

type TrendingGroup = {
  text: string
  count: number
  unique_people: number
  video_titles: string[]
}

// Shared repeated-comment grouping (same normalize-and-group approach as the
// Repeated Comments page), used by get_trending and suggest_content_ideas.
function computeTrendingGroups(
  comments: RichCommentRow[],
  postMap: Map<string, string>,
  minCount: number
): TrendingGroup[] {
  const normalizedGroups = new Map<string, Array<{ text: string; postId: string; audienceMemberId: string | null }>>()

  for (const c of comments) {
    const key = normalizeText(c.text)
    const existing = normalizedGroups.get(key) || []
    existing.push({ text: c.text, postId: c.post_id, audienceMemberId: c.audience_member_id })
    normalizedGroups.set(key, existing)
  }

  const groups: TrendingGroup[] = []
  for (const entries of normalizedGroups.values()) {
    const uniqueMembers = new Set(entries.map(e => e.audienceMemberId).filter(Boolean))
    if (uniqueMembers.size < 2 || entries.length < minCount) continue

    groups.push({
      text: entries[0].text,
      count: entries.length,
      unique_people: uniqueMembers.size,
      video_titles: Array.from(new Set(entries.map(e => postMap.get(e.postId) || 'Untitled video'))),
    })
  }

  groups.sort((a, b) => b.count - a.count)
  return groups
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

async function toolGetTrending(ctx: ToolContext, input: { min_repeat_count?: unknown }) {
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
    items: matches.slice(0, 20).map(c => ({
      author: getAuthor(c),
      text: c.text,
      video: ctx.postMap.get(c.post_id) || 'Untitled video',
      posted_at: c.posted_at,
    })),
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
async function toolSuggestContentIdeas(ctx: ToolContext) {
  const comments = await fetchRichComments(ctx.supabase, ctx.postIds)
  const trending = computeTrendingGroups(comments, ctx.postMap, 2)

  const topicCounts: Record<string, number> = {}
  const questions: RichCommentRow[] = []
  const purchaseIntent: RichCommentRow[] = []

  for (const c of comments) {
    const cat = getCatInfo(c)
    if (!cat) continue

    if (cat.topic) topicCounts[cat.topic] = (topicCounts[cat.topic] || 0) + 1
    // Only business-relevant questions (they cleared the relevance check and got
    // a drafted reply) — casual "when's the next upload" noise isn't a content signal.
    if (cat.category === 'question' && cat.draft_reply) questions.push(c)
    if (cat.category === 'purchase_intent') purchaseIntent.push(c)
  }

  return {
    instruction:
      'Synthesize 3-5 concrete content ideas from this data, grounding each in a specific repeated comment, question, or topic below. Then call present_content_ideas with those ideas so they render as cards.',
    trending_comments: trending.slice(0, 10),
    audience_questions: questions.slice(0, 15).map(c => ({
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

const TOOLS = [
  {
    name: 'search_comments',
    description: "Full-text search across this creator's comments, optionally filtered by category or scoped to one video.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for within comment text' },
        category: {
          type: 'string',
          enum: ['question', 'praise', 'complaint', 'purchase_intent', 'spam', 'other'],
          description: 'Optional category filter',
        },
        post_id: { type: 'string', description: "Optional video id or title to restrict the search to" },
      },
      required: ['query'],
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

async function executeTool(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'search_comments':
        return await toolSearchComments(ctx, input)
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

export async function POST(request: NextRequest) {
  try {
    const { creator_id, message, conversation_history } = await request.json()

    if (!creator_id || !message) {
      return NextResponse.json({ error: 'Missing creator_id or message' }, { status: 400 })
    }

    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll() {},
        },
      }
    )

    // Unlike /api/ask, this route verifies the caller actually owns creator_id
    // before handing back any audience data — and every tool below is bound to
    // this same creator_id via ctx.postIds/ctx.creatorId, never the raw input
    // Claude passes in.
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { data: creator } = await supabase
      .from('creators')
      .select('id')
      .eq('id', creator_id)
      .eq('user_id', user.id)
      .single()

    if (!creator) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { data: posts, error: postsError } = await supabase
      .from('posts')
      .select('id, title, thumbnail_url')
      .eq('creator_id', creator_id)

    if (postsError) {
      console.error('Research posts fetch error:', JSON.stringify(postsError, Object.getOwnPropertyNames(postsError), 2))
      return NextResponse.json({ error: 'Failed to fetch posts' }, { status: 500 })
    }

    const postList = posts || []
    const ctx: ToolContext = {
      supabase,
      creatorId: creator_id,
      postIds: postList.map(p => p.id),
      postMap: new Map(postList.map(p => [p.id, p.title])),
      postThumbnails: new Map(postList.map(p => [p.id, p.thumbnail_url as string | null])),
    }

    const systemPrompt = `You are an audience research assistant for a content creator. You have tools that query their real, live audience data — use them whenever a question needs specific facts rather than guessing. You can call more than one tool across a conversation turn if needed (e.g. look up a video, then compare it to another). Reference specific numbers and real quotes from tool results. Keep answers concise (2-5 sentences unless the data genuinely warrants a short list) and conversational. Light markdown is supported and rendered in the UI — use **bold** for key numbers, names, or video titles, and bullet or numbered lists when presenting several items. Don't over-format short answers; a one-line reply needs no formatting at all.`

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

    return NextResponse.json({
      success: true,
      reply: finalText,
      ...(videoCards.length > 0 ? { videoCards } : {}),
      ...(statsCards.length > 0 ? { statsCards } : {}),
      ...(ideaCards.length > 0 ? { ideaCards } : {}),
      ...(anomalyCard ? { anomalyCard } : {}),
    })
  } catch (err) {
    console.error('Research chat error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
