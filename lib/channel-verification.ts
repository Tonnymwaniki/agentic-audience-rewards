import type { SupabaseClient } from '@supabase/supabase-js'
import { logWarn } from '@/lib/logger'

/**
 * Capability gating by verified channel ownership.
 *
 * The rule, decided per capability rather than per account:
 *
 *   READING is open.    Categorization, sentiment, topics, search, research chat,
 *                       browsing comments — all unchanged. Analyzing a channel you
 *                       don't own is a legitimate thing to do (competitor research),
 *                       and gating it would break the product for no safety gain.
 *
 *   ACTING is gated.    Drafting replies in a creator's voice, and recognizing or
 *                       paying their audience, both act AS the channel owner toward
 *                       real people. Doing that for a channel you cannot prove you
 *                       own is the part that is actually dangerous: it puts words in
 *                       a stranger's mouth and spends money on their audience.
 *
 * Verification means a Google OAuth grant (lib/youtube-oauth.ts) whose
 * channels.list?mine=true answer included THIS channel id. Per channel, not per
 * account: a creator who has analyzed six channels and verified one gets the acting
 * capabilities on that one only.
 */

/** Verified channel ids per creator, memoised per request-ish lifetime. */
const verifiedCache = new Map<string, { ids: string[]; at: number }>()
const CACHE_TTL_MS = 30_000

/** channel id -> human title, filled opportunistically from lookups. */
const channelTitles = new Map<string, string>()

/** post id -> channel id. Immutable fact, so it never needs invalidating. */
const postChannelCache = new Map<string, string | null>()

/**
 * Set false the first time the database rejects posts.channel_id as unknown, so a
 * deploy that lands before migration 36 keeps working (falling back to a YouTube
 * lookup) instead of failing every gate check. Mirrors the optional-column pattern
 * already used in lib/ingest.ts.
 */
let channelIdColumnAvailable = true

export type VerificationReason =
  | 'verified'
  /** No OAuth grant at all for this creator. */
  | 'no_grant'
  /** A grant exists, but for a different channel than the one being acted on. */
  | 'channel_mismatch'
  /** We could not work out which channel the post belongs to. */
  | 'unknown_channel'

export type VerificationResult = {
  verified: boolean
  /** The channel the action concerns, when known. */
  channelId: string | null
  reason: VerificationReason
}

/**
 * The channel ids this creator has proven they own.
 *
 * "Valid, non-revoked" is judged from what we hold: a row for this creator, with a
 * channel id, that we can still act with — either a refresh token (good until the
 * user revokes it at Google) or an access token that has not yet expired. A row
 * whose access token expired and that has no refresh token can no longer prove
 * anything, so it does not count.
 *
 * Deliberately NOT calling Google to test revocation on every check. That would put
 * a network round trip in front of every drafted reply, and a Google outage would
 * silently revoke everyone. Revocation surfaces the next time a token is actually
 * used, which is where it can be handled properly.
 */
export async function getVerifiedChannelIds(
  supabase: SupabaseClient,
  creatorId: string
): Promise<string[]> {
  const cached = verifiedCache.get(creatorId)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.ids

  const { data, error } = await supabase
    .from('youtube_oauth_tokens')
    .select('channel_id, refresh_token_encrypted, expires_at')
    .eq('creator_id', creatorId)

  if (error) {
    // A missing table (pre-migration) must not accidentally grant access.
    logWarn('channelVerification.getVerifiedChannelIds', 'Could not read OAuth grants; treating as unverified', {
      creator_id: creatorId,
      code: error.code,
    })
    return []
  }

  const now = Date.now()
  const ids = (data ?? [])
    .filter(row => {
      if (!row.channel_id) return false
      if (row.refresh_token_encrypted) return true
      return row.expires_at ? new Date(row.expires_at).getTime() > now : false
    })
    .map(row => row.channel_id as string)

  verifiedCache.set(creatorId, { ids, at: Date.now() })
  return ids
}

/**
 * Does this creator hold a verified grant for this specific channel?
 *
 * The signature asked for in the brief. Both arguments matter: a creator with a
 * grant for channel A must not be able to act on channel B.
 */
export async function isChannelVerified(
  supabase: SupabaseClient,
  creatorId: string,
  channelId: string | null | undefined
): Promise<boolean> {
  if (!channelId) return false
  const ids = await getVerifiedChannelIds(supabase, creatorId)
  return ids.includes(channelId)
}

/**
 * Which YouTube channel a stored post belongs to.
 *
 * Prefers posts.channel_id (migration 36). Falls back to asking YouTube, so the
 * gate works on posts ingested before that column existed and before the migration
 * is applied — and writes the answer back when it can, so the lookup happens once.
 */
export async function resolvePostChannelId(
  supabase: SupabaseClient,
  postId: string
): Promise<string | null> {
  if (postChannelCache.has(postId)) return postChannelCache.get(postId) ?? null

  const columns = channelIdColumnAvailable ? 'id, external_post_id, channel_id' : 'id, external_post_id'
  let { data: post, error } = await supabase.from('posts').select(columns).eq('id', postId).maybeSingle()

  if (error && (error.code === 'PGRST204' || error.code === '42703') && channelIdColumnAvailable) {
    channelIdColumnAvailable = false
    logWarn('channelVerification.resolvePostChannelId', 'posts.channel_id does not exist yet (migration 36); falling back to YouTube', {
      post_id: postId,
    })
    ;({ data: post, error } = await supabase.from('posts').select('id, external_post_id').eq('id', postId).maybeSingle())
  }

  if (error || !post) {
    postChannelCache.set(postId, null)
    return null
  }

  const row = post as unknown as { external_post_id: string; channel_id?: string | null }
  if (row.channel_id) {
    postChannelCache.set(postId, row.channel_id)
    return row.channel_id
  }

  const channelId = await fetchChannelIdForVideo(row.external_post_id)
  postChannelCache.set(postId, channelId)

  if (channelId && channelIdColumnAvailable) {
    // Best effort: a failure here only costs a repeat lookup next process.
    await supabase.from('posts').update({ channel_id: channelId }).eq('id', postId)
  }

  return channelId
}

async function fetchChannelIdForVideo(videoId: string): Promise<string | null> {
  if (!process.env.YOUTUBE_API_KEY || !videoId) return null
  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/videos')
    url.searchParams.set('part', 'snippet')
    url.searchParams.set('id', videoId)
    url.searchParams.set('key', process.env.YOUTUBE_API_KEY)
    const res = await fetch(url.toString())
    if (!res.ok) return null
    const data = (await res.json()) as { items?: Array<{ snippet?: { channelId?: string } }> }
    return data.items?.[0]?.snippet?.channelId ?? null
  } catch {
    return null
  }
}

/**
 * The gate used by every acting capability: may this creator act on this post?
 *
 * Fails CLOSED. An unknown channel is not verified — if we cannot establish which
 * channel a post belongs to, we cannot have proof the creator owns it, and the
 * safe answer is no.
 */
export async function checkPostVerification(
  supabase: SupabaseClient,
  creatorId: string,
  postId: string
): Promise<VerificationResult> {
  const channelId = await resolvePostChannelId(supabase, postId)
  if (!channelId) return { verified: false, channelId: null, reason: 'unknown_channel' }

  const ids = await getVerifiedChannelIds(supabase, creatorId)
  if (ids.length === 0) return { verified: false, channelId, reason: 'no_grant' }
  if (!ids.includes(channelId)) return { verified: false, channelId, reason: 'channel_mismatch' }

  return { verified: true, channelId, reason: 'verified' }
}

/** Shown wherever a gated capability is refused. One wording, everywhere. */
export const VERIFY_OWNERSHIP_MESSAGE =
  'Verify channel ownership to enable drafted replies and rewards.'

export const VERIFY_OWNERSHIP_PATH = '/api/auth/youtube/start'

/** Tests and the OAuth callback both need to drop the memoised answers. */
export function clearVerificationCache(): void {
  verifiedCache.clear()
  postChannelCache.clear()
}

/** Stands in for posts whose channel could not be determined. */
export const UNKNOWN_CHANNEL_ID = '__unresolved__'

export type ChannelSummary = {
  channelId: string
  title: string | null
  postCount: number
  verified: boolean
}

/**
 * Per-channel verification status across everything this creator has analyzed.
 *
 * Powers the My Videos banner. Resolves missing channel ids in ONE batched
 * videos.list call rather than one per post — the per-post fallback in
 * resolvePostChannelId is fine for a single gate check but would put dozens of
 * round trips in front of a page render.
 */
export async function getChannelVerificationSummary(
  supabase: SupabaseClient,
  creatorId: string
): Promise<ChannelSummary[]> {
  // Typed as unknown on purpose: the select list varies at runtime, and supabase-js
  // infers a different row type per literal, which cannot be reassigned.
  const runQuery = (cols: string) =>
    supabase.from('posts').select(cols).eq('creator_id', creatorId) as unknown as Promise<{
      data: Array<{ id: string; external_post_id: string; channel_id?: string | null }> | null
      error: { code?: string } | null
    }>

  let { data, error } = await runQuery(
    channelIdColumnAvailable ? 'id, external_post_id, channel_id' : 'id, external_post_id'
  )

  if (error && (error.code === 'PGRST204' || error.code === '42703')) {
    channelIdColumnAvailable = false
    ;({ data, error } = await runQuery('id, external_post_id'))
  }
  if (error || !data) return []

  const posts = data
  const unresolved = posts.filter(p => !p.channel_id).map(p => p.external_post_id).filter(Boolean)
  const resolved = new Map<string, string>()

  for (let i = 0; i < unresolved.length && process.env.YOUTUBE_API_KEY; i += 50) {
    try {
      const url = new URL('https://www.googleapis.com/youtube/v3/videos')
      url.searchParams.set('part', 'snippet')
      url.searchParams.set('id', unresolved.slice(i, i + 50).join(','))
      url.searchParams.set('key', process.env.YOUTUBE_API_KEY)
      const res = await fetch(url.toString())
      if (!res.ok) break
      const body = (await res.json()) as { items?: Array<{ id: string; snippet?: { channelId?: string; channelTitle?: string } }> }
      for (const item of body.items ?? []) {
        if (item.snippet?.channelId) resolved.set(item.id, item.snippet.channelId)
        if (item.snippet?.channelId && item.snippet.channelTitle) channelTitles.set(item.snippet.channelId, item.snippet.channelTitle)
      }
    } catch {
      break
    }
  }

  const counts = new Map<string, number>()
  let unresolvedCount = 0
  for (const post of posts) {
    const channelId = post.channel_id || resolved.get(post.external_post_id)
    if (!channelId) {
      // Deleted from YouTube, private, or a quota failure. These posts still
      // cannot use the gated capabilities, so they must not silently vanish from
      // the banner — that would hide the verify CTA from someone who needs it.
      unresolvedCount++
      continue
    }
    counts.set(channelId, (counts.get(channelId) ?? 0) + 1)
  }

  // Titles used to arrive free with the per-post fallback lookup. Once
  // posts.channel_id is populated that lookup no longer runs, so the banner would
  // show raw "UCI5O8MTvXB_Rq0fjvgdo_Iw" instead of "Frost Thirlwell". One
  // channels.list call covers up to 50 channels, so names cost one request total.
  const needTitles = [...counts.keys()].filter(id => id !== UNKNOWN_CHANNEL_ID && !channelTitles.has(id))
  for (let i = 0; i < needTitles.length && process.env.YOUTUBE_API_KEY; i += 50) {
    try {
      const url = new URL('https://www.googleapis.com/youtube/v3/channels')
      url.searchParams.set('part', 'snippet')
      url.searchParams.set('id', needTitles.slice(i, i + 50).join(','))
      url.searchParams.set('key', process.env.YOUTUBE_API_KEY)
      const res = await fetch(url.toString())
      if (!res.ok) break
      const body = (await res.json()) as { items?: Array<{ id: string; snippet?: { title?: string } }> }
      for (const item of body.items ?? []) {
        if (item.snippet?.title) channelTitles.set(item.id, item.snippet.title)
      }
    } catch {
      break
    }
  }

  const verifiedIds = await getVerifiedChannelIds(supabase, creatorId)

  // A verified channel with nothing analyzed yet still belongs in the list — it is
  // the one the creator just connected, and showing it confirms the connection took.
  const { data: grants } = await supabase
    .from('youtube_oauth_tokens')
    .select('channel_id, channel_title')
    .eq('creator_id', creatorId)
  for (const grant of (grants ?? []) as Array<{ channel_id: string | null; channel_title: string | null }>) {
    if (!grant.channel_id) continue
    if (grant.channel_title) channelTitles.set(grant.channel_id, grant.channel_title)
    if (!counts.has(grant.channel_id)) counts.set(grant.channel_id, 0)
  }

  if (unresolvedCount > 0) counts.set(UNKNOWN_CHANNEL_ID, unresolvedCount)

  return [...counts.entries()]
    .map(([channelId, postCount]) => ({
      channelId,
      title: channelTitles.get(channelId) ?? null,
      postCount,
      verified: verifiedIds.includes(channelId),
    }))
    // Unverified first: the row that needs action leads.
    .sort((a, b) => Number(a.verified) - Number(b.verified) || b.postCount - a.postCount)
}

/**
 * Which of these posts belong to a channel this creator has verified.
 *
 * The per-post form of isChannelVerified, for callers that act across many posts
 * at once (creator-wide reward evaluation). One grant lookup for the whole set,
 * then a local channel read per post — posts.channel_id is populated, so this is
 * not a network round trip per post except for rows that predate migration 36.
 *
 * Fails closed: a post whose channel cannot be resolved is NOT included.
 */
export async function resolveVerifiedPostIds(
  supabase: SupabaseClient,
  creatorId: string,
  postIds: string[]
): Promise<Set<string>> {
  const verified = new Set<string>()
  if (postIds.length === 0) return verified

  const channelIds = await getVerifiedChannelIds(supabase, creatorId)
  if (channelIds.length === 0) return verified

  for (const postId of postIds) {
    const channelId = await resolvePostChannelId(supabase, postId)
    if (channelId && channelIds.includes(channelId)) verified.add(postId)
  }
  return verified
}
