import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

async function getAuthedSupabaseAndCreator() {
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
    return { supabase, creator: null }
  }

  const { data: creator } = await supabase
    .from('creators')
    .select('id')
    .eq('user_id', user.id)
    .single()

  return { supabase, creator }
}

export async function GET(request: NextRequest) {
  const postId = request.nextUrl.searchParams.get('post_id')

  if (!postId) {
    return NextResponse.json({ error: 'Missing post_id' }, { status: 400 })
  }

  const { supabase, creator } = await getAuthedSupabaseAndCreator()

  if (!creator) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { data: tracked } = await supabase
    .from('tracked_videos')
    .select('polling_enabled')
    .eq('creator_id', creator.id)
    .eq('post_id', postId)
    .maybeSingle()

  return NextResponse.json({ polling_enabled: tracked?.polling_enabled ?? false })
}

export async function POST(request: NextRequest) {
  try {
    const { post_id, polling_enabled } = await request.json()

    if (!post_id || typeof polling_enabled !== 'boolean') {
      return NextResponse.json(
        { error: 'Missing post_id or polling_enabled' },
        { status: 400 }
      )
    }

    const { supabase, creator } = await getAuthedSupabaseAndCreator()

    if (!creator) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { data: post, error: postError } = await supabase
      .from('posts')
      .select('id')
      .eq('id', post_id)
      .eq('creator_id', creator.id)
      .single()

    if (postError || !post) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 })
    }

    const { data: existing } = await supabase
      .from('tracked_videos')
      .select('id')
      .eq('creator_id', creator.id)
      .eq('post_id', post_id)
      .maybeSingle()

    if (existing) {
      // Only flip the flag — leave last_checked_at alone so re-enabling
      // doesn't reset the cron's "already checked recently" window.
      const { error: updateError } = await supabase
        .from('tracked_videos')
        .update({ polling_enabled })
        .eq('id', existing.id)

      if (updateError) {
        console.error('Update tracked_videos error:', JSON.stringify(updateError, Object.getOwnPropertyNames(updateError), 2))
        return NextResponse.json({ error: 'Failed to update tracking' }, { status: 500 })
      }
    } else {
      const { error: insertError } = await supabase
        .from('tracked_videos')
        .insert({ creator_id: creator.id, post_id, polling_enabled })

      if (insertError) {
        console.error('Insert tracked_videos error:', JSON.stringify(insertError, Object.getOwnPropertyNames(insertError), 2))
        return NextResponse.json({ error: 'Failed to save tracking' }, { status: 500 })
      }
    }

    return NextResponse.json({ success: true, polling_enabled })
  } catch (err) {
    console.error('Tracked videos error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
