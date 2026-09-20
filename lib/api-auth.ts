import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient as createCookieClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

export type AuthedCreator = {
  supabase: SupabaseClient
  creatorId: string
  userId: string
}

type AuthResult =
  | { ok: true; auth: AuthedCreator }
  | { ok: false; response: NextResponse }

/**
 * The single gate for every API route that writes data, spends money on an LLM
 * call, or reads one creator's private data.
 *
 * Two rules, both load-bearing:
 *
 *  1. The session comes from the request cookies and is validated by
 *     auth.getUser(), which checks the JWT with the auth server rather than
 *     trusting whatever the cookie claims.
 *
 *  2. The creator id is looked up FROM that user. It is never read from the
 *     request body or query string. A creator_id in a request payload is an
 *     attacker-supplied value: honouring it lets anyone run ingestion, LLM
 *     spend and writes against any account by guessing a UUID.
 *
 * TWO SEPARATE CLIENTS, and the split is the whole point:
 *
 *   - `createCookieClient()` reads the session from cookies. Identity only.
 *   - `createServiceClient()` is what callers get back for data access.
 *
 * This used to be one client — `createServerClient(url, SERVICE_ROLE_KEY,
 * { cookies })` — which looks like a service-role client but is not one once a
 * user session exists: supabase-js sends the user's JWT instead of the key, so
 * every query ran as `authenticated` and RLS applied. RLS IS enabled on this
 * project's tables (`creators`, `posts`, `channel_videos` at least) with policies
 * that let an owner SELECT but not write, so reads worked and every write was
 * silently discarded: an UPDATE matching no rows under RLS returns success with
 * zero rows changed and no error. Routes therefore returned 200 while saving
 * nothing — that was the cause of channel connect never persisting and of the
 * business-category prompt re-asking forever.
 *
 * Because the returned client is genuinely service-role, RLS will not catch a
 * mistake: the `creator_id` filters callers write, plus requirePostOwnership()
 * below, are the only barrier. That is unchanged from the original design — it
 * simply now actually holds.
 */
export async function requireCreator(): Promise<AuthResult> {
  const authClient = await createCookieClient()

  const {
    data: { user },
  } = await authClient.auth.getUser()

  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }),
    }
  }

  const supabase = createServiceClient()

  const { data: creator } = await supabase
    .from('creators')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!creator) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'No creator profile for this account' }, { status: 403 }),
    }
  }

  return { ok: true, auth: { supabase, creatorId: creator.id, userId: user.id } }
}

/**
 * Confirms a post belongs to the given creator.
 *
 * Needed wherever a route accepts a post_id: authenticating the caller only
 * establishes WHO they are, not that the row they named is theirs. Returns a 404
 * rather than a 403 for a post owned by someone else, so the endpoint can't be
 * used to probe which post ids exist.
 */
export async function requirePostOwnership(
  supabase: SupabaseClient,
  creatorId: string,
  postId: string
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const { data: post } = await supabase
    .from('posts')
    .select('id')
    .eq('id', postId)
    .eq('creator_id', creatorId)
    .maybeSingle()

  if (!post) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Post not found' }, { status: 404 }),
    }
  }

  return { ok: true }
}
