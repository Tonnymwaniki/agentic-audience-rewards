import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { creatorHasPosts, AGENT_PATH, CONNECT_PATH } from '@/lib/onboarding'

export const dynamic = 'force-dynamic'

/**
 * The post-login landing route. Renders nothing — it exists purely to decide where
 * a signed-in creator should go, then redirect.
 *
 * Doing this server-side rather than in the login form means the decision is made
 * once, in one place, with the session already established: no client round-trip
 * after sign-in, no flash of the wrong screen, and bookmarks or manual visits to
 * /dashboard (which previously 404'd) resolve correctly too.
 *
 * Note: redirect() works by throwing, so nothing here may sit inside a try/catch —
 * it would swallow the redirect and fall through.
 */
export default async function DashboardIndexPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: creator, error: creatorError } = await supabase
    .from('creators')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (creatorError) {
    console.error('Dashboard routing creator fetch error:', JSON.stringify(creatorError, Object.getOwnPropertyNames(creatorError), 2))
    // The connect flow creates/repairs the creator row, so it's the safe landing
    // when we can't read one.
    redirect(CONNECT_PATH)
  }

  // A brand-new account has no creators row yet — that's onboarding, not an error.
  if (!creator) {
    redirect(CONNECT_PATH)
  }

  redirect((await creatorHasPosts(supabase, creator.id)) ? AGENT_PATH : CONNECT_PATH)
}
