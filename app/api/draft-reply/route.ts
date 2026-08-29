import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { generateDraftReply } from '@/lib/categorize'

export async function POST(request: NextRequest) {
  try {
    const { comment_id } = await request.json()

    if (!comment_id) {
      return NextResponse.json(
        { error: 'Missing comment_id' },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    const { data: comment } = await supabase
      .from('comments')
      .select('text')
      .eq('id', comment_id)
      .single()

    if (!comment) {
      return NextResponse.json(
        { error: 'Comment not found' },
        { status: 404 }
      )
    }

    const draftReply = await generateDraftReply(comment.text)

    await supabase
      .from('comment_categories')
      .update({ draft_reply: draftReply })
      .eq('comment_id', comment_id)

    return NextResponse.json({ draft_reply: draftReply })
  } catch (err) {
    console.error('Draft reply error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json(
      { error: 'Failed to generate draft reply' },
      { status: 500 }
    )
  }
}
