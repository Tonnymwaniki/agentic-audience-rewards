import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchChannelStats, type ChannelStats } from '@/lib/youtube-channel'
import { logError, logWarn } from '@/lib/logger'

export type RefreshResult =
  | { success: true; stats: ChannelStats }
  | { success: false; error: string }

/**
 * Fetches this channel's public statistics and stores them two ways:
 *
 *   - on the creators row, overwritten each time — "where the channel stands now"
 *   - appended to channel_stats_snapshots — "how it got there"
 *
 * Both are needed. The creators columns answer today's question cheaply without a
 * sort; the snapshot table is the only thing that can answer a growth question
 * later, and history can't be reconstructed after the fact if it was never written.
 *
 * Never throws. Connecting a channel must not fail because YouTube's statistics
 * endpoint had a bad minute — the channel URL is the thing that matters, and stats
 * refresh again on the next connect or poll.
 */
export async function refreshChannelStats(
  supabase: SupabaseClient,
  creatorId: string,
  channelUrl: string
): Promise<RefreshResult> {
  let stats: ChannelStats

  try {
    stats = await fetchChannelStats(channelUrl)
  } catch (err) {
    logError('channelStats.refresh', err, { stage: 'fetch_from_youtube' })
    return { success: false, error: err instanceof Error ? err.message : 'Failed to fetch channel stats' }
  }

  const baseUpdate = {
    subscriber_count: stats.subscriberCount,
    channel_view_count: stats.viewCount,
    channel_video_count: stats.videoCount,
    channel_stats_updated_at: new Date().toISOString(),
  }

  // Migration 37 columns. Tried first; on a database without them the write is
  // retried without, so a code deploy that lands before the migration still keeps
  // the core stats current instead of failing the whole refresh.
  let { error: updateError } = await supabase
    .from('creators')
    .update({ ...baseUpdate, channel_created_at: stats.createdAt, channel_country: stats.country })
    .eq('id', creatorId)

  if (updateError && (updateError.code === 'PGRST204' || updateError.code === '42703')) {
    logWarn('channelStats.refresh', 'Channel created/country columns missing (migration 37); writing core stats only', {
      creator_id: creatorId,
    })
    ;({ error: updateError } = await supabase.from('creators').update(baseUpdate).eq('id', creatorId))
  }

  if (updateError) {
    logError('channelStats.refresh', updateError, { stage: 'write_current_stats' })
    return { success: false, error: 'Failed to store channel stats' }
  }

  // A snapshot with nothing in it would be noise in the growth series, so only
  // record when YouTube actually published at least one of the two figures.
  if (stats.subscriberCount !== null || stats.viewCount !== null) {
    const { error: snapshotError } = await supabase.from('channel_stats_snapshots').insert({
      creator_id: creatorId,
      subscriber_count: stats.subscriberCount,
      channel_view_count: stats.viewCount,
    })

    if (snapshotError) {
      // The current-value write already succeeded; losing one history point is not
      // worth reporting the whole refresh as failed.
      logWarn('channelStats.refresh', 'History snapshot failed; current stats were still written', { stage: 'write_snapshot' })
    }
  }

  return { success: true, stats }
}
