import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { HUB_PATH } from '@/lib/onboarding'

export const dynamic = 'force-dynamic'

/**
 * The post-login landing route. Renders nothing — it only confirms there is a
 * session, then sends the creator to the platform hub.
 *
 * The "has this creator analyzed anything?" decision no longer happens here. It
 * is specific to YouTube, so it moved to /dashboard/youtube, which the hub's
 * YouTube card links to. Keeping /dashboard as a redirect (rather than pointing
 * the login form at the hub directly) means bookmarks and manual visits to
 * /dashboard still resolve.
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

  redirect(HUB_PATH)
}
