import type { SupabaseClient } from '@supabase/supabase-js'
import { logError, logInfo } from '@/lib/logger'
import { getValidAccessToken, hasReplyScope } from '@/lib/youtube-oauth'

/**
 * Posts an approved draft reply back to YouTube as a real reply comment, using
 * YouTube Data API v3's comments.insert with `snippet.parentId` set to the
 * original comment — that's how a REPLY (not a new top-level comment) is
 * created. https://developers.google.com/youtube/v3/docs/comments/insert
 *
 * This is the one call in the whole app that requires write access
 * (youtube.force-ssl) rather than the read-only scopes everything else uses —
 * see lib/youtube-oauth.ts's comment on why that's requested separately and
 * only for Pro creators.
 */
const YOUTUBE_COMMENTS_INSERT_ENDPOINT = 'https://www.googleapis.com/youtube/v3/comments'

export type SendReplyResult =
  | { ok: true; youtubeCommentId: string }
  | {
      ok: false
      reason: 'no_grant' | 'no_refresh_token' | 'revoked' | 'refresh_failed' | 'missing_scope' | 'youtube_rejected'
      error: string
    }

/**
 * Sends `text` to YouTube as a reply to `parentExternalCommentId` (the ORIGINAL
 * comment's YouTube id, i.e. comments.external_comment_id — not our internal
 * uuid). Uses the creator's stored OAuth grant for `channelId`, refreshing the
 * access token if needed.
 *
 * Never throws — every failure mode here is something a caller must handle as
 * "the reply was not sent" (missing/revoked grant, missing write scope, or
 * YouTube itself rejecting the request — e.g. the comment was deleted, or
 * replies are disabled on that video), not an exceptional crash.
 */
export async function sendReplyToYouTube(
  supabase: SupabaseClient,
  args: { creatorId: string; channelId: string; parentExternalCommentId: string; text: string }
): Promise<SendReplyResult> {
  const token = await getValidAccessToken(supabase, args.creatorId, args.channelId)
  if (!token.ok) return { ok: false, reason: token.reason, error: token.error }

  // The grant might only carry the read-only scopes (most creators, and every
  // creator before reply-sending existed) — checked against what Google most
  // recently reported, not assumed from a boolean flag that could drift from
  // Google's own record of what was actually granted.
  const { data: row } = await supabase
    .from('youtube_oauth_tokens')
    .select('scope')
    .eq('creator_id', args.creatorId)
    .eq('channel_id', args.channelId)
    .maybeSingle()

  if (!hasReplyScope(row?.scope)) {
    return {
      ok: false,
      reason: 'missing_scope',
      error: 'This channel is connected for verification only — reconnect with reply-sending enabled to post replies.',
    }
  }

  try {
    const response = await fetch(`${YOUTUBE_COMMENTS_INSERT_ENDPOINT}?part=snippet`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        snippet: {
          parentId: args.parentExternalCommentId,
          textOriginal: args.text,
        },
      }),
    })

    const body = await response.json().catch(() => null)

    if (!response.ok) {
      const message = (body as { error?: { message?: string } })?.error?.message || `YouTube returned ${response.status}`
      logError('youtubeReply.send', new Error(message), {
        creator_id: args.creatorId,
        channel_id: args.channelId,
        status: response.status,
      })
      return { ok: false, reason: 'youtube_rejected', error: message }
    }

    const youtubeCommentId = (body as { id?: string })?.id
    if (!youtubeCommentId) {
      return { ok: false, reason: 'youtube_rejected', error: 'YouTube accepted the request but returned no comment id' }
    }

    logInfo('youtubeReply.send', 'Reply posted to YouTube', {
      creator_id: args.creatorId,
      channel_id: args.channelId,
      parent_comment_id: args.parentExternalCommentId,
      youtube_comment_id: youtubeCommentId,
    })

    return { ok: true, youtubeCommentId }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logError('youtubeReply.send', err, { creator_id: args.creatorId, channel_id: args.channelId })
    return { ok: false, reason: 'youtube_rejected', error: message }
  }
}
