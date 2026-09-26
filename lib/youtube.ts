import { logWarn } from '@/lib/logger'
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3'

// Same defensive parsing as the channel stats: YouTube sends counts as strings and
// omits likeCount entirely when a video has likes hidden. null means "not published
// by YouTube", which is not the same fact as zero.
function parseCount(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * An ISO 8601 duration as YouTube sends it (PT15M33S, PT1H2M, P1DT2H) in seconds.
 * null for anything unparseable, and for live streams, which report P0D.
 */
export function parseIsoDuration(raw: unknown): number | null {
  if (typeof raw !== 'string') return null
  const match = raw.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/)
  if (!match) return null
  const [, days, hours, minutes, seconds] = match
  const total = Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)
  return total > 0 ? Math.round(total) : null
}

/**
 * YouTube's category names, looked up once per id per process. videoCategories.list
 * costs 1 quota unit and the names never change, so caching keeps re-ingesting a
 * channel from paying for the same lookup repeatedly. Falls back to the raw id.
 */
const categoryNames = new Map<string, string>()

export async function youtubeCategoryName(categoryId: unknown): Promise<string | null> {
  if (typeof categoryId !== 'string' || !categoryId) return null
  const cached = categoryNames.get(categoryId)
  if (cached) return cached
  try {
    const url = new URL(`${YOUTUBE_API_BASE}/videoCategories`)
    url.searchParams.set('part', 'snippet')
    url.searchParams.set('id', categoryId)
    url.searchParams.set('key', process.env.YOUTUBE_API_KEY!)
    const res = await fetch(url.toString())
    if (!res.ok) throw new Error(`YouTube API error: ${res.status}`)
    const data = await res.json()
    const title = data.items?.[0]?.snippet?.title
    if (typeof title === 'string' && title) {
      categoryNames.set(categoryId, title)
      return title
    }
  } catch (err) {
    console.warn(`Could not resolve YouTube category ${categoryId}:`, err instanceof Error ? err.message : err)
  }
  // The raw id is still useful, and keeps the column populated.
  return categoryId
}

export async function fetchVideoMeta(videoId: string) {
  const url = new URL(`${YOUTUBE_API_BASE}/videos`)
  // snippet, statistics and contentDetails in ONE request — videos.list accepts
  // multiple parts, so asking separately would multiply the quota cost for the same
  // data.
  // liveStreamingDetails added for stream/premiere times. Extra parts on
  // videos.list do not change the quota cost — it is 1 unit per call regardless.
  url.searchParams.set('part', 'snippet,statistics,contentDetails,liveStreamingDetails')
  url.searchParams.set('id', videoId)
  url.searchParams.set('key', process.env.YOUTUBE_API_KEY!)

  const res = await fetch(url.toString())
  if (!res.ok) {
    throw new Error(`YouTube API error: ${res.status}`)
  }

  const data = await res.json()
  const item = data.items?.[0]
  if (!item) {
    throw new Error('Video not found')
  }

  const snippet = item.snippet
  const thumbnailUrl =
    snippet.thumbnails?.high?.url ||
    snippet.thumbnails?.medium?.url ||
    snippet.thumbnails?.default?.url ||
    null

  const statistics = item.statistics ?? {}

  return {
    /**
     * The complete videos.list item exactly as YouTube returned it, archived for
     * fields not extracted below (migration 40). Never modified.
     */
    raw: item as unknown,
    title: snippet.title,
    description: snippet.description,
    thumbnailUrl,
    // The real upload time from YouTube, as opposed to posts.ingested_at, which
    // only records when we first pulled the video in. Already present in the
    // snippet we were fetching anyway, so returning it costs no extra quota.
    publishedAt: (snippet.publishedAt as string | undefined) ?? null,
    // Which channel owns this video. Already in the snippet we fetch, and it is
    // what capability gating compares against a verified OAuth grant.
    channelId: (snippet.channelId as string | undefined) ?? null,
    likeCount: parseCount(statistics.likeCount),
    viewCount: parseCount(statistics.viewCount),
    durationSeconds: parseIsoDuration(item.contentDetails?.duration),
    youtubeCategory: await youtubeCategoryName(snippet.categoryId),
    // YouTube's own public comment count — not what we ingested.
    commentCount: parseCount(statistics.commentCount),
    tags: Array.isArray(snippet.tags) ? (snippet.tags as string[]) : null,
    // contentDetails.caption is the STRING "true"/"false", not a boolean, and only
    // covers captions the uploader published — not YouTube's auto-generated ones.
    hasCaptions:
      item.contentDetails?.caption === 'true' ? true : item.contentDetails?.caption === 'false' ? false : null,
    liveScheduledStart: item.liveStreamingDetails?.scheduledStartTime ?? null,
    liveScheduledEnd: item.liveStreamingDetails?.scheduledEndTime ?? null,
    liveActualStart: item.liveStreamingDetails?.actualStartTime ?? null,
    liveActualEnd: item.liveStreamingDetails?.actualEndTime ?? null,
  }
}

export type FetchedComment = {
  externalCommentId: string
  authorChannelId: string
  authorDisplayName: string
  text: string
  publishedAt: string
  /** The comment's own likes, from commentThreads.list. 0 when YouTube omits it. */
  likeCount: number
  /** Replies YouTube reports on this thread (top-level comments only). */
  replyCount: number
  /** When the commenter last edited it; equals publishedAt if never edited. */
  updatedAt: string | null
  /** The commenter's avatar. Public on YouTube, but identifying — see migration 37. */
  authorProfileImageUrl: string | null
  /**
   * The complete API item exactly as YouTube returned it — a commentThreads.list
   * item for a top-level comment, a comments.list item for a reply. Archived
   * unmodified (migration 40) for fields not extracted above.
   */
  raw: unknown
}

export type FetchedReply = FetchedComment & {
  /** The YouTube id of the top-level comment this answers. */
  parentExternalId: string
}

/**
 * Replies are fetched per top-level comment (one comments.list call per thread, one
 * quota unit per page), so a reply-heavy video could otherwise cost hundreds of
 * units. Threads are visited most-replied first and fetching stops at whichever cap
 * is reached first.
 */
export const REPLY_MAX_PARENTS_PER_VIDEO = 50
export const REPLY_MAX_PER_VIDEO = 200

export async function fetchVideoComments(videoId: string) {
  const comments: FetchedComment[] = []

  let pageToken: string | undefined

  do {
    const url = new URL(`${YOUTUBE_API_BASE}/commentThreads`)
    url.searchParams.set('part', 'snippet')
    url.searchParams.set('videoId', videoId)
    url.searchParams.set('maxResults', '100')
    url.searchParams.set('key', process.env.YOUTUBE_API_KEY!)
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken)
    }

    const res = await fetch(url.toString())
    if (!res.ok) {
      throw new Error(`YouTube API error: ${res.status}`)
    }

    const data = await res.json()

    for (const item of data.items ?? []) {
      const top = item.snippet.topLevelComment.snippet
      comments.push({
        externalCommentId: item.id,
        authorChannelId: top.authorChannelId.value,
        authorDisplayName: top.authorDisplayName,
        text: top.textDisplay,
        publishedAt: top.publishedAt,
        likeCount: parseCount(top.likeCount) ?? 0,
        replyCount: parseCount(item.snippet.totalReplyCount) ?? 0,
        updatedAt: top.updatedAt ?? null,
        authorProfileImageUrl: top.authorProfileImageUrl ?? null,
        raw: item,
      })
    }

    pageToken = data.nextPageToken ?? undefined
  } while (pageToken)

  return comments
}

/**
 * Replies to the given top-level comments, newest-thread-first by reply count and
 * bounded by REPLY_MAX_PARENTS_PER_VIDEO / REPLY_MAX_PER_VIDEO.
 *
 * A thread whose replies can't be read (deleted, disabled, or an API error on that
 * one thread) is skipped rather than failing the whole ingest — the top-level
 * comments are already worth storing.
 */
export async function fetchCommentReplies(
  parents: Array<{ externalCommentId: string; replyCount: number }>,
  options: { maxParents?: number; maxReplies?: number } = {}
): Promise<{ replies: FetchedReply[]; threadsFetched: number; threadsFailed: number; truncated: boolean }> {
  const maxParents = options.maxParents ?? REPLY_MAX_PARENTS_PER_VIDEO
  const maxReplies = options.maxReplies ?? REPLY_MAX_PER_VIDEO

  const withReplies = parents
    .filter(p => p.replyCount > 0)
    .sort((a, b) => b.replyCount - a.replyCount || a.externalCommentId.localeCompare(b.externalCommentId))
  const selected = withReplies.slice(0, maxParents)

  const replies: FetchedReply[] = []
  let threadsFetched = 0
  let threadsFailed = 0

  for (const parent of selected) {
    if (replies.length >= maxReplies) break
    let pageToken: string | undefined
    try {
      do {
        const url = new URL(`${YOUTUBE_API_BASE}/comments`)
        url.searchParams.set('part', 'snippet')
        url.searchParams.set('parentId', parent.externalCommentId)
        url.searchParams.set('maxResults', '100')
        url.searchParams.set('key', process.env.YOUTUBE_API_KEY!)
        if (pageToken) url.searchParams.set('pageToken', pageToken)

        const res = await fetch(url.toString())
        if (!res.ok) throw new Error(`YouTube API error: ${res.status}`)
        const data = await res.json()

        for (const item of data.items ?? []) {
          const snippet = item.snippet
          // Replies from deleted or hidden channels arrive without an author id, and
          // an audience_members row can't be keyed without one.
          const authorChannelId = snippet?.authorChannelId?.value
          if (!authorChannelId) continue
          if (replies.length >= maxReplies) break
          replies.push({
            externalCommentId: item.id,
            parentExternalId: parent.externalCommentId,
            authorChannelId,
            authorDisplayName: snippet.authorDisplayName,
            text: snippet.textDisplay,
            publishedAt: snippet.publishedAt,
            likeCount: parseCount(snippet.likeCount) ?? 0,
            // Replies can't be replied to on YouTube; a nested reply's parent is
            // still the top-level comment.
            replyCount: 0,
            updatedAt: snippet.updatedAt ?? null,
            authorProfileImageUrl: snippet.authorProfileImageUrl ?? null,
            raw: item,
          })
        }

        pageToken = replies.length >= maxReplies ? undefined : (data.nextPageToken ?? undefined)
      } while (pageToken)
      threadsFetched++
    } catch (err) {
      threadsFailed++
      logWarn('youtube.fetchCommentReplies', 'Reply thread failed; counted in threadsFailed', { external_comment_id: parent.externalCommentId, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  return {
    replies,
    threadsFetched,
    threadsFailed,
    truncated: withReplies.length > selected.length || replies.length >= maxReplies,
  }
}
