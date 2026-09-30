import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchChannelStats } from '@/lib/youtube-channel'
import { logError, logInfo } from '@/lib/logger'

/**
 * Phase 5 of the Audience Profiles concept — lazy, on-demand enrichment of a
 * commenter's OWN channel via YouTube's channels.list (Tier B: bio, subscriber
 * count, video count, channel age). Deliberately never run in bulk or during
 * ingestion: this spends real API quota per person, so it only happens when a
 * creator opens that one person's profile and explicitly asks for it.
 *
 * This can never reveal a real name, email, or location — YouTube's public API
 * simply doesn't expose those, whatever's asked for. What it adds is what that
 * person has themselves published on their own channel.
 */

/** Re-checking a channel's subscriber count every page view would burn quota for
 *  a number that barely moves day to day. 30 days keeps it roughly current while
 *  making repeat profile views free. */
const STALE_ENRICHMENT_MS = 30 * 24 * 60 * 60 * 1000

export type EnrichmentResult = {
  success: boolean
  /** True when a fresh channels.list call was actually made this call. */
  fetched: boolean
  reason?: 'not_found' | 'no_channel_id' | 'fetch_failed'
}

/**
 * Fetches and caches one commenter's public channel stats, unless a cached copy
 * from within the last 30 days already exists — in which case this is a no-op
 * that costs no quota. A failed fetch (channel deleted, suspended, or otherwise
 * unreachable) still stamps channel_enriched_at, so a dead channel doesn't retry
 * on every single profile view either.
 */
export async function enrichAudienceMember(
  supabase: SupabaseClient,
  memberId: string,
  creatorId: string,
  options: { force?: boolean } = {}
): Promise<EnrichmentResult> {
  const { data: member, error } = await supabase
    .from('audience_members')
    .select('id, external_id, channel_enriched_at')
    .eq('id', memberId)
    .eq('creator_id', creatorId)
    .maybeSingle()

  if (error) {
    logError('audience-enrichment.enrichAudienceMember', error, { member_id: memberId, stage: 'fetch_member' })
    return { success: false, fetched: false, reason: 'not_found' }
  }
  if (!member) return { success: false, fetched: false, reason: 'not_found' }

  const enrichedAt = member.channel_enriched_at as string | null
  const stale = !enrichedAt || Date.now() - new Date(enrichedAt).getTime() > STALE_ENRICHMENT_MS
  if (!options.force && !stale) {
    return { success: true, fetched: false }
  }

  const channelId = member.external_id as string | null
  if (!channelId) {
    return { success: false, fetched: false, reason: 'no_channel_id' }
  }

  try {
    const stats = await fetchChannelStats(channelId)
    const { error: updateError } = await supabase
      .from('audience_members')
      .update({
        channel_bio: stats.description,
        channel_subscriber_count: stats.subscriberCount,
        channel_video_count: stats.videoCount,
        channel_created_at: stats.createdAt,
        channel_enriched_at: new Date().toISOString(),
      })
      .eq('id', memberId)

    if (updateError) {
      logError('audience-enrichment.enrichAudienceMember', updateError, { member_id: memberId, stage: 'write_enrichment' })
      return { success: false, fetched: false, reason: 'fetch_failed' }
    }

    return { success: true, fetched: true }
  } catch (err) {
    // Most commonly: the commenter's channel was deleted/suspended since they
    // commented. Stamped as "tried" anyway so this doesn't get retried on every
    // page view for someone whose channel no longer exists.
    logInfo('audience-enrichment.enrichAudienceMember', 'Channel enrichment fetch failed', {
      member_id: memberId,
      reason: err instanceof Error ? err.message : String(err),
    })
    await supabase.from('audience_members').update({ channel_enriched_at: new Date().toISOString() }).eq('id', memberId)
    return { success: false, fetched: false, reason: 'fetch_failed' }
  }
}
