import { NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'

/**
 * Polled by the connect UI while a background channel sync runs.
 *
 * Mirrors the analyze flow's status endpoint: the work happens in an after()
 * callback, and the client reads progress from columns rather than holding a
 * connection open.
 */
export async function GET() {
  try {
    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response
    const { supabase, creatorId } = authResult.auth

    const { data: creator, error } = await supabase
      .from('creators')
      .select('channel_sync_status, channel_videos_synced_count, channel_sync_hit_cap, last_channel_check_at')
      .eq('id', creatorId)
      .maybeSingle()

    if (error || !creator) {
      return NextResponse.json({ error: 'Creator not found' }, { status: 404 })
    }

    return NextResponse.json({
      status: creator.channel_sync_status ?? 'idle',
      videosSynced: creator.channel_videos_synced_count ?? 0,
      hitCap: Boolean(creator.channel_sync_hit_cap),
      lastCheckedAt: creator.last_channel_check_at,
    })
  } catch (err) {
    console.error('Channel sync status error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
