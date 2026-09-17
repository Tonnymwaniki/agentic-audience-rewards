const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3'

// Same defensive parsing as the channel stats: YouTube sends counts as strings and
// omits likeCount entirely when a video has likes hidden. null means "not published
// by YouTube", which is not the same fact as zero.
function parseCount(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export async function fetchVideoMeta(videoId: string) {
  const url = new URL(`${YOUTUBE_API_BASE}/videos`)
  // snippet and statistics in ONE request — videos.list accepts multiple parts, so
  // asking separately would double the quota cost for the same data.
  url.searchParams.set('part', 'snippet,statistics')
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
    title: snippet.title,
    description: snippet.description,
    thumbnailUrl,
    likeCount: parseCount(statistics.likeCount),
    viewCount: parseCount(statistics.viewCount),
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
          })
        }

        pageToken = replies.length >= maxReplies ? undefined : (data.nextPageToken ?? undefined)
      } while (pageToken)
      threadsFetched++
    } catch (err) {
      threadsFailed++
      console.error(`Reply fetch failed for ${parent.externalCommentId}:`, err instanceof Error ? err.message : err)
    }
  }

  return {
    replies,
    threadsFetched,
    threadsFailed,
    truncated: withReplies.length > selected.length || replies.length >= maxReplies,
  }
}
