import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllChannelVideos, type ChannelVideo } from '@/lib/youtube-channel'

export type SyncResult =
  | { success: true; discovered: number; pages: number; hitCap: boolean }
  | { success: false; error: string }

/**
 * Rows are written in small chunks, each followed by a progress update, so the
 * number the Connect page shows ("Bringing video 30 of 50") counts videos that are
 * already in My Videos — not videos merely fetched. Small enough for the count to
 * move visibly during a sync, large enough to keep the database round trips few.
 */
const STORE_CHUNK = 10

function toRow(creatorId: string, video: ChannelVideo) {
  return {
    creator_id: creatorId,
    video_id: video.videoId,
    title: video.title,
    thumbnail_url: video.thumbnailUrl || null,
    published_at: video.publishedAt || null,
  }
}

export type SyncOptions = {
  /**
   * Bring in at most this many videos, newest first. The Connect flow always
   * passes one (the creator's chosen number); omit it to walk the whole channel.
   */
  limit?: number
}

/**
 * Brings a channel's videos into My Videos as channel_videos rows — metadata only
 * (video id, title, thumbnail, publish date).
 *
 * This is deliberately the whole job. Nothing here ingests comments, categorises,
 * calls an AI model or creates a post: every video lands unanalyzed, and analysing
 * one is a separate action the creator takes later from My Videos.
 *
 * Intended to run in the background (the connect route's after() call). Progress
 * is written to creators.channel_videos_synced_count as rows are stored, and
 * creators.channel_sync_status moves syncing -> done | error.
 *
 * Never throws. On failure the status becomes 'error'; videos already stored stay.
 */
export async function syncChannelVideos(
  supabase: SupabaseClient,
  creatorId: string,
  channelUrl: string,
  options: SyncOptions = {}
): Promise<SyncResult> {
  await supabase
    .from('creators')
    .update({ channel_sync_status: 'syncing', channel_videos_synced_count: 0, channel_sync_hit_cap: false })
    .eq('id', creatorId)

  let stored = 0

  try {
    const result = await fetchAllChannelVideos(
      channelUrl,
      async (_found, _pages, pageVideos) => {
        for (let i = 0; i < pageVideos.length; i += STORE_CHUNK) {
          const chunk = pageVideos.slice(i, i + STORE_CHUNK).map(v => toRow(creatorId, v))
          const { error } = await supabase
            .from('channel_videos')
            // post_id is deliberately absent from the payload, so bringing in a
            // video that was already analyzed refreshes its title and thumbnail
            // without clearing the link to its analysis.
            .upsert(chunk, { onConflict: 'creator_id,video_id' })
          if (error) {
            throw new Error(`Failed to store channel videos: ${error.message}`)
          }
          stored += chunk.length
          await supabase.from('creators').update({ channel_videos_synced_count: stored }).eq('id', creatorId)
        }
      },
      { limit: options.limit }
    )

    await supabase
      .from('creators')
      .update({
        channel_sync_status: 'done',
        channel_videos_synced_count: stored,
        channel_sync_hit_cap: result.hitCap,
        last_channel_check_at: new Date().toISOString(),
      })
      .eq('id', creatorId)

    if (result.hitCap) {
      console.warn(
        `Channel sync for creator ${creatorId} stopped at the safety cap with ${stored} videos stored. ` +
        `Raise MAX_SYNC_VIDEOS / MAX_SYNC_PAGES if this channel genuinely has more history.`
      )
    }

    return { success: true, discovered: stored, pages: result.pages, hitCap: result.hitCap }
  } catch (err) {
    console.error('Channel videos sync error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    await supabase
      .from('creators')
      .update({ channel_sync_status: 'error', channel_videos_synced_count: stored })
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
