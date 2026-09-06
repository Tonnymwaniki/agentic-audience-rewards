import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { regenerateDraftsForCreator } from '@/lib/draft-regeneration'

// Each comment can cost two sequential Claude calls, so this needs far more room
// than a normal request. Vercel Hobby caps this at 60s, Pro at 300s — the
// MAX_REGENERATIONS_PER_RUN cap in lib/draft-regeneration.ts is what keeps a run
// bounded enough to finish inside it.
export const maxDuration = 300

export async function POST(request: NextRequest) {
  try {
    const { post_id } = await request.json()

    if (!post_id) {
      return NextResponse.json({ error: 'Missing post_id' }, { status: 400 })
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
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { data: creator } = await supabase
      .from('creators')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (!creator) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    // Confirm the post belongs to this creator before regenerating anything on it.
    const { data: post } = await supabase
      .from('posts')
      .select('id')
      .eq('id', post_id)
      .eq('creator_id', creator.id)
      .maybeSingle()

    if (!post) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }

    const result = await regenerateDraftsForCreator(creator.id, post_id)

    return NextResponse.json(result)
  } catch (err) {
    console.error('Regenerate all drafts error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json({ error: 'Failed to regenerate drafts' }, { status: 500 })
  }
}
