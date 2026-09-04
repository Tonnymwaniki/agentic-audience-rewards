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
