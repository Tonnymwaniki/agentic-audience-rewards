import { NextRequest, NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { logError, logInfo, logWarn } from '@/lib/logger'
import {
  encryptToken,
  exchangeCodeForTokens,
  fetchOwnedChannels,
  OAUTH_STATE_COOKIE,
  verifyState,
} from '@/lib/youtube-oauth'

export const dynamic = 'force-dynamic'

const CONNECT_PATH = '/dashboard/connect'

/** Sends the creator back to Connect with a short, non-technical reason. */
function back(request: NextRequest, params: Record<string, string>) {
  const url = new URL(CONNECT_PATH, request.nextUrl.origin)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  const response = NextResponse.redirect(url)
  // The state is single-use: clear it whichever way this ends, so a replayed
  // callback cannot match a cookie that is still lying around.
  response.cookies.delete(OAUTH_STATE_COOKIE)
  return response
}

/**
 * Google's redirect target. Verifies state, exchanges the code, and records which
 * channels the account actually owns.
 *
 * Order matters and is not arbitrary:
 *
 *  1. Session first. The callback is an authenticated action on a specific
 *     account; without this, the code exchange would run for an anonymous caller.
 *  2. State next, BEFORE spending the code. Verification is free; the exchange is
 *     a network round trip that also burns a single-use code. Checking first means
 *     a forged callback costs nothing and consumes nothing.
 *  3. The state's creator id is compared against the SESSION's creator id. This is
 *     the check that stops the classic login-CSRF: an attacker completes consent
 *     for their own channel, then lures a signed-in victim to the callback URL. The
 *     signature would be valid and the state unexpired — but it was minted for the
 *     attacker's creator id, so it cannot bind the attacker's channel to the
 *     victim's account.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams

  const result = await requireCreator()
  if (!result.ok) {
    // Not an error worth paging anyone: an expired session during consent.
    return back(request, { yt_error: 'session_expired' })
  }
  const { supabase, creatorId } = result.auth

  // Google reports user refusal as ?error=access_denied, not as a failed exchange.
  const googleError = params.get('error')
  if (googleError) {
    logInfo('api/auth/youtube/callback', 'Consent not granted', {
      creator_id: creatorId,
      google_error: googleError,
    })
    return back(request, { yt_error: googleError === 'access_denied' ? 'declined' : 'google_error' })
  }

  const stateCheck = verifyState(params.get('state') ?? undefined, request.cookies.get(OAUTH_STATE_COOKIE)?.value)
  if (!stateCheck.ok) {
    logWarn('api/auth/youtube/callback', 'State verification failed', {
      creator_id: creatorId,
      reason: stateCheck.reason,
    })
    return back(request, { yt_error: stateCheck.reason === 'expired' ? 'expired' : 'bad_state' })
  }

  if (stateCheck.creatorId !== creatorId) {
    // Valid, unexpired, correctly signed — and issued to somebody else.
    logWarn('api/auth/youtube/callback', 'State belongs to a different creator; refusing', {
      creator_id: creatorId,
      state_creator_id: stateCheck.creatorId,
    })
    return back(request, { yt_error: 'bad_state' })
  }

  const code = params.get('code')
  if (!code) return back(request, { yt_error: 'no_code' })

  // Each Google call gets its OWN try/catch and its own stage.
  //
  // These were one combined try/catch reporting `stage: 'exchange'` and
  // `yt_error=exchange_failed` for any failure. A real consent then failed at
  // channels.list — YouTube Data API v3 was not enabled on the OAuth client's
  // Cloud project — and the log said the token exchange had failed, sending the
  // investigation to the redirect URI and client credentials, which were fine.
  // A stage label that can name the wrong call is worse than no label.
  let tokens: Awaited<ReturnType<typeof exchangeCodeForTokens>>
  try {
    tokens = await exchangeCodeForTokens(code)
  } catch (error) {
    logError('api/auth/youtube/callback', error, { creator_id: creatorId, stage: 'exchange_code_for_tokens' })
    return back(request, { yt_error: 'exchange_failed' })
  }

  let channels: Awaited<ReturnType<typeof fetchOwnedChannels>>
  try {
    channels = await fetchOwnedChannels(tokens.accessToken)
  } catch (error) {
    // The tokens are valid at this point — only the channel read failed. Most
    // often that is a disabled API or a quota limit on the Cloud project, which
    // is an operator problem, not something the creator did wrong.
    logError('api/auth/youtube/callback', error, {
      creator_id: creatorId,
      stage: 'fetch_owned_channels',
      hint: 'check that YouTube Data API v3 is enabled on the OAuth client\'s Google Cloud project',
    })
    return back(request, { yt_error: 'channels_failed' })
  }

  try {
    const primary = channels[0] ?? null

    const { error: writeError } = await supabase.from('youtube_oauth_tokens').upsert(
      {
        creator_id: creatorId,
        access_token_encrypted: encryptToken(tokens.accessToken),
        // Only overwrite the refresh token when Google actually sent one. A
        // re-authorization that omits it must not blank the working one.
        ...(tokens.refreshToken ? { refresh_token_encrypted: encryptToken(tokens.refreshToken) } : {}),
        expires_at: tokens.expiresAt.toISOString(),
        scope: tokens.scope,
        channel_id: primary?.id ?? null,
        channel_title: primary?.title ?? null,
        channel_custom_url: primary?.customUrl ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'creator_id' }
    )

    if (writeError) {
      logError('api/auth/youtube/callback', writeError, { creator_id: creatorId, stage: 'store_tokens' })
      return back(request, { yt_error: 'store_failed' })
    }

    logInfo('api/auth/youtube/callback', 'YouTube account connected', {
      creator_id: creatorId,
      channels_owned: channels.length,
      channel_id: primary?.id ?? null,
      has_refresh_token: Boolean(tokens.refreshToken),
      scope: tokens.scope,
    })

    // No channel on the Google account is a real outcome, not a failure — say so
    // plainly instead of reporting a connection error the creator cannot fix.
    if (channels.length === 0) return back(request, { yt_error: 'no_channels' })

    return back(request, { yt_connected: '1', channels: String(channels.length) })
  } catch (error) {
    // Encryption or an unexpected failure around the write. The tokens were
    // obtained successfully, so this is our problem, not Google's.
    logError('api/auth/youtube/callback', error, { creator_id: creatorId, stage: 'persist' })
    return back(request, { yt_error: 'store_failed' })
  }
}
