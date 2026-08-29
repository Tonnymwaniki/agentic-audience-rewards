const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3'

export type ChannelVideo = {
  videoId: string
  title: string
  thumbnailUrl: string
  publishedAt: string
}

function resolveChannelInput(input: string): { kind: 'handle' | 'channelId' | 'customUrl'; value: string } | null {
  const trimmed = input.trim()

  if (trimmed.startsWith('@')) {
    return { kind: 'handle', value: trimmed }
  }

  try {
    const url = new URL(trimmed)
    const pathname = url.pathname

    const handleMatch = pathname.match(/^\/@([^/]+)$/)
    if (handleMatch) {
      return { kind: 'handle', value: `@${handleMatch[1]}` }
    }

    const channelMatch = pathname.match(/^\/channel\/([^/]+)$/)
    if (channelMatch) {
      return { kind: 'channelId', value: channelMatch[1] }
    }

    const customMatch = pathname.match(/^\/c\/([^/]+)$/)
    if (customMatch) {
      return { kind: 'customUrl', value: customMatch[1] }
    }

    const userMatch = pathname.match(/^\/user\/([^/]+)$/)
    if (userMatch) {
      return { kind: 'customUrl', value: userMatch[1] }
    }
  } catch {
    // not a valid URL, fall through
  }

  if (/^UC[0-9A-Za-z_-]{22}$/.test(trimmed)) {
    return { kind: 'channelId', value: trimmed }
  }

  if (trimmed.startsWith('@')) {
    return { kind: 'handle', value: trimmed }
  }

  return null
}

async function getUploadsPlaylistId(channelInput: { kind: string; value: string }) {
  const url = new URL(`${YOUTUBE_API_BASE}/channels`)
  url.searchParams.set('part', 'contentDetails')
  url.searchParams.set('key', process.env.YOUTUBE_API_KEY!)
  url.searchParams.set('maxResults', '1')

  if (channelInput.kind === 'handle') {
    url.searchParams.set('forHandle', channelInput.value)
  } else if (channelInput.kind === 'channelId') {
    url.searchParams.set('id', channelInput.value)
  } else {
    url.searchParams.set('forUsername', channelInput.value)
  }

  const res = await fetch(url.toString())
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`YouTube API error: ${res.status} - ${text}`)
  }

  const data = await res.json()
  const channel = data.items?.[0]
  if (!channel) {
    throw new Error('Channel not found')
  }

  const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads
  if (!uploadsPlaylistId) {
    throw new Error('Channel has no uploads playlist')
  }

  return uploadsPlaylistId
}

export async function fetchChannelVideos(channelUrlOrHandle: string): Promise<ChannelVideo[]> {
  const channelInput = resolveChannelInput(channelUrlOrHandle)
  if (!channelInput) {
    throw new Error('Invalid YouTube channel URL or handle')
  }

  const uploadsPlaylistId = await getUploadsPlaylistId(channelInput)

  const playlistUrl = new URL(`${YOUTUBE_API_BASE}/playlistItems`)
  playlistUrl.searchParams.set('part', 'snippet')
  playlistUrl.searchParams.set('playlistId', uploadsPlaylistId)
  playlistUrl.searchParams.set('maxResults', '15')
  playlistUrl.searchParams.set('key', process.env.YOUTUBE_API_KEY!)

  const res = await fetch(playlistUrl.toString())
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`YouTube API error: ${res.status} - ${text}`)
  }

  const data = await res.json()
  const items = data.items ?? []

  return items.map((item: { snippet: { resourceId: { videoId: string }; title: string; thumbnails: { medium?: { url: string }; default?: { url: string } }; publishedAt: string } }) => {
    const snippet = item.snippet
    const thumbnailUrl = snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || ''

    return {
      videoId: snippet.resourceId.videoId,
      title: snippet.title,
      thumbnailUrl,
      publishedAt: snippet.publishedAt,
    }
  })
}
