import { NextRequest, NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { logError, logInfo } from '@/lib/logger'
import {
  buildConsentUrl,
  createState,
  OAUTH_STATE_COOKIE,
  STATE_TTL_SECONDS,
  YOUTUBE_FORCE_SSL_SCOPE,
} from '@/lib/youtube-oauth'

export const dynamic = 'force-dynamic'

/**
 * Begins Google OAuth: mints a CSRF state, drops it in an httpOnly cookie, and
 * redirects to Google's consent screen.
 *
 * Authenticated deliberately. The state binds this flow to a specific creator id,
 * so the callback can refuse a code that comes back for a different account — and
 * an unauthenticated start would have no creator to bind to.
 *
 * GET rather than POST because it ends in a browser redirect the user follows from
 * a link or button. The state cookie is what protects it, not the method.
 */
export async function GET(request: NextRequest) {
  const result = await requireCreator()
  if (!result.ok) return result.response

  const { creatorId } = result.auth

  // Opt-in only: ?replies=1 additionally requests write access so approved
  // drafts can actually post to YouTube (app/api/draft-reply/approve). Not
  // gated to Pro here: a Free creator gets a one-time free trial of sending on
  // their single oldest verified video (see isFirstVerifiedPost in
  // lib/entitlements.ts), so they need to be able to grant this scope too.
  // Whether a given approval actually sends is decided per-post at send time,
  // not at consent time.
  const wantsReplyScope = request.nextUrl.searchParams.get('replies') === '1'

  try {
    const state = createState(creatorId)
    const consentUrl = buildConsentUrl(state, wantsReplyScope ? [YOUTUBE_FORCE_SSL_SCOPE] : [])

    logInfo('api/auth/youtube/start', 'Starting YouTube OAuth', { creator_id: creatorId, reply_scope_requested: wantsReplyScope })

    const response = NextResponse.redirect(consentUrl)
    response.cookies.set(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      // sameSite 'lax', not 'strict': the callback arrives as a cross-site
      // top-level navigation FROM accounts.google.com, and 'strict' would withhold
      // the cookie on exactly that request, making every callback fail state
      // verification. 'lax' sends it on top-level GET navigations, which is this.
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: STATE_TTL_SECONDS,
    })
    return response
  } catch (error) {
    // Almost always a missing GOOGLE_OAUTH_* env var. Say so rather than
    // redirecting the creator to a Google error page they cannot act on.
    logError('api/auth/youtube/start', error, { creator_id: creatorId })
    return NextResponse.json(
      { error: 'YouTube connection is not configured. Please contact support.' },
      { status: 500 }
    )
  }
}
