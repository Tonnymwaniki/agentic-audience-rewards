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

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { supabase, creator } = await getAuthedSupabaseAndCreator()

  if (!creator) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { error } = await supabase
    .from('notifications')
    .update({ read: true })
    .eq('id', id)
    .eq('creator_id', creator.id)

  if (error) {
    console.error('Mark notification read error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
    return NextResponse.json({ error: 'Failed to update notification' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
