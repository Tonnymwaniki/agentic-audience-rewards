import { NextRequest, NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { fetchChannelStats, fetchChannelVideosWithCommentCounts } from '@/lib/youtube-channel'
import { MAX_VIDEOS_PER_SYNC } from '@/lib/channel-sync-limits'
import { logError } from '@/lib/logger'

/**
 * The heavier second step of Connect: not just "how many videos", but the
 * videos themselves, newest first, each carrying its public comment count —
 * so a creator can see which ones actually have something to read and choose
 * exactly which to bring in, instead of guessing from "last N by date".
 *
 * Scans at most MAX_VIDEOS_PER_SYNC of the channel's most recent videos — the
 * same cap a sync itself enforces, so this never shows more than a creator
 * could actually bring in this session. Still read-only: nothing is saved.
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
    const scanLimit = Math.min(videoCount, MAX_VIDEOS_PER_SYNC)

    if (scanLimit === 0) {
      return NextResponse.json({
        videoCount: 0,
        videos: [],
        withComments: 0,
        withoutComments: 0,
        totalComments: 0,
        truncated: false,
      })
    }

    const { videos } = await fetchChannelVideosWithCommentCounts(channelUrl, scanLimit)

    const withComments = videos.filter(v => (v.commentCount ?? 0) > 0).length
    const totalComments = videos.reduce((sum, v) => sum + (v.commentCount ?? 0), 0)

    return NextResponse.json({
      videoCount,
      videos,
      withComments,
      withoutComments: videos.length - withComments,
      totalComments,
      // The channel has more videos than we scanned — this is its most recent slice.
      truncated: videoCount > videos.length,
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
    logError('api/creator/channel/videos-preview', err, { stage: 'fetch_from_youtube' })
    return NextResponse.json({ error: "Couldn't reach YouTube just now. Please try again." }, { status: 502 })
  }
}
