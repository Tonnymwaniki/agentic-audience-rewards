import type { SupabaseClient } from '@supabase/supabase-js'
import { logError, logWarn } from '@/lib/logger'
import { checkPostVerification } from '@/lib/channel-verification'
import { getCreatorPlan, isFirstVerifiedPost } from '@/lib/entitlements'
import { sendReplyToYouTube } from '@/lib/youtube-reply'

/**
 * Approves a drafted reply and, if the creator is eligible, sends it to YouTube —
 * the one code path behind BOTH the manual "Approve" button
 * (app/api/draft-reply/approve) and the auto-reply cron
 * (app/api/cron/auto-reply). Every safety gate lives here exactly once:
 * ownership verification, draft existence, plan/free-trial eligibility, and the
 * OAuth write-scope check inside sendReplyToYouTube. A second caller must reuse
 * this rather than re-implement it — that's what keeps automation from drifting
 * out of step with (or quietly bypassing) what manual approval enforces.
 */

export type ApproveAndSendResult =
  | {
      ok: true
      finalReplyText: string
      wasEdited: boolean
      sendStatus: 'sent' | 'failed' | 'skipped'
      sendError: string | null
    }
  | { ok: false; status: number; error: string; reason?: string; verifyUrl?: string }

export async function approveAndSendReply(
  supabase: SupabaseClient,
  args: {
    creatorId: string
    commentId: string
    /** Omit to approve the draft text as-is (the auto-reply path always omits this — automation never edits a draft, it only sends or doesn't). */
    finalReplyText?: string
    /** True when this call comes from the auto-reply cron rather than a human clicking Approve. Stamped onto comment_categories.reply_auto_sent so the Notifications audit view can tell them apart. */
    autoSent?: boolean
  }
): Promise<ApproveAndSendResult> {
  const { creatorId, commentId, finalReplyText, autoSent = false } = args

  const { data: comment, error: commentError } = await supabase
    .from('comments')
    .select('id, post_id, external_comment_id, posts (creator_id, channel_id)')
    .eq('id', commentId)
    .single()

  const postInfo = comment?.posts as unknown as { creator_id: string; channel_id: string | null } | null
  const ownerCreatorId = postInfo?.creator_id

  if (commentError || !comment || ownerCreatorId !== creatorId) {
    return { ok: false, status: 404, error: 'Comment not found' }
  }

  // CAPABILITY GATE, identical to drafting: approving/sending puts a reply in the
  // channel owner's voice, so it needs proven ownership every time this runs —
  // including on the automation path, which must re-check this itself rather
  // than trust that the settings toggle implies verification still holds.
  const verification = await checkPostVerification(supabase, creatorId, comment.post_id as string)
  if (!verification.verified) {
    return {
      ok: false,
      status: 403,
      error: 'Verify channel ownership to enable drafted replies and rewards.',
      reason: verification.reason,
      verifyUrl: '/api/auth/youtube/start',
    }
  }

  const { data: category, error: categoryError } = await supabase
    .from('comment_categories')
    .select('draft_reply')
    .eq('comment_id', commentId)
    .maybeSingle()

  if (categoryError) {
    logError('replyApproval.approveAndSend', categoryError, { creator_id: creatorId, comment_id: commentId, stage: 'lookup' })
    return { ok: false, status: 500, error: 'Failed to approve draft reply' }
  }

  if (!category?.draft_reply) {
    return { ok: false, status: 404, error: 'No drafted reply to approve' }
  }

  const draft = category.draft_reply
  const submitted = typeof finalReplyText === 'string' ? finalReplyText.trim() : null

  if (submitted !== null && submitted.length === 0) {
    return { ok: false, status: 400, error: 'Reply cannot be empty' }
  }

  const finalText = submitted ?? draft
  const wasEdited = submitted !== null && submitted !== draft.trim()

  const { error: updateError } = await supabase
    .from('comment_categories')
    .update({
      draft_reply_approved_at: new Date().toISOString(),
      final_reply_text: finalText,
      reply_was_edited: wasEdited,
      reply_auto_sent: autoSent,
    })
    .eq('comment_id', commentId)

  if (updateError) {
    // reply_auto_sent (migration 52) may not exist yet on every database — same
    // self-healing pattern used throughout this codebase for schema that can lag
    // behind a deploy. Retry once without it rather than failing the whole approval.
    if ((updateError.code === 'PGRST204' || updateError.code === '42703') && (updateError.message ?? '').includes('reply_auto_sent')) {
      logWarn('replyApproval.approveAndSend', 'comment_categories.reply_auto_sent does not exist yet; approving without it (run the pending migration)', {
        creator_id: creatorId,
        comment_id: commentId,
      })
      const retry = await supabase
        .from('comment_categories')
        .update({
          draft_reply_approved_at: new Date().toISOString(),
          final_reply_text: finalText,
          reply_was_edited: wasEdited,
        })
        .eq('comment_id', commentId)
      if (retry.error) {
        logError('replyApproval.approveAndSend', retry.error, { creator_id: creatorId, comment_id: commentId, stage: 'update_retry' })
        return { ok: false, status: 500, error: 'Failed to approve draft reply' }
      }
    } else {
      logError('replyApproval.approveAndSend', updateError, { creator_id: creatorId, comment_id: commentId, stage: 'update' })
      return { ok: false, status: 500, error: 'Failed to approve draft reply' }
    }
  }

  // Approval (above) and actually posting to YouTube (below) stay separate steps:
  // approval always succeeds once ownership is verified, so a creator's (or the
  // automation's) decision is never lost to a YouTube-side failure. Sending is
  // gated to Pro — OR, for a Free creator's manual approval, their single oldest
  // verified video (one-time free trial) — and only attempted when the channel's
  // grant actually carries write access.
  let sendOutcome: { status: 'sent' | 'failed' | 'skipped'; error: string | null; youtubeCommentId: string | null } = {
    status: 'skipped',
    error: null,
    youtubeCommentId: null,
  }

  const plan = await getCreatorPlan(supabase, creatorId)
  const eligibleForSend =
    plan === 'pro' ||
    (!autoSent && postInfo?.channel_id
      ? await isFirstVerifiedPost(supabase, creatorId, postInfo.channel_id, comment.post_id as string)
      : false)

  if (eligibleForSend && postInfo?.channel_id && comment.external_comment_id) {
    const result = await sendReplyToYouTube(supabase, {
      creatorId,
      channelId: postInfo.channel_id,
      parentExternalCommentId: comment.external_comment_id,
      text: finalText,
    })

    if (result.ok) {
      sendOutcome = { status: 'sent', error: null, youtubeCommentId: result.youtubeCommentId }
    } else if (result.reason === 'missing_scope') {
      sendOutcome = { status: 'skipped', error: result.error, youtubeCommentId: null }
    } else {
      sendOutcome = { status: 'failed', error: result.error, youtubeCommentId: null }
      logWarn('replyApproval.approveAndSend', 'Reply approved but could not be sent to YouTube', {
        creator_id: creatorId,
        comment_id: commentId,
        auto_sent: autoSent,
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
      .eq('comment_id', commentId)
  }

  return {
    ok: true,
    finalReplyText: finalText,
    wasEdited,
    sendStatus: sendOutcome.status,
    sendError: sendOutcome.error,
  }
}
