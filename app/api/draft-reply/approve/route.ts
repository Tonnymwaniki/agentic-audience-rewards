import { NextRequest, NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { logError, logInfo, logWarn } from '@/lib/logger'
import { checkPostVerification, VERIFY_OWNERSHIP_MESSAGE, VERIFY_OWNERSHIP_PATH } from '@/lib/channel-verification'
import { getCreatorPlan } from '@/lib/entitlements'
import { sendReplyToYouTube } from '@/lib/youtube-reply'

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

    // Confirm the comment belongs to one of this creator's posts before touching it.
    // external_comment_id and the post's channel_id are fetched now (not only on
    // the send path below) since both are cheap and come from the same row.
    const { data: comment, error: commentError } = await supabase
      .from('comments')
      .select('id, post_id, external_comment_id, posts (creator_id, channel_id)')
      .eq('id', comment_id)
      .single()

    const postInfo = comment?.posts as unknown as { creator_id: string; channel_id: string | null } | null
    const ownerCreatorId = postInfo?.creator_id

    if (commentError || !comment || ownerCreatorId !== creatorId) {
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
    }

    // CAPABILITY GATE, same as drafting: approving puts a reply in the channel
    // owner's voice, so it needs proven ownership. This is the enforcement behind
    // hiding pre-verification drafts from the inbox — a hidden draft must not stay
    // approvable by calling this endpoint directly.
    const verification = await checkPostVerification(supabase, creatorId, comment.post_id as string)
    if (!verification.verified) {
      logInfo('api/draft-reply/approve', 'Refused: channel ownership not verified', {
        creator_id: creatorId,
        comment_id,
        post_id: comment.post_id,
        reason: verification.reason,
      })
      return NextResponse.json(
        { error: VERIFY_OWNERSHIP_MESSAGE, reason: verification.reason, verify_url: VERIFY_OWNERSHIP_PATH },
        { status: 403 }
      )
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
      logError('api/draft-reply/approve', categoryError, { creator_id: creatorId, comment_id, stage: 'lookup' })
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
      logError('api/draft-reply/approve', updateError, { creator_id: creatorId, comment_id, stage: 'update' })
      return NextResponse.json({ error: 'Failed to approve draft reply' }, { status: 500 })
    }

    // Approving the draft (above) and actually posting it to YouTube (below) are
    // deliberately separate steps: approval always succeeds once ownership is
    // verified, so a creator's decision is never lost to a YouTube-side failure.
    // Sending is gated to Pro and only attempted when the channel's grant actually
    // carries write access — everyone else gets `skipped`, not an error, since
    // "not sending" is the correct behavior for them, not a malfunction.
    let sendOutcome: { status: 'sent' | 'failed' | 'skipped'; error: string | null; youtubeCommentId: string | null } = {
      status: 'skipped',
      error: null,
      youtubeCommentId: null,
    }

    const plan = await getCreatorPlan(supabase, creatorId)
    if (plan === 'pro' && postInfo?.channel_id && comment.external_comment_id) {
      const result = await sendReplyToYouTube(supabase, {
        creatorId,
        channelId: postInfo.channel_id,
        parentExternalCommentId: comment.external_comment_id,
        text: finalText,
      })

      if (result.ok) {
        sendOutcome = { status: 'sent', error: null, youtubeCommentId: result.youtubeCommentId }
      } else if (result.reason === 'missing_scope') {
        // Not a failure worth logging as an error — this is the expected state for
        // every Pro creator who hasn't yet re-connected with reply-sending enabled.
        sendOutcome = { status: 'skipped', error: result.error, youtubeCommentId: null }
      } else {
        sendOutcome = { status: 'failed', error: result.error, youtubeCommentId: null }
        logWarn('api/draft-reply/approve', 'Reply approved but could not be sent to YouTube', {
          creator_id: creatorId,
          comment_id,
          reason: result.reason,
          error: result.error,
        })
      }

      await supabase
        .from('comment_categories')
        .update({
          reply_send_status: sendOutcome.status,
          reply_sent_at: sendOutcome.status === 'sent' ? new Date().toISOString() : null,
          youtube_reply_comment_id: sendOutcome.youtubeCommentId,
          reply_send_error: sendOutcome.error,
        })
        .eq('comment_id', comment_id)
    }

    return NextResponse.json({
      success: true,
      final_reply_text: finalText,
      reply_was_edited: wasEdited,
      reply_send_status: sendOutcome.status,
      ...(sendOutcome.error ? { reply_send_error: sendOutcome.error } : {}),
    })
  } catch (err) {
    logError('api/draft-reply/approve', err, { stage: 'request' })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
