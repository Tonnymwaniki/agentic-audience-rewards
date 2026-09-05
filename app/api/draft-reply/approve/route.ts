import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function POST(request: NextRequest) {
  try {
    const { comment_id } = await request.json()

    if (!comment_id) {
      return NextResponse.json({ error: 'Missing comment_id' }, { status: 400 })
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
      .single()

    if (!creator) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    // Confirm the comment belongs to one of this creator's posts before touching it.
    const { data: comment, error: commentError } = await supabase
      .from('comments')
      .select('id, posts (creator_id)')
      .eq('id', comment_id)
      .single()

    const ownerCreatorId = (comment?.posts as unknown as { creator_id: string } | null)?.creator_id

    if (commentError || !comment || ownerCreatorId !== creator.id) {
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
    }

    const { error: updateError } = await supabase
      .from('comment_categories')
      .update({ draft_reply_approved_at: new Date().toISOString() })
      .eq('comment_id', comment_id)

    if (updateError) {
      console.error('Approve draft reply error:', JSON.stringify(updateError, Object.getOwnPropertyNames(updateError), 2))
      return NextResponse.json({ error: 'Failed to approve draft reply' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Approve draft reply error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
