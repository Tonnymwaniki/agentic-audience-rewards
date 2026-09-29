import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { refreshChannelStats } from '@/lib/channel-stats'
import { syncChannelVideos } from '@/lib/channel-videos'
import { isValidVideoLimit, MAX_VIDEOS_PER_SYNC } from '@/lib/channel-sync-limits'
import type { ChannelVideo } from '@/lib/youtube-channel'
import { logError } from '@/lib/logger'

/** A minimal shape check on the client-supplied video list — not a full parse,
 * just enough to reject garbage before it reaches storage. */
function isValidVideoList(value: unknown): value is ChannelVideo[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= MAX_VIDEOS_PER_SYNC &&
    value.every(
      v =>
        v &&
        typeof v === 'object' &&
        typeof (v as { videoId?: unknown }).videoId === 'string' &&
        (v as { videoId: string }).videoId.length > 0 &&
        typeof (v as { title?: unknown }).title === 'string'
    )
  )
}

/**
 * Connects a channel and brings videos into My Videos — metadata only. No
 * comments are ingested and no analysis runs here; that happens later, per
 * video, when the creator chooses to analyze one.
 *
 * Accepts either `video_limit` (bring in the N most recent) or `videos` (bring
 * in exactly this set, as selected from the comment-count picker on Connect).
 */
export async function POST(request: NextRequest) {
  try {
    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response
    const { supabase, creatorId } = authResult.auth

    const { channel_url, video_limit, videos } = await request.json()
    const channelUrl = typeof channel_url === 'string' ? channel_url.trim() : ''

    if (!channelUrl) {
      return NextResponse.json({ error: 'Missing channel_url' }, { status: 400 })
    }

    const hasVideoList = videos !== undefined
    // Enforced here as well as on the page: a request can be sent without the page.
    if (hasVideoList) {
      if (!isValidVideoList(videos)) {
        return NextResponse.json(
          { error: `videos must be a list of 1 to ${MAX_VIDEOS_PER_SYNC} videos, each with a videoId and title` },
          { status: 400 }
        )
      }
    } else if (!isValidVideoLimit(video_limit)) {
      return NextResponse.json(
        { error: `video_limit must be a whole number from 1 to ${MAX_VIDEOS_PER_SYNC}` },
        { status: 400 }
      )
    }

    const { error: updateError } = await supabase
      .from('creators')
      .update({ channel_url: channelUrl })
      .eq('id', creatorId)

    if (updateError) {
      logError('api/creator/channel', updateError, { creator_id: creatorId, stage: 'update_channel_url' })
      return NextResponse.json({ error: 'Failed to save channel URL' }, { status: 500 })
    }

    // Deliberately after the URL has been saved, and deliberately non-fatal: a
    // statistics hiccup must not make connecting a channel look like it failed.
    const statsResult = await refreshChannelStats(supabase, creatorId, channelUrl)

    // Marked before the response so the client never polls a stale status from a
    // previous sync and concludes this one already finished.
    await supabase
      .from('creators')
      .update({ channel_sync_status: 'syncing', channel_videos_synced_count: 0 })
      .eq('id', creatorId)

    // Reused for every video this sync stores, so channel_videos rows can be
    // grouped in My Videos without a second YouTube lookup. Null when the stats
    // call itself failed — rows still land, just ungrouped, rather than losing
    // the whole sync over a label.
    const channelId = statsResult.success ? statsResult.stats.channelId : null
    const channelTitle = statsResult.success ? statsResult.stats.channelTitle : null

    // Detached, so the creator watches numbered progress instead of a spinner on a
    // held-open request. Progress is polled from /api/creator/channel/sync-status.
    after(async () => {
      try {
        await syncChannelVideos(
          supabase,
          creatorId,
          channelUrl,
          { ...(hasVideoList ? { videos } : { limit: video_limit }), channelId, channelTitle }
        )
      } catch (err) {
        logError('api/creator/channel', err, { creator_id: creatorId, stage: 'background_sync' })
        await supabase.from('creators').update({ channel_sync_status: 'error' }).eq('id', creatorId)
      }
    })

    return NextResponse.json({
      success: true,
      stats: statsResult.success ? statsResult.stats : null,
      statsError: statsResult.success ? null : statsResult.error,
      syncStarted: true,
      videoLimit: hasVideoList ? videos.length : video_limit,
    })
  } catch (err) {
    logError('api/creator/channel', err, { stage: 'request' })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
