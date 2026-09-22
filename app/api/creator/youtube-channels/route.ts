import { NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { logError, logWarn } from '@/lib/logger'
import { fetchOwnedChannelsForCreator } from '@/lib/youtube-oauth'

export const dynamic = 'force-dynamic'

/**
 * The channels this creator has actually proven they own.
 *
 * Read through fetchOwnedChannelsForCreator, so the stored access token is
 * refreshed transparently if it has expired — this endpoint is hit right after a
 * redirect back from Google, but also on a later revisit, by which time the
 * one-hour token is long dead.
 *
 * Answers from Google each time rather than replaying the row we stored at
 * connect time: a creator who has since created or deleted a channel should see
 * the truth, and a grant revoked at Google should surface here as `revoked`
 * rather than as a stale list that no longer works.
 */
export async function GET() {
  const result = await requireCreator()
  if (!result.ok) return result.response

  const { supabase, creatorId } = result.auth

  const { data: grant, error } = await supabase
    .from('youtube_oauth_tokens')
    .select('channel_id, channel_title')
    .eq('creator_id', creatorId)
    .maybeSingle()

  if (error || !grant?.channel_id) {
    // Not an error: simply nobody has connected Google on this account yet.
    return NextResponse.json({ connected: false, channels: [] })
  }

  const channels = await fetchOwnedChannelsForCreator(supabase, creatorId, grant.channel_id)

  if (!channels.ok) {
    // `revoked` is the one the UI must act on: the grant is gone, so the account
    // is back to unverified and needs to reconnect rather than retry.
    const level = channels.reason === 'revoked' ? logWarn : logError
    level === logWarn
      ? logWarn('api/creator/youtube-channels', 'Grant no longer usable', {
          creator_id: creatorId, reason: channels.reason,
        })
      : logError('api/creator/youtube-channels', new Error(channels.error), {
          creator_id: creatorId, reason: channels.reason,
        })

    return NextResponse.json(
      { connected: false, revoked: channels.reason === 'revoked', channels: [], reason: channels.reason },
      { status: 200 }
    )
  }

  return NextResponse.json({
    connected: true,
    refreshed: channels.refreshed,
    channels: channels.channels.map(channel => ({
      id: channel.id,
      title: channel.title,
      customUrl: channel.customUrl,
      thumbnailUrl: channel.thumbnailUrl,
      // The form the existing preview/sync endpoints already accept, so selecting
      // a channel feeds straight into the flow that follows unchanged.
      channelUrl: `https://www.youtube.com/channel/${channel.id}`,
    })),
  })
}
