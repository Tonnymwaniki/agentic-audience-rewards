import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { refreshChannelStats } from '@/lib/channel-stats'
import { syncChannelVideos } from '@/lib/channel-videos'
import { isValidVideoLimit, MAX_VIDEOS_PER_SYNC } from '@/lib/channel-sync-limits'

/**
 * Connects a channel and brings `video_limit` of its most recent videos into My
 * Videos — metadata only. No comments are ingested and no analysis runs here;
 * that happens later, per video, when the creator chooses to analyze one.
 */
export async function POST(request: NextRequest) {
  try {
    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response
    const { supabase, creatorId } = authResult.auth

    const { channel_url, video_limit } = await request.json()
    const channelUrl = typeof channel_url === 'string' ? channel_url.trim() : ''

    if (!channelUrl) {
      return NextResponse.json({ error: 'Missing channel_url' }, { status: 400 })
    }
    // Enforced here as well as on the page: a request can be sent without the page.
    if (!isValidVideoLimit(video_limit)) {
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
      console.error('Update channel_url error:', JSON.stringify(updateError, Object.getOwnPropertyNames(updateError), 2))
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

    // Detached, so the creator watches numbered progress instead of a spinner on a
    // held-open request. Progress is polled from /api/creator/channel/sync-status.
    after(async () => {
      try {
        await syncChannelVideos(supabase, creatorId, channelUrl, { limit: video_limit })
      } catch (err) {
        console.error('Background channel sync crash:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
        await supabase.from('creators').update({ channel_sync_status: 'error' }).eq('id', creatorId)
      }
    })

    return NextResponse.json({
      success: true,
      stats: statsResult.success ? statsResult.stats : null,
      statsError: statsResult.success ? null : statsResult.error,
      syncStarted: true,
      videoLimit: video_limit,
    })
  } catch (err) {
    console.error('Save channel URL error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
