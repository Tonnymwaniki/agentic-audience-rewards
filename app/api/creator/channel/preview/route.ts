import { NextRequest, NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { fetchChannelStats } from '@/lib/youtube-channel'
import { DEFAULT_VIDEOS_TO_SYNC, MAX_VIDEOS_PER_SYNC } from '@/lib/channel-sync-limits'

/**
 * The quick first step of Connect: how many videos does this channel have?
 *
 * One YouTube channels.list call (1 quota unit) reading the channel's public
 * videoCount — not a pagination walk, which for a 1,157-video channel is 24 calls
 * and ~11s. Read-only: nothing is saved until the creator picks how many videos
 * to bring in, so looking at a channel and backing out leaves no trace.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireCreator()
  if (!authResult.ok) return authResult.response

  let channelUrl = ''
  try {
    const body = await request.json()
    channelUrl = typeof body.channel_url === 'string' ? body.channel_url.trim() : ''
  } catch {
    // fall through to the missing-url response
  }
  if (!channelUrl) {
    return NextResponse.json({ error: 'Missing channel_url' }, { status: 400 })
  }

  try {
    const stats = await fetchChannelStats(channelUrl)
    const videoCount = stats.videoCount ?? 0

    return NextResponse.json({
      videoCount,
      // The most the creator can choose this session, and a sensible starting value.
      maxSelectable: Math.min(videoCount, MAX_VIDEOS_PER_SYNC),
      suggested: Math.min(videoCount, DEFAULT_VIDEOS_TO_SYNC),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    if (message.includes('Invalid YouTube channel URL')) {
      return NextResponse.json(
        { error: "That doesn't look like a YouTube channel link. Try one like https://www.youtube.com/@yourchannel" },
        { status: 400 }
      )
    }
    if (message.includes('Channel not found')) {
      return NextResponse.json({ error: "We couldn't find that channel. Check the link and try again." }, { status: 404 })
    }
    console.error('Channel preview error:', message)
    return NextResponse.json({ error: "Couldn't reach YouTube just now. Please try again." }, { status: 502 })
  }
}
