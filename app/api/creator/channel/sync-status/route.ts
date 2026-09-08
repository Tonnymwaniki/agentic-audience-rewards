import { NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

/**
 * Polled by the connect UI while a background channel sync runs.
 *
 * Mirrors the analyze flow's status endpoint: the work happens in an after()
 * callback, and the client reads progress from columns rather than holding a
 * connection open.
 */
export async function GET() {
  try {
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { cookies: { getAll: () => cookieStore.getAll(), setAll() {} } }
    )

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { data: creator, error } = await supabase
      .from('creators')
      .select('channel_sync_status, channel_videos_synced_count, channel_sync_hit_cap, last_channel_check_at')
      .eq('user_id', user.id)
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
