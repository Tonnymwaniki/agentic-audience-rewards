import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllChannelVideos, type ChannelVideo } from '@/lib/youtube-channel'
import { logError } from '@/lib/logger'

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

function toRow(
  creatorId: string,
  video: ChannelVideo,
  channelId: string | null,
  channelTitle: string | null
) {
  return {
    creator_id: creatorId,
    video_id: video.videoId,
    title: video.title,
    thumbnail_url: video.thumbnailUrl || null,
    published_at: video.publishedAt || null,
    // Stamped once per sync (see channelId/channelTitle below) rather than looked
    // up per video — every video in one sync belongs to the same channel.
    channel_id: channelId,
    channel_title: channelTitle,
  }
}

export type SyncOptions = {
  /**
   * Bring in at most this many videos, newest first. Used when the creator picked
   * a quantity rather than specific videos; omit it to walk the whole channel.
   */
  limit?: number
  /**
   * Bring in exactly these videos — already fetched by the picker preview, so no
   * further YouTube calls are needed here. Takes priority over `limit` when both
   * are present, since a specific selection is a stronger instruction than a count.
   */
  videos?: ChannelVideo[]
  /**
   * This channel's own id/display name, for grouping in My Videos — the caller
   * already has these from its own channel-stats lookup (Connect fetches stats
   * right before starting a sync), so this avoids a second YouTube call for
   * something the sync would otherwise have to look up itself. Null when the
   * caller couldn't get stats (e.g. YouTube hiccup); rows just land ungrouped
   * rather than failing the sync over a label.
   */
  channelId?: string | null
  channelTitle?: string | null
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
  const channelId = options.channelId ?? null
  const channelTitle = options.channelTitle ?? null

  // Columns added by migration 51. Same self-healing pattern as ingest.ts's
  // optionalPostColumns: a deploy can land before the migration has been run
  // against a given database, and a sync failing outright over a missing label
  // column would be a much worse outcome than just syncing without it once.
  const channelColumnsAvailable = { channel_id: true, channel_title: true }

  // Shared by both paths below: writes one chunk of already-known videos and
  // advances the progress counter the Connect page polls.
  const storeChunk = async (pageVideos: ChannelVideo[]) => {
    for (let i = 0; i < pageVideos.length; i += STORE_CHUNK) {
      const rows = pageVideos.slice(i, i + STORE_CHUNK).map(v => toRow(creatorId, v, channelId, channelTitle))

      for (;;) {
        const chunk = rows.map(row => {
          const r: Record<string, unknown> = { ...row }
          if (!channelColumnsAvailable.channel_id) delete r.channel_id
          if (!channelColumnsAvailable.channel_title) delete r.channel_title
          return r
        })

        const { error } = await supabase
          .from('channel_videos')
          // post_id is deliberately absent from the payload, so bringing in a
          // video that was already analyzed refreshes its title and thumbnail
          // without clearing the link to its analysis.
          .upsert(chunk, { onConflict: 'creator_id,video_id' })

        if (!error) break

        const missing = (['channel_id', 'channel_title'] as const).find(
          c => (error.code === 'PGRST204' || error.code === '42703') && (error.message ?? '').includes(c) && channelColumnsAvailable[c]
        )
        if (!missing) {
          throw new Error(`Failed to store channel videos: ${error.message}`)
        }
        channelColumnsAvailable[missing] = false
        console.warn(`channel_videos.${missing} does not exist yet; syncing without it (run the pending migration)`)
      }

      stored += rows.length
      await supabase.from('creators').update({ channel_videos_synced_count: stored }).eq('id', creatorId)
    }
  }

  try {
    // A specific selection (from the comment-count picker) skips YouTube entirely —
    // the preview call already fetched this metadata, so there is nothing left to
    // walk or paginate.
    const result = options.videos
      ? await (async () => {
          await storeChunk(options.videos!)
          return { videos: options.videos!, pages: 0, hitCap: false }
        })()
      : await fetchAllChannelVideos(
          channelUrl,
          async (_found, _pages, pageVideos) => { await storeChunk(pageVideos) },
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
    logError('channelVideos.sync', err, { creator_id: creatorId })
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
    logError('channelVideos.linkToPost', error, { creator_id: creatorId, video_id: videoId, post_id: postId })
  }
}
