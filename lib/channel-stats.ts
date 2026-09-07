import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchChannelStats, type ChannelStats } from '@/lib/youtube-channel'

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
    console.error('Channel stats fetch error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return { success: false, error: err instanceof Error ? err.message : 'Failed to fetch channel stats' }
  }

  const { error: updateError } = await supabase
    .from('creators')
    .update({
      subscriber_count: stats.subscriberCount,
      channel_view_count: stats.viewCount,
      channel_video_count: stats.videoCount,
      channel_stats_updated_at: new Date().toISOString(),
    })
    .eq('id', creatorId)

  if (updateError) {
    console.error('Channel stats update error:', JSON.stringify(updateError, Object.getOwnPropertyNames(updateError), 2))
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
      console.error('Channel stats snapshot error:', JSON.stringify(snapshotError, Object.getOwnPropertyNames(snapshotError), 2))
    }
  }

  return { success: true, stats }
}
