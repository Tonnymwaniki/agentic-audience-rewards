import { NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { SupabaseClient } from '@supabase/supabase-js'

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
 * Note the service-role key: it mirrors what the already-authenticated routes in
 * this project do, and matters because the database has no RLS policies. The
 * consequence is that authorization is entirely the responsibility of this
 * function and the ownership checks its callers perform — the database will not
 * catch a mistake.
 */
export async function requireCreator(): Promise<AuthResult> {
  const cookieStore = await cookies()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll() {},
      },
    }
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }),
    }
  }

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
