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

// Resolves a post either by exact id (must belong to this creator) or by a
// case-insensitive partial title match — never returns a post outside postMap.
function resolvePostId(ctx: ToolContext, idOrTitle: string): string | null {
  if (ctx.postMap.has(idOrTitle)) return idOrTitle

  const lower = idOrTitle.toLowerCase()
  for (const [id, title] of ctx.postMap.entries()) {
    if (title.toLowerCase().includes(lower)) return id
  }
  return null
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

async function toolGetTrending(ctx: ToolContext, input: { min_repeat_count?: unknown }) {
  const minCount = typeof input.min_repeat_count === 'number' && input.min_repeat_count > 1
    ? Math.floor(input.min_repeat_count)
    : 2

  const comments = await fetchRichComments(ctx.supabase, ctx.postIds)

  const normalizedGroups = new Map<string, Array<{ text: string; postId: string; audienceMemberId: string | null }>>()
  for (const c of comments) {
    const key = normalizeText(c.text)
    const existing = normalizedGroups.get(key) || []
    existing.push({ text: c.text, postId: c.post_id, audienceMemberId: c.audience_member_id })
    normalizedGroups.set(key, existing)
  }

  const groups: Array<{ text: string; count: number; unique_people: number; video_titles: string[] }> = []
  for (const entries of normalizedGroups.values()) {
    const uniqueMembers = new Set(entries.map(e => e.audienceMemberId).filter(Boolean))
    if (uniqueMembers.size < 2 || entries.length < minCount) continue

    groups.push({
      text: entries[0].text,
      count: entries.length,
      unique_people: uniqueMembers.size,
      video_titles: Array.from(new Set(entries.map(e => ctx.postMap.get(e.postId) || 'Untitled video'))),
    })
  }

  groups.sort((a, b) => b.count - a.count)

  return { count: groups.length, groups: groups.slice(0, 15) }
}

async function toolGetRewardHistory(ctx: ToolContext) {
  const { data: members, error: membersError } = await ctx.supabase
    .from('audience_members')
    .select('id')
    .eq('creator_id', ctx.creatorId)

  if (membersError) {
    console.error('Research tool reward_history members error:', JSON.stringify(membersError, Object.getOwnPropertyNames(membersError), 2))
    return { error: 'Failed to fetch reward history' }
  }

  const memberIds = (members || []).map(m => m.id)
  if (memberIds.length === 0) return { count: 0, events: [] }

  type RewardEventRow = {
    id: string
    post_id: string | null
    reason: string
    status: string
    created_at: string
    audience_members: unknown
  }

  const events = await fetchInBatches<RewardEventRow>(ctx.supabase, {
    table: 'reward_events',
    select: 'id, post_id, reason, status, created_at, audience_members ( display_name )',
    inColumn: 'audience_member_id',
    inValues: memberIds,
  })

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
]

async function executeTool(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'search_comments':
        return await toolSearchComments(ctx, input)
      case 'get_video_breakdown':
        return await toolGetVideoBreakdown(ctx, input)
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
      .select('id, title')
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
    }

    const systemPrompt = `You are an audience research assistant for a content creator. You have tools that query their real, live audience data — use them whenever a question needs specific facts rather than guessing. You can call more than one tool across a conversation turn if needed (e.g. look up a video, then compare it to another). Reference specific numbers and real quotes from tool results. Keep answers concise (2-5 sentences unless the data genuinely warrants a short list), conversational, no markdown formatting.`

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

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result = await callClaude(systemPrompt, messages, TOOLS)
      const toolUseBlocks = result.content.filter(b => b.type === 'tool_use')

      if (toolUseBlocks.length === 0) {
        finalText = result.content.find(b => b.type === 'text')?.text || null
        break
      }

      messages.push({ role: 'assistant', content: result.content })

      const toolResults = await Promise.all(
        toolUseBlocks.map(async block => ({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(await executeTool(ctx, block.name!, block.input || {})),
        }))
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

    return NextResponse.json({ success: true, reply: finalText })
  } catch (err) {
    console.error('Research chat error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
