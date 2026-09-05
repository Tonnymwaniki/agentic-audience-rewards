import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function GET(request: NextRequest) {
  try {
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
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { data: creator } = await supabase
      .from('creators')
      .select('id')
      .eq('user_id', user.id)
      .single()

    if (!creator) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { data: posts, error } = await supabase
      .from('posts')
      .select('external_post_id')
      .eq('creator_id', creator.id)

    if (error) {
      console.error('Analyzed videos fetch error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
      return NextResponse.json({ error: 'Failed to fetch analyzed videos' }, { status: 500 })
    }

    return NextResponse.json({ videoIds: (posts || []).map(p => p.external_post_id) })
  } catch (err) {
    console.error('Analyzed videos error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
