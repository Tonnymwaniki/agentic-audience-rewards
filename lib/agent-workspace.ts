import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchInBatches } from '@/lib/supabase-helpers'
import { isChannelVerified } from '@/lib/channel-verification'
import { SEGMENTS } from '@/lib/segments'
import { LEVELS } from '@/lib/levels'
import { logError } from '@/lib/logger'

/**
 * Agent Home's workspace: an operational summary built only from stored data.
 *
 * Every figure is either computed from real rows or reported as unavailable —
 * `null` here always means "we don't have this", and the UI says so rather than
 * printing 0. That distinction is the point: 0 spam comments is a finding, a
 * missing subscriber count is not.
 */

const DAY_MS = 24 * 60 * 60 * 1000

export type WorkspaceRaw = {
  creator: {
    subscriber_count: number | null
    channel_stats_updated_at: string | null
    last_channel_check_at: string | null
  } | null
  posts: Array<{
    id: string
    channel_id: string | null
    analysis_status: string | null
    ingested_at: string | null
    duration_seconds: number | null
    youtube_category: string | null
  }>
  comments: Array<{ id: string; parent_comment_id: string | null; ingested_at: string | null; audience_member_id: string | null }>
  categories: Array<{ comment_id: string; category: string | null; language: string | null; sentiment: string | null }>
  insights: Array<{ topic: string; comment_count: number; trend_direction: string | null; trend_pct: number | null; computed_at: string }>
  /** channel id -> verified, per isChannelVerified, for every channel with analyzed videos or a grant. ALWAYS unfiltered by channelScope — this is the picker's source of truth for which channels exist at all. */
  channels: Array<{ channelId: string; title: string | null; verified: boolean; videos: number }>
  /** True when a channel scope was requested and this creator has more than one
   * channel — see WorkspaceSummary.intelligence.themesSpanAllChannels. */
  themesSpanAllChannels: boolean
  /**
   * One row per unique commenter behind `comments` above — so this respects the
   * same channel scope automatically, with no separate filtering logic. segment/
   * level are null for anyone not yet processed by refreshAudienceProfiles
   * (lib/audience-memory.ts) or the older Rewards-evaluation path.
   */
  audienceMembers: Array<{ id: string; segment: string | null; level: string | null }>
}

export type Share = { key: string; count: number; percent: number }

export type WorkspaceSummary = {
  sources: {
    youtube: {
      connected: boolean
      channels: WorkspaceRaw['channels']
      verifiedCount: number
      /** null = never fetched for this account. */
      subscribers: number | null
    }
  }
  ingestion: {
    /** Most recent of the stored sync/analysis timestamps, with what it was. */
    lastSync: { at: string; source: string } | null
    total: number
    topLevel: number
    replies: number
    new24h: number
    new7d: number
    /** Failed items are logged per sync but not stored anywhere queryable. */
    failedTracked: false
  }
  health: {
    categorized: number
    /** Share of categorized comments; 'none' = no language detected/recorded. */
    languages: Share[]
    spam: number
    processing: Array<{ status: string; count: number }>
    videos: number
    legacyVideos: number
  }
  intelligence: {
    /** null when insights have never been computed for this account. */
    themes: { computedAt: string; items: Array<{ topic: string; comments: number; trend: string | null; trendPct: number | null }> } | null
    /**
     * True when a channel scope is active AND the creator has more than one
     * channel — audience_insights (the themes source) has no channel_id column,
     * so themes are always computed across every channel. Rather than silently
     * showing another channel's themes as if they belonged to the selected one,
     * the UI reads this to caption them "across all your channels".
     */
    themesSpanAllChannels: boolean
    /** Shares of comments that HAVE a sentiment; unscored counted separately. */
    sentiment: { scored: number; unscored: number; shares: Share[] }
    categoryMix: Array<{ key: string; label: string; count: number }>
  }
  audience: {
    total: number
    /** How many of `total` have never been segmented/levelled yet (segment IS NULL) — surfaced so a creator isn't confused by numbers that don't add up to `total`. */
    unprocessed: number
    bySegment: Share[]
    byLevel: Share[]
  }
}

const LANGUAGES = ['english', 'swahili_sheng', 'mixed', 'none'] as const
const SENTIMENTS = ['positive', 'neutral', 'negative', 'mixed'] as const
const PROCESSING = ['done', 'running', 'error', 'idle'] as const
const CATEGORY_MIX: Array<{ key: string; label: string }> = [
  { key: 'question', label: 'Questions' },
  { key: 'complaint', label: 'Complaints' },
  { key: 'content_request', label: 'Requests' },
  { key: 'purchase_intent', label: 'Purchase signals' },
]

function shares(keys: readonly string[], counts: Map<string, number>, total: number): Share[] {
  return keys.map(key => {
    const count = counts.get(key) ?? 0
    return { key, count, percent: total > 0 ? Math.round((count / total) * 1000) / 10 : 0 }
  })
}

function latest(...candidates: Array<{ at: string | null | undefined; source: string }>) {
  return candidates
    .filter((c): c is { at: string; source: string } => Boolean(c.at))
    .sort((a, b) => b.at.localeCompare(a.at))[0] ?? null
}

/** Pure: every figure on the workspace, from raw rows. */
export function computeWorkspace(raw: WorkspaceRaw, now = Date.now()): WorkspaceSummary {
  const since24 = now - DAY_MS
  const since7d = now - 7 * DAY_MS
  const ingestedSince = (t: number) => raw.comments.filter(c => c.ingested_at && Date.parse(c.ingested_at) >= t).length
  const replies = raw.comments.filter(c => c.parent_comment_id).length

  const langCounts = new Map<string, number>()
  const sentimentCounts = new Map<string, number>()
  const categoryCounts = new Map<string, number>()
  let unscored = 0
  for (const c of raw.categories) {
    const lang = c.language ?? 'none'
    langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1)
    if (c.sentiment) sentimentCounts.set(c.sentiment, (sentimentCounts.get(c.sentiment) ?? 0) + 1)
    else unscored++
    if (c.category) categoryCounts.set(c.category, (categoryCounts.get(c.category) ?? 0) + 1)
  }
  const scored = raw.categories.length - unscored

  const statusCounts = new Map<string, number>()
  for (const p of raw.posts) {
    const s = p.analysis_status ?? 'idle'
    statusCounts.set(s, (statusCounts.get(s) ?? 0) + 1)
  }
  const extraStatuses = [...statusCounts.keys()].filter(s => !(PROCESSING as readonly string[]).includes(s))

  const newestComment = raw.comments.reduce<string | null>((m, c) => (c.ingested_at && (!m || c.ingested_at > m) ? c.ingested_at : m), null)
  const newestPost = raw.posts.reduce<string | null>((m, p) => (p.ingested_at && (!m || p.ingested_at > m) ? p.ingested_at : m), null)

  const themes = [...raw.insights].sort((a, b) => b.comment_count - a.comment_count).slice(0, 5)

  return {
    sources: {
      youtube: {
        connected: raw.posts.length > 0 || raw.channels.some(c => c.verified),
        channels: raw.channels,
        verifiedCount: raw.channels.filter(c => c.verified).length,
        subscribers: raw.creator?.subscriber_count ?? null,
      },
    },
    ingestion: {
      lastSync: latest(
        { at: raw.creator?.channel_stats_updated_at, source: 'channel stats refreshed' },
        { at: raw.creator?.last_channel_check_at, source: 'channel checked for new videos' },
        { at: newestPost, source: 'video analyzed' },
        { at: newestComment, source: 'comments collected' }
      ),
      total: raw.comments.length,
      topLevel: raw.comments.length - replies,
      replies,
      new24h: ingestedSince(since24),
      new7d: ingestedSince(since7d),
      failedTracked: false,
    },
    health: {
      categorized: raw.categories.length,
      languages: shares(LANGUAGES, langCounts, raw.categories.length),
      spam: categoryCounts.get('spam') ?? 0,
      processing: [...PROCESSING, ...extraStatuses].map(status => ({ status, count: statusCounts.get(status) ?? 0 })),
      videos: raw.posts.length,
      legacyVideos: raw.posts.filter(p => p.duration_seconds === null || p.youtube_category === null).length,
    },
    intelligence: {
      themes: themes.length
        ? {
            computedAt: themes.reduce((m, t) => (t.computed_at > m ? t.computed_at : m), themes[0].computed_at),
            items: themes.map(t => ({ topic: t.topic, comments: t.comment_count, trend: t.trend_direction, trendPct: t.trend_pct })),
          }
        : null,
      themesSpanAllChannels: raw.themesSpanAllChannels,
      sentiment: { scored, unscored, shares: shares(SENTIMENTS, sentimentCounts, scored) },
      categoryMix: CATEGORY_MIX.map(c => ({ ...c, count: categoryCounts.get(c.key) ?? 0 })),
    },
    audience: (() => {
      const segmentCounts = new Map<string, number>()
      const levelCounts = new Map<string, number>()
      let segmentedTotal = 0
      let levelledTotal = 0
      for (const m of raw.audienceMembers) {
        if (m.segment) {
          segmentCounts.set(m.segment, (segmentCounts.get(m.segment) ?? 0) + 1)
          segmentedTotal++
        }
        if (m.level) {
          levelCounts.set(m.level, (levelCounts.get(m.level) ?? 0) + 1)
          levelledTotal++
        }
      }
      return {
        total: raw.audienceMembers.length,
        // Segment and level are populated together (both written by the same
        // refresh pass), so either count works as "not yet processed" — segment
        // is used since it's the more decision-relevant of the two.
        unprocessed: raw.audienceMembers.length - segmentedTotal,
        bySegment: shares(SEGMENTS, segmentCounts, segmentedTotal),
        byLevel: shares(LEVELS, levelCounts, levelledTotal),
      }
    })(),
  }
}

/**
 * Loads the raw rows for one creator. `supabase` must be a SERVICE client (the
 * grant table behind isChannelVerified is service-role only) and `creatorId` must
 * come from the session.
 *
 * `channelId`, when given, scopes ingestion/health/intelligence.categoryMix to
 * that one channel's posts — without it, EVERY channel the creator has ever
 * analyzed (their own AND every "paste any channel URL" research target) is
 * blended into one set of numbers, which is the pre-existing behavior kept when
 * no scope is requested.
 */
export async function loadWorkspaceRaw(
  supabase: SupabaseClient,
  creatorId: string,
  channelId?: string | null
): Promise<WorkspaceRaw> {
  const [{ data: creator }, { data: posts, error: postsError }, { data: grants }, { data: insights }] = await Promise.all([
    supabase.from('creators').select('subscriber_count, channel_stats_updated_at, last_channel_check_at').eq('id', creatorId).maybeSingle(),
    supabase.from('posts').select('id, channel_id, analysis_status, ingested_at, duration_seconds, youtube_category').eq('creator_id', creatorId),
    supabase.from('youtube_oauth_tokens').select('channel_id, channel_title').eq('creator_id', creatorId),
    supabase.from('audience_insights').select('topic, comment_count, trend_direction, trend_pct, computed_at').eq('creator_id', creatorId),
  ])
  if (postsError) logError('agentWorkspace.load', postsError, { creator_id: creatorId, stage: 'posts' })

  // Unfiltered — used for the channels[] picker source and to know whether more
  // than one channel exists at all (for the themesSpanAllChannels caveat below).
  const allPosts = (posts ?? []) as WorkspaceRaw['posts']
  const distinctChannelCount = new Set(allPosts.map(p => p.channel_id).filter(Boolean)).size

  // The actual scope everything else in this function is computed from.
  const postList = channelId ? allPosts.filter(p => p.channel_id === channelId) : allPosts

  const comments = postList.length
    ? await fetchInBatches<WorkspaceRaw['comments'][number]>(supabase, {
        table: 'comments',
        select: 'id, parent_comment_id, ingested_at, audience_member_id',
        inColumn: 'post_id',
        inValues: postList.map(p => p.id),
      })
    : []
  const categories = comments.length
    ? await fetchInBatches<WorkspaceRaw['categories'][number]>(supabase, {
        table: 'comment_categories',
        select: 'comment_id, category, language, sentiment',
        inColumn: 'comment_id',
        inValues: comments.map(c => c.id),
      })
    : []

  // The audience behind THIS scope's comments — automatically respects channelId
  // filtering above with no separate query logic, since it's derived from the
  // already-scoped `comments` rather than queried by creator_id directly (which
  // would pull in every channel's commenters regardless of the picker).
  const audienceMemberIds = [...new Set(comments.map(c => c.audience_member_id).filter((id): id is string => Boolean(id)))]
  const audienceMembers = audienceMemberIds.length
    ? await fetchInBatches<WorkspaceRaw['audienceMembers'][number]>(supabase, {
        table: 'audience_members',
        select: 'id, segment, level',
        inColumn: 'id',
        inValues: audienceMemberIds,
      })
    : []

  // Every channel the creator has analyzed or connected, each checked with
  // isChannelVerified — the same per-channel test the capability gates use.
  const titles = new Map(((grants ?? []) as Array<{ channel_id: string | null; channel_title: string | null }>).filter(g => g.channel_id).map(g => [g.channel_id as string, g.channel_title]))
  const videosByChannel = new Map<string, number>()
  for (const p of allPosts) if (p.channel_id) videosByChannel.set(p.channel_id, (videosByChannel.get(p.channel_id) ?? 0) + 1)
  const channelIds = [...new Set([...titles.keys(), ...videosByChannel.keys()])]
  const channels = await Promise.all(
    channelIds.map(async channelId => ({
      channelId,
      title: titles.get(channelId) ?? null,
      verified: await isChannelVerified(supabase, creatorId, channelId),
      videos: videosByChannel.get(channelId) ?? 0,
    }))
  )
  channels.sort((a, b) => Number(b.verified) - Number(a.verified) || b.videos - a.videos)

  return {
    creator: (creator as WorkspaceRaw['creator']) ?? null,
    posts: postList,
    comments,
    categories,
    insights: (insights ?? []) as WorkspaceRaw['insights'],
    channels,
    themesSpanAllChannels: Boolean(channelId) && distinctChannelCount > 1,
    audienceMembers,
  }
}
