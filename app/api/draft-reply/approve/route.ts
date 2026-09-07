import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function POST(request: NextRequest) {
  try {
    const { comment_id, final_reply_text } = await request.json()

    if (!comment_id) {
      return NextResponse.json({ error: 'Missing comment_id' }, { status: 400 })
    }

    if (final_reply_text !== undefined && typeof final_reply_text !== 'string') {
      return NextResponse.json({ error: 'final_reply_text must be a string' }, { status: 400 })
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

    // Read the agent's original before writing, so "was this edited?" is decided
    // here by comparing against what's stored — never by trusting a flag from the
    // client. This field is the ground truth for learning from corrections later,
    // so a caller must not be able to mislabel it.
    const { data: category, error: categoryError } = await supabase
      .from('comment_categories')
      .select('draft_reply')
      .eq('comment_id', comment_id)
      .maybeSingle()

    if (categoryError) {
      console.error('Approve draft reply lookup error:', JSON.stringify(categoryError, Object.getOwnPropertyNames(categoryError), 2))
      return NextResponse.json({ error: 'Failed to approve draft reply' }, { status: 500 })
    }

    if (!category?.draft_reply) {
      return NextResponse.json({ error: 'No drafted reply to approve' }, { status: 404 })
    }

    const draft = category.draft_reply
    const submitted = typeof final_reply_text === 'string' ? final_reply_text.trim() : null

    if (submitted !== null && submitted.length === 0) {
      return NextResponse.json({ error: 'Reply cannot be empty' }, { status: 400 })
    }

    // Approving untouched text still writes final_reply_text — the column means
    // "what the creator actually sent", so it must be populated either way. Only
    // reply_was_edited distinguishes the two cases.
    const finalText = submitted ?? draft
    const wasEdited = submitted !== null && submitted !== draft.trim()

    const { error: updateError } = await supabase
      .from('comment_categories')
      .update({
        draft_reply_approved_at: new Date().toISOString(),
        final_reply_text: finalText,
        reply_was_edited: wasEdited,
      })
      .eq('comment_id', comment_id)

    if (updateError) {
      console.error('Approve draft reply error:', JSON.stringify(updateError, Object.getOwnPropertyNames(updateError), 2))
      return NextResponse.json({ error: 'Failed to approve draft reply' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      final_reply_text: finalText,
      reply_was_edited: wasEdited,
    })
  } catch (err) {
    console.error('Approve draft reply error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
