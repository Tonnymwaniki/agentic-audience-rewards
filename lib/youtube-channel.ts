const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3'

export type ChannelStats = {
  subscriberCount: number | null
  viewCount: number | null
  videoCount: number | null
  /** snippet.publishedAt — when the channel was created. */
  createdAt: string | null
  /** snippet.country — owner-declared, often null. Not the audience's location. */
  country: string | null
}

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

/**
 * Safety valves, not product limits.
 *
 * These exist so an unexpected API response pattern — a nextPageToken that never
 * clears, say — can't spin forever burning quota. 2000 videos is far beyond any
 * realistic channel back catalogue; if a genuine channel ever trips it, the log
 * line below is how we find out and raise it.
 */
export const MAX_SYNC_VIDEOS = 2000
export const MAX_SYNC_PAGES = 40
/** The YouTube API maximum. Fewer, larger pages means fewer calls for the quota. */
const PAGE_SIZE = 50

/**
 * Called after each page. `pageVideos` is just that page's videos, so a caller can
 * store as it goes and report progress in terms of rows actually written.
 */
export type ChannelSyncProgress = (
  videosFound: number,
  pagesFetched: number,
  pageVideos: ChannelVideo[]
) => void | Promise<void>

/**
 * Walks a channel's uploads playlist, newest first, following nextPageToken —
 * either to the end, or until `limit` videos have been collected.
 *
 * With a limit it asks YouTube for no more than it still needs on each page
 * (maxResults = what's left, up to 50), so bringing in 20 videos costs one small
 * call rather than a full page. Private and deleted uploads occupy playlist slots
 * but are skipped, so a page can come back short; the loop then fetches another
 * page, which is what makes the result exactly `limit` whenever the channel has
 * that many public videos.
 *
 * onProgress fires after each page so a caller can surface a live count rather
 * than leaving the UI looking stuck.
 */
export async function fetchAllChannelVideos(
  channelUrlOrHandle: string,
  onProgress?: ChannelSyncProgress,
  options: { limit?: number } = {}
): Promise<{ videos: ChannelVideo[]; pages: number; hitCap: boolean }> {
  const { limit } = options
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`limit must be a positive whole number, got ${limit}`)
  }

  const channelInput = resolveChannelInput(channelUrlOrHandle)
  if (!channelInput) {
    throw new Error('Invalid YouTube channel URL or handle')
  }

  const uploadsPlaylistId = await getUploadsPlaylistId(channelInput)

  const videos: ChannelVideo[] = []
  let pageToken: string | undefined
  let pages = 0
  let hitCap = false

  do {
    const url = new URL(`${YOUTUBE_API_BASE}/playlistItems`)
    url.searchParams.set('part', 'snippet')
    url.searchParams.set('playlistId', uploadsPlaylistId)
    const stillNeeded = limit === undefined ? PAGE_SIZE : limit - videos.length
    url.searchParams.set('maxResults', String(Math.min(PAGE_SIZE, stillNeeded)))
    url.searchParams.set('key', process.env.YOUTUBE_API_KEY!)
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const res = await fetch(url.toString())
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`YouTube API error: ${res.status} - ${text}`)
    }

    const data = await res.json()
    pages++

    const pageVideos: ChannelVideo[] = []
    for (const item of data.items ?? []) {
      if (limit !== undefined && videos.length + pageVideos.length >= limit) break
      const snippet = item.snippet
      const videoId = snippet?.resourceId?.videoId
      // Private and deleted uploads still occupy a playlist slot but carry no
      // usable id — skipping them keeps a null out of the unique key.
      if (!videoId) continue

      pageVideos.push({
        videoId,
        title: snippet.title,
        thumbnailUrl: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || '',
        publishedAt: snippet.publishedAt,
      })
    }
    videos.push(...pageVideos)

    await onProgress?.(videos.length, pages, pageVideos)

    pageToken = data.nextPageToken

    // Reaching the requested number is the normal way a limited sync ends — not a cap.
    if (limit !== undefined && videos.length >= limit) break

    if (videos.length >= MAX_SYNC_VIDEOS || pages >= MAX_SYNC_PAGES) {
      if (pageToken) {
        hitCap = true
        console.warn(
          `Channel sync cap reached for ${channelUrlOrHandle}: ${videos.length} videos over ${pages} pages, ` +
          `and YouTube still returned a nextPageToken. This channel has more history than the cap allows — ` +
          `raise MAX_SYNC_VIDEOS / MAX_SYNC_PAGES if this is a real channel rather than a runaway response.`
        )
      }
      break
    }
  } while (pageToken)

  return { videos, pages, hitCap }
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

/**
 * YouTube returns every statistic as a STRING ("1234"), and omits fields entirely
 * when a channel hides them — subscriberCount is absent whenever the creator has
 * turned off the public subscriber count. Number(undefined) is NaN, which would be
 * written to a bigint column as null-or-garbage, so parse defensively and return
 * null for anything missing or non-numeric rather than coercing it to 0. A real
 * zero and "not published" are different facts and must not collapse together.
 */
function parseCount(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * Public channel statistics via channels.list?part=statistics. Uses the same API
 * key as the rest of the integration — no OAuth, because these figures are public.
 */
export async function fetchChannelStats(channelUrlOrHandle: string): Promise<ChannelStats> {
  const channelInput = resolveChannelInput(channelUrlOrHandle)
  if (!channelInput) {
    throw new Error('Invalid YouTube channel URL or handle')
  }

  const url = new URL(`${YOUTUBE_API_BASE}/channels`)
  // snippet added for creation date and country. Still one channels.list call and
  // still 1 quota unit — the part list does not change the cost.
  url.searchParams.set('part', 'statistics,snippet')
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
  const stats = data.items?.[0]?.statistics
  if (!stats) {
    throw new Error('Channel not found')
  }
  const snippet = data.items?.[0]?.snippet ?? {}

  return {
    subscriberCount: parseCount(stats.subscriberCount),
    viewCount: parseCount(stats.viewCount),
    videoCount: parseCount(stats.videoCount),
    createdAt: (snippet.publishedAt as string | undefined) ?? null,
    // Self-declared by the owner in YouTube settings; frequently absent.
    country: (snippet.country as string | undefined) ?? null,
  }
}
