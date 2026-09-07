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

export async function fetchVideoComments(videoId: string) {
  const comments: Array<{
    externalCommentId: string
    authorChannelId: string
    authorDisplayName: string
    text: string
    publishedAt: string
  }> = []

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
      })
    }

    pageToken = data.nextPageToken ?? undefined
  } while (pageToken)

  return comments
}
