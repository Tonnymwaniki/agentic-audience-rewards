import { NextRequest, NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { createServiceClient } from '@/lib/supabase/service'

// Delegates to requireCreator(), which authenticates with a cookie-bound client
// and hands back a genuine service-role client for data access. Building one
// client from the service key AND the cookies — as this used to — yields a client
// that runs as the signed-in user once a session exists, so RLS silently drops
// every write.
async function getAuthedSupabaseAndCreator() {
  const authResult = await requireCreator()

  if (!authResult.ok) {
    return { supabase: createServiceClient(), creator: null }
  }

  return { supabase: authResult.auth.supabase, creator: { id: authResult.auth.creatorId } }
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
