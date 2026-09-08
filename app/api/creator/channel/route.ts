import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { refreshChannelStats } from '@/lib/channel-stats'
import { syncChannelVideos } from '@/lib/channel-videos'

export async function POST(request: NextRequest) {
  try {
    const { channel_url } = await request.json()

    if (!channel_url || !channel_url.trim()) {
      return NextResponse.json(
        { error: 'Missing channel_url' },
        { status: 400 }
      )
    }

    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll() {},
        },
      }
    )

    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      )
    }

    const { data: creator, error: creatorError } = await supabase
      .from('creators')
      .select('id')
      .eq('user_id', user.id)
      .single()

    if (creatorError || !creator) {
      return NextResponse.json(
        { error: 'Creator not found' },
        { status: 404 }
      )
    }

    const { error: updateError } = await supabase
      .from('creators')
      .update({ channel_url: channel_url.trim() })
      .eq('id', creator.id)

    if (updateError) {
      console.error('Update channel_url error:', JSON.stringify(updateError, Object.getOwnPropertyNames(updateError), 2))
      return NextResponse.json(
        { error: 'Failed to save channel URL' },
        { status: 500 }
      )
    }

    // Deliberately after the URL has been saved, and deliberately non-fatal: a
    // statistics hiccup must not make connecting a channel look like it failed.
    // The response reports whether stats came through so the UI can say so.
    const statsResult = await refreshChannelStats(supabase, creator.id, channel_url.trim())

    // Marked before the response so the client never polls a stale 'idle' and
    // concludes nothing is happening.
    await supabase
      .from('creators')
      .update({ channel_sync_status: 'syncing', channel_videos_synced_count: 0 })
      .eq('id', creator.id)

    // Detached: a full-history sync is ~24 sequential YouTube calls and 11s for a
    // 1157-video channel, which must not sit inside a request the user is waiting
    // on. Same after() pattern the analyze flow already uses. Progress is polled
    // from creators.channel_sync_status / channel_videos_synced_count.
    after(async () => {
      try {
        await syncChannelVideos(supabase, creator.id, channel_url.trim())
      } catch (err) {
        console.error('Background channel sync crash:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
        await supabase.from('creators').update({ channel_sync_status: 'error' }).eq('id', creator.id)
      }
    })

    return NextResponse.json({
      success: true,
      stats: statsResult.success ? statsResult.stats : null,
      statsError: statsResult.success ? null : statsResult.error,
      // The sync is still running; the client polls for the count.
      syncStarted: true,
    })
  } catch (err) {
    console.error('Save channel URL error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json(
      { error: 'Internal error' },
      { status: 500 }
    )
  }
}
