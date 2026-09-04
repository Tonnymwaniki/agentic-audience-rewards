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
  const { supabase, creator } = await getAuthedSupabaseAndCreator()

  if (!creator) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { data: notifications, error } = await supabase
    .from('notifications')
    .select('id, type, message, read, created_at, comments (post_id)')
    .eq('creator_id', creator.id)
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) {
    console.error('Notifications fetch error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
    return NextResponse.json({ error: 'Failed to fetch notifications' }, { status: 500 })
  }

  const { count: unreadCount, error: countError } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('creator_id', creator.id)
    .eq('read', false)

  if (countError) {
    console.error('Notifications unread count error:', JSON.stringify(countError, Object.getOwnPropertyNames(countError), 2))
  }

  return NextResponse.json({
    notifications: (notifications || []).map(n => ({
      id: n.id,
      type: n.type,
      message: n.message,
      read: n.read,
      created_at: n.created_at,
      post_id: (n.comments as unknown as { post_id: string } | null)?.post_id || null,
    })),
    unreadCount: unreadCount || 0,
  })
}
