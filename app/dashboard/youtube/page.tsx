import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { creatorHasPosts, AGENT_PATH, CONNECT_PATH } from '@/lib/onboarding'

export const dynamic = 'force-dynamic'

/**
 * The YouTube entry point, reached from the platform hub. Renders nothing — it
 * decides where a creator belongs inside YouTube, then redirects.
 *
 * This is the routing that used to live at /dashboard, moved here unchanged when
 * the hub became the post-login landing. The hub card links here rather than
 * straight to /dashboard/agent on purpose: Agent Home's own safeguard sends a
 * creator with no creators row to /login, while this route sends them to Connect.
 * A direct link would bounce a brand-new account from login to the hub and back.
 *
 * Note: redirect() works by throwing, so nothing here may sit inside a try/catch —
 * it would swallow the redirect and fall through.
 */
export default async function YouTubeEntryPage() {
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
    console.error('YouTube entry creator fetch error:', JSON.stringify(creatorError, Object.getOwnPropertyNames(creatorError), 2))
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
