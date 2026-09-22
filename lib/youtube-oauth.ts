import crypto from 'node:crypto'
import { logWarn } from '@/lib/logger'

/**
 * Google OAuth for YouTube CHANNEL OWNERSHIP verification.
 *
 * The problem this solves: until now a creator typed a channel URL into a text
 * box and the app believed them. Nothing stopped anyone connecting a channel they
 * do not own and pulling its audience into their dashboard. `channels.list?mine=true`
 * answers a different question from "what URL did you paste" — it asks Google which
 * channels this authenticated account actually owns, and Google's answer cannot be
 * forged by the person filling in the form.
 *
 * Scope is `youtube.readonly` and nothing else: this flow reads which channels are
 * theirs. It never needs to post, edit or delete, and asking for less is both the
 * correct grant and the difference between a consent screen a creator accepts and
 * one they abandon.
 */

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'
const YOUTUBE_CHANNELS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/channels'

export const YOUTUBE_READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly'

/** Name of the httpOnly cookie holding the signed CSRF state. */
export const OAUTH_STATE_COOKIE = 'yt_oauth_state'

/** A state older than this is refused even if the signature is valid. */
export const STATE_TTL_SECONDS = 600

/**
 * Refresh this many seconds BEFORE the token actually expires. A token that is
 * valid when checked can still expire during the request it is about to be used
 * for, and the resulting 401 surfaces as an unexplained sync failure.
 */
export const TOKEN_REFRESH_SKEW_SECONDS = 120

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    // Fail loudly at the call site rather than sending Google a request with
    // "undefined" in it and debugging the opaque error that comes back.
    throw new Error(`${name} is not configured`)
  }
  return value
}

export function oauthConfig() {
  return {
    clientId: requireEnv('GOOGLE_OAUTH_CLIENT_ID'),
    clientSecret: requireEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
    redirectUri: requireEnv('GOOGLE_OAUTH_REDIRECT_URI'),
  }
}

// --- CSRF state -------------------------------------------------------------

/**
 * The state parameter is a signed, self-describing token rather than a random
 * value stored in a table.
 *
 * It carries the creator id it was issued to and the time it was issued, HMAC'd
 * with the app's own secret. On callback the signature proves the app issued it,
 * the timestamp bounds the replay window, and the creator id proves the callback
 * lands on the SAME account that began the flow — a random opaque value alone
 * would not catch a state minted for a different session.
 *
 * Signed with the token encryption key, which never leaves the server.
 */
function stateSecret(): Buffer {
  return Buffer.from(requireEnv('YOUTUBE_TOKEN_ENCRYPTION_KEY'), 'base64')
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

export function createState(creatorId: string): string {
  const payload = b64url(
    JSON.stringify({ c: creatorId, t: Math.floor(Date.now() / 1000), n: crypto.randomBytes(9).toString('base64url') })
  )
  const signature = crypto.createHmac('sha256', stateSecret()).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

export type StateCheck =
  | { ok: true; creatorId: string }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'mismatch' }

/**
 * Verifies a state value and, when a cookie copy is supplied, that the two match.
 *
 * Both halves matter. The signature stops a state the app never issued; comparing
 * against the httpOnly cookie stops a VALID state issued to a different browser
 * being replayed into this one, which is the actual login-CSRF attack — an
 * attacker completing their own consent and redirecting the victim to the
 * callback so the victim's account ends up linked to the attacker's channel.
 */
export function verifyState(state: string | undefined, cookieState: string | undefined): StateCheck {
  if (!state || typeof state !== 'string' || !state.includes('.')) return { ok: false, reason: 'malformed' }

  const [payload, signature] = state.split('.')
  if (!payload || !signature) return { ok: false, reason: 'malformed' }

  const expected = crypto.createHmac('sha256', stateSecret()).update(payload).digest('base64url')
  // Length-checked timing-safe compare: timingSafeEqual throws on length mismatch.
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' }

  let parsed: { c?: string; t?: number }
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  if (!parsed.c || typeof parsed.t !== 'number') return { ok: false, reason: 'malformed' }
  if (Math.floor(Date.now() / 1000) - parsed.t > STATE_TTL_SECONDS) return { ok: false, reason: 'expired' }

  if (cookieState !== undefined) {
    const c = Buffer.from(state)
    const d = Buffer.from(cookieState)
    if (c.length !== d.length || !crypto.timingSafeEqual(c, d)) return { ok: false, reason: 'mismatch' }
  }

  return { ok: true, creatorId: parsed.c }
}

// --- Token encryption at rest ------------------------------------------------

/**
 * AES-256-GCM. The format is `v1.<iv>.<tag>.<ciphertext>`, all base64url.
 *
 * Versioned so the scheme can be changed later without guessing at what a stored
 * string is. GCM rather than CBC because it authenticates: a tampered ciphertext
 * fails to decrypt instead of silently producing different plaintext.
 */
export function encryptToken(plaintext: string): string {
  const key = Buffer.from(requireEnv('YOUTUBE_TOKEN_ENCRYPTION_KEY'), 'base64')
  if (key.length !== 32) throw new Error('YOUTUBE_TOKEN_ENCRYPTION_KEY must decode to 32 bytes')

  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return ['v1', b64url(iv), b64url(tag), b64url(ciphertext)].join('.')
}

export function decryptToken(stored: string): string {
  const key = Buffer.from(requireEnv('YOUTUBE_TOKEN_ENCRYPTION_KEY'), 'base64')
  const [version, ivPart, tagPart, dataPart] = stored.split('.')
  if (version !== 'v1' || !ivPart || !tagPart || !dataPart) {
    throw new Error('Stored token is not in the expected v1 format')
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8')
}

// --- Google calls -------------------------------------------------------------

export function buildConsentUrl(state: string): string {
  const { clientId, redirectUri } = oauthConfig()
  const url = new URL(GOOGLE_AUTH_ENDPOINT)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', YOUTUBE_READONLY_SCOPE)
  url.searchParams.set('state', state)
  // offline + consent is what actually returns a refresh token. Google issues one
  // only on the FIRST authorization for a client/user pair unless prompt=consent
  // forces the screen again — without it, a creator who reconnects gets an access
  // token with no refresh token and the integration silently dies after an hour.
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('include_granted_scopes', 'true')
  return url.toString()
}

export type GoogleTokens = {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date
  scope: string
}

type TokenErrorShape = { error?: string; error_description?: string }

export class GoogleOAuthError extends Error {
  // Declared as ordinary fields rather than constructor parameter properties:
  // parameter properties are not erasable TypeScript, so they break any runtime
  // that strips types instead of compiling them (node --experimental-strip-types,
  // and tsconfig's erasableSyntaxOnly). The behaviour is identical.
  readonly status: number
  readonly googleError: string | null

  constructor(message: string, status: number, googleError: string | null) {
    super(message)
    this.name = 'GoogleOAuthError'
    this.status = status
    this.googleError = googleError
  }
}

async function postToken(body: Record<string, string>): Promise<GoogleTokens> {
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })

  const data = (await response.json().catch(() => ({}))) as TokenErrorShape & {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    scope?: string
  }

  if (!response.ok || !data.access_token) {
    throw new GoogleOAuthError(
      data.error_description || data.error || `Token endpoint returned ${response.status}`,
      response.status,
      data.error ?? null
    )
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    // expires_in is seconds from now; storing an absolute instant means the
    // freshness check doesn't depend on when the row happened to be read.
    expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
    scope: data.scope ?? '',
  }
}

export async function exchangeCodeForTokens(code: string): Promise<GoogleTokens> {
  const { clientId, clientSecret, redirectUri } = oauthConfig()
  return postToken({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })
}

export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
  const { clientId, clientSecret } = oauthConfig()
  const tokens = await postToken({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  })
  // A refresh response does not echo the refresh token back. Returning null here
  // would overwrite the stored one with nothing, so the caller keeps the old one.
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken }
}

export type OwnedChannel = {
  id: string
  title: string
  customUrl: string | null
  thumbnailUrl: string | null
  description: string | null
}

/**
 * The channels this Google account actually owns.
 *
 * This is the whole point of the flow: the answer comes from Google against the
 * user's own credentials, so it cannot be influenced by anything typed into the
 * app. An account with no channel returns an empty list, which is a real and
 * common outcome — a Google account is not a YouTube channel.
 */
export async function fetchOwnedChannels(accessToken: string): Promise<OwnedChannel[]> {
  const url = new URL(YOUTUBE_CHANNELS_ENDPOINT)
  url.searchParams.set('part', 'snippet')
  url.searchParams.set('mine', 'true')
  url.searchParams.set('maxResults', '50')

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
    throw new GoogleOAuthError(
      detail.error?.message || `channels.list returned ${response.status}`,
      response.status,
      null
    )
  }

  const data = (await response.json()) as {
    items?: Array<{
      id: string
      snippet?: {
        title?: string
        customUrl?: string
        description?: string
        thumbnails?: Record<string, { url?: string }>
      }
    }>
  }

  return (data.items ?? []).map(item => ({
    id: item.id,
    title: item.snippet?.title ?? 'Untitled channel',
    customUrl: item.snippet?.customUrl ?? null,
    thumbnailUrl:
      item.snippet?.thumbnails?.high?.url ??
      item.snippet?.thumbnails?.medium?.url ??
      item.snippet?.thumbnails?.default?.url ??
      null,
    description: item.snippet?.description ?? null,
  }))
}

export type RevokeOutcome =
  /** Google accepted the revocation. The grant is gone. */
  | 'revoked'
  /** Google rejected the token as unknown/expired — i.e. there is no grant left. */
  | 'already_invalid'
  /** Google was unreachable or returned an unexpected status. Grant may survive. */
  | 'failed'

/**
 * Asks Google to revoke a token. Never throws.
 *
 * `already_invalid` is reported separately from `failed` because they mean
 * opposite things for the caller: an expired token means there is nothing left to
 * revoke (the desired end state), while a network failure means a live grant may
 * still exist and someone should know about it.
 */
export async function revokeToken(token: string): Promise<RevokeOutcome> {
  try {
    const response = await fetch(GOOGLE_REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    })

    if (response.ok) return 'revoked'

    // Google answers an unknown or already-revoked token with 400 invalid_token.
    if (response.status === 400) {
      const detail = (await response.json().catch(() => ({}))) as TokenErrorShape
      if (detail.error === 'invalid_token') return 'already_invalid'
    }

    return 'failed'
  } catch {
    return 'failed'
  }
}

export type RevokeReport = {
  outcome: RevokeOutcome | 'no_token' | 'decrypt_failed'
  /** Which credential was sent, for the log line. */
  tokenType: 'refresh' | 'access' | null
}

/**
 * Revokes a creator's Google grant, reading the stored tokens first.
 *
 * MUST be called BEFORE the creator's rows are deleted. `youtube_oauth_tokens`
 * cascades from `creators`, so once the cascade runs the tokens are gone and the
 * grant can never be withdrawn from our side — the user would have to find it in
 * their own Google account settings.
 *
 * Prefers the REFRESH token: revoking it invalidates the entire grant, including
 * every access token derived from it. Revoking an access token alone only kills
 * that one hour-long token and leaves the refresh token able to mint more.
 *
 * Never throws, and never reports failure in a way that could abort deletion. A
 * creator asking to delete their account must not be blocked because Google is
 * having an outage; the deletion proceeds and the failure is logged for follow-up.
 */
export async function revokeCreatorGoogleAccess(
  supabase: { from: (table: string) => any },
  creatorId: string
): Promise<RevokeReport> {
  let row: { refresh_token_encrypted?: string | null; access_token_encrypted?: string | null } | null = null

  try {
    const { data } = await supabase
      .from('youtube_oauth_tokens')
      .select('access_token_encrypted, refresh_token_encrypted')
      .eq('creator_id', creatorId)
      .maybeSingle()
    row = data ?? null
  } catch {
    // An unreadable table (not yet migrated) is not a reason to block deletion.
    return { outcome: 'no_token', tokenType: null }
  }

  if (!row) return { outcome: 'no_token', tokenType: null }

  const encrypted = row.refresh_token_encrypted ?? row.access_token_encrypted ?? null
  const tokenType: 'refresh' | 'access' | null = row.refresh_token_encrypted
    ? 'refresh'
    : row.access_token_encrypted
      ? 'access'
      : null

  if (!encrypted || !tokenType) return { outcome: 'no_token', tokenType: null }

  let plaintext: string
  try {
    plaintext = decryptToken(encrypted)
  } catch {
    // Key rotated, or a row written under an older scheme. Nothing can be sent to
    // Google, and the deletion must still go ahead.
    return { outcome: 'decrypt_failed', tokenType }
  }

  return { outcome: await revokeToken(plaintext), tokenType }
}

export type AccessTokenResult =
  | { ok: true; accessToken: string; refreshed: boolean; expiresAt: Date }
  | { ok: false; reason: 'no_grant' | 'no_refresh_token' | 'revoked' | 'refresh_failed'; error: string }

/**
 * A usable access token for this creator's channel, refreshing it if needed.
 *
 * The single entry point for acting on a creator's behalf. Callers must not read
 * `access_token_encrypted` directly: a stored access token is only valid for an
 * hour, so "decrypt whatever is in the row" works right up until it doesn't, and
 * then fails as an unexplained 401 somewhere far from the cause.
 *
 * NEVER THROWS. Every failure is a typed result, because the realistic failure —
 * the user revoking access in their Google settings — is a normal state of the
 * world, not an exception. A caller that receives `ok: false` should treat the
 * channel as no longer verified, which is exactly what has happened.
 *
 * Refreshes EARLY, at TOKEN_REFRESH_SKEW_SECONDS before expiry: a token that is
 * valid when checked can still expire during the request it is about to be used
 * for, and that race produces a 401 that looks like a bug rather than a clock.
 */
export async function getValidAccessToken(
  supabase: { from: (table: string) => any },
  creatorId: string,
  channelId: string
): Promise<AccessTokenResult> {
  const { data: row, error } = await supabase
    .from('youtube_oauth_tokens')
    .select('access_token_encrypted, refresh_token_encrypted, expires_at, channel_id')
    .eq('creator_id', creatorId)
    .eq('channel_id', channelId)
    .maybeSingle()

  if (error || !row) {
    return { ok: false, reason: 'no_grant', error: 'No YouTube grant stored for this channel' }
  }

  const expiresAt = row.expires_at ? new Date(row.expires_at) : new Date(0)
  const secondsLeft = (expiresAt.getTime() - Date.now()) / 1000

  if (secondsLeft > TOKEN_REFRESH_SKEW_SECONDS) {
    try {
      return { ok: true, accessToken: decryptToken(row.access_token_encrypted), refreshed: false, expiresAt }
    } catch {
      // Key rotated, or a row written under an older scheme. Fall through to a
      // refresh rather than failing — the refresh token may still decrypt.
    }
  }

  if (!row.refresh_token_encrypted) {
    return {
      ok: false,
      reason: 'no_refresh_token',
      error: 'Stored access token has expired and no refresh token is available',
    }
  }

  let refreshToken: string
  try {
    refreshToken = decryptToken(row.refresh_token_encrypted)
  } catch {
    return { ok: false, reason: 'refresh_failed', error: 'Stored refresh token could not be decrypted' }
  }

  let tokens: GoogleTokens
  try {
    tokens = await refreshAccessToken(refreshToken)
  } catch (err) {
    // invalid_grant on a refresh means the user revoked access (or the token was
    // expired by Google). Reported distinctly so callers can mark the channel
    // unverified instead of retrying a grant that will never work again.
    const googleError = err instanceof GoogleOAuthError ? err.googleError : null
    return {
      ok: false,
      reason: googleError === 'invalid_grant' ? 'revoked' : 'refresh_failed',
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // Persist before returning: the next caller in any process should get the fresh
  // token rather than spending another refresh on the same expiry.
  const { error: writeError } = await supabase
    .from('youtube_oauth_tokens')
    .update({
      access_token_encrypted: encryptToken(tokens.accessToken),
      // Only rewrite the refresh token when Google actually issued a NEW one.
      // refreshAccessToken echoes the old one back when Google omits it (the
      // common case), and re-encrypting an unchanged secret writes a different
      // ciphertext every time — pointless churn on the most sensitive column in
      // the database, and it makes "did the credential change?" unanswerable by
      // looking at the row.
      ...(tokens.refreshToken && tokens.refreshToken !== refreshToken
        ? { refresh_token_encrypted: encryptToken(tokens.refreshToken) }
        : {}),
      expires_at: tokens.expiresAt.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('creator_id', creatorId)
    .eq('channel_id', channelId)

  if (writeError) {
    // The token is good even if we failed to store it — returning it is better
    // than failing the caller's work over a write we can retry next time.
    logWarn('youtubeOauth.getValidAccessToken', 'Refreshed token could not be persisted; returning it anyway', {
      creator_id: creatorId,
      channel_id: channelId,
      code: (writeError as { code?: string }).code,
    })
  }

  return { ok: true, accessToken: tokens.accessToken, refreshed: true, expiresAt: tokens.expiresAt }
}

/**
 * The channels this creator owns, using a guaranteed-fresh token.
 *
 * Prefer this over calling fetchOwnedChannels with a stored token: that one takes
 * whatever token you hand it, and a stale one fails with a 401 that says nothing
 * about why.
 */
/** Why a token could not be obtained, or the channel read failed after it was. */
export type OwnedChannelsFailure =
  | 'no_grant'
  | 'no_refresh_token'
  | 'revoked'
  | 'refresh_failed'
  | 'channels_failed'

export type OwnedChannelsResult =
  | { ok: true; channels: OwnedChannel[]; refreshed: boolean }
  | { ok: false; reason: OwnedChannelsFailure; error: string }

export async function fetchOwnedChannelsForCreator(
  supabase: { from: (table: string) => any },
  creatorId: string,
  channelId: string
): Promise<OwnedChannelsResult> {
  const token = await getValidAccessToken(supabase, creatorId, channelId)
  if (!token.ok) return { ok: false, reason: token.reason, error: token.error }

  try {
    return { ok: true, channels: await fetchOwnedChannels(token.accessToken), refreshed: token.refreshed }
  } catch (err) {
    return { ok: false, reason: 'channels_failed', error: err instanceof Error ? err.message : String(err) }
  }
}
