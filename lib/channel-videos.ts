import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllChannelVideos, type ChannelVideo } from '@/lib/youtube-channel'

export type SyncResult =
  | { success: true; discovered: number; pages: number; hitCap: boolean }
  | { success: false; error: string }

/** Supabase rejects very large payloads, so pages are written in chunks. */
const UPSERT_CHUNK = 500

async function storeVideos(
  supabase: SupabaseClient,
  creatorId: string,
  videos: ChannelVideo[]
): Promise<boolean> {
  const rows = videos.map(video => ({
    creator_id: creatorId,
    video_id: video.videoId,
    title: video.title,
    thumbnail_url: video.thumbnailUrl || null,
    published_at: video.publishedAt || null,
  }))

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const { error } = await supabase
      .from('channel_videos')
      // post_id is deliberately absent from the payload, so re-syncing a channel
      // refreshes titles and thumbnails without clearing the link on videos that
      // have already been analyzed.
      .upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: 'creator_id,video_id' })

    if (error) {
      console.error('Channel videos upsert error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
      return false
    }
  }
  return true
}

/**
 * Walks the channel's ENTIRE upload history and records every video.
 *
 * Intended to run in the background (see the connect route's after() call): a
 * 1157-video channel takes ~11s and 24 API calls, which is fine detached but not
 * inside a request the user is waiting on.
 *
 * Rows are written page by page rather than all at the end, so progress is real —
 * the count the UI polls reflects rows actually stored, not rows merely fetched.
 *
 * Never throws. Status is moved to 'error' and the caller's flow is unaffected.
 */
export async function syncChannelVideos(
  supabase: SupabaseClient,
  creatorId: string,
  channelUrl: string
): Promise<SyncResult> {
  await supabase
    .from('creators')
    .update({ channel_sync_status: 'syncing', channel_videos_synced_count: 0, channel_sync_hit_cap: false })
    .eq('id', creatorId)

  let found = 0

  try {
    // Progress is reported from the FETCH loop, because that is the slow part: a
    // 1157-video channel spends ~11s paginating and under a second storing. The
    // count the UI polls is therefore "videos found so far", which is what a
    // creator watching a progress line actually wants to see move.
    const result = await fetchAllChannelVideos(channelUrl, async videosFound => {
      found = videosFound
      await supabase
        .from('creators')
        .update({ channel_videos_synced_count: videosFound })
        .eq('id', creatorId)
    })

    const ok = await storeVideos(supabase, creatorId, result.videos)
    if (!ok) {
      await supabase
        .from('creators')
        .update({ channel_sync_status: 'error', channel_videos_synced_count: found })
        .eq('id', creatorId)
      return { success: false, error: 'Failed to store channel videos' }
    }

    await supabase
      .from('creators')
      .update({
        channel_sync_status: 'done',
        channel_videos_synced_count: result.videos.length,
        channel_sync_hit_cap: result.hitCap,
        last_channel_check_at: new Date().toISOString(),
      })
      .eq('id', creatorId)

    if (result.hitCap) {
      console.warn(
        `Channel sync for creator ${creatorId} stopped at the safety cap with ${result.videos.length} videos stored. ` +
        `Raise MAX_SYNC_VIDEOS / MAX_SYNC_PAGES if this channel genuinely has more history.`
      )
    }

    return { success: true, discovered: result.videos.length, pages: result.pages, hitCap: result.hitCap }
  } catch (err) {
    console.error('Channel videos sync error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    await supabase
      .from('creators')
      .update({ channel_sync_status: 'error', channel_videos_synced_count: found })
      .eq('id', creatorId)
    return { success: false, error: err instanceof Error ? err.message : 'Failed to sync channel videos' }
  }
}

/**
 * Links a channel_videos row to the post produced by analyzing that video.
 *
 * Upserts rather than updates, because a video can reach ingestion without ever
 * having been discovered through a channel connect — pasting a single video link
 * is a supported path, and that video should still appear in the lightweight index
 * rather than being invisible to it.
 *
 * Best-effort: a failure here must never fail an ingestion that already succeeded.
 */
export async function linkChannelVideoToPost(
  supabase: SupabaseClient,
  creatorId: string,
  videoId: string,
  postId: string
): Promise<void> {
  const { error } = await supabase
    .from('channel_videos')
    .upsert(
      { creator_id: creatorId, video_id: videoId, post_id: postId },
      { onConflict: 'creator_id,video_id' }
    )

  if (error) {
    console.error('Channel video link error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
  }
}
