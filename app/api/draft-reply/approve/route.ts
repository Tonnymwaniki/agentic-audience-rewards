import { NextRequest, NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { logError, logInfo } from '@/lib/logger'
import { approveAndSendReply } from '@/lib/reply-approval'

export async function POST(request: NextRequest) {
  try {
    const { comment_id, final_reply_text } = await request.json()

    if (!comment_id) {
      return NextResponse.json({ error: 'Missing comment_id' }, { status: 400 })
    }

    if (final_reply_text !== undefined && typeof final_reply_text !== 'string') {
      return NextResponse.json({ error: 'final_reply_text must be a string' }, { status: 400 })
    }

    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response
    const { supabase, creatorId } = authResult.auth

    const result = await approveAndSendReply(supabase, {
      creatorId,
      commentId: comment_id,
      finalReplyText: final_reply_text,
    })

    if (!result.ok) {
      if (result.status === 403) {
        logInfo('api/draft-reply/approve', 'Refused: channel ownership not verified', {
          creator_id: creatorId,
          comment_id,
          reason: result.reason,
        })
        return NextResponse.json({ error: result.error, reason: result.reason, verify_url: result.verifyUrl }, { status: 403 })
      }
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    return NextResponse.json({
      success: true,
      final_reply_text: result.finalReplyText,
      reply_was_edited: result.wasEdited,
      reply_send_status: result.sendStatus,
      ...(result.sendError ? { reply_send_error: result.sendError } : {}),
    })
  } catch (err) {
    logError('api/draft-reply/approve', err, { stage: 'request' })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
