const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3'

export async function fetchVideoMeta(videoId: string) {
  const url = new URL(`${YOUTUBE_API_BASE}/videos`)
  url.searchParams.set('part', 'snippet')
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
  return {
    title: snippet.title,
    description: snippet.description,
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
