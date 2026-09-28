import { createClient as createCookieClient } from '@/lib/supabase/server'

/**
 * Who can see /dashboard/admin — a platform-wide view across every creator's
 * data, not a single creator's own. Deliberately a hardcoded allowlist rather
 * than a creators.is_admin column: this is a solo-founder tool right now, and
 * a schema column implies a flow to grant/revoke it that doesn't exist yet.
 * ADMIN_EMAILS (comma-separated) overrides this for anyone else running this
 * code, or to add a second admin later without a code change.
 */
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'mwanikitonny3@gmail.com')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean)

/**
 * True if the signed-in user (via cookies, i.e. the person actually looking at
 * the page right now) is allowed to see admin views. Returns false rather than
 * throwing for "not signed in" — the caller decides what to do (redirect, 404),
 * this just answers the yes/no.
 */
export async function isAdmin(): Promise<boolean> {
  const supabase = await createCookieClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user?.email) return false
  return ADMIN_EMAILS.includes(user.email.toLowerCase())
}
