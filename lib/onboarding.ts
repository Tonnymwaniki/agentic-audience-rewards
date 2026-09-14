import type { SupabaseClient } from '@supabase/supabase-js'

// Where a signed-in creator belongs depends on one thing: whether they've analyzed
// any videos yet. Both the /dashboard entry point and the Agent Home safeguard
// route on this, so the rule lives here rather than being written twice.

export const CONNECT_PATH = '/dashboard/connect'
export const AGENT_PATH = '/dashboard/agent'
/** Post-login landing: pick a platform before entering any platform's pages. */
export const HUB_PATH = '/dashboard/hub'
/** YouTube's entry route — decides between CONNECT_PATH and AGENT_PATH. */
export const YOUTUBE_ENTRY_PATH = '/dashboard/youtube'

/**
 * True if this creator has at least one analyzed video.
 *
 * Uses a head request with an exact count, so no rows cross the wire — this runs on
 * every dashboard entry and only needs the yes/no.
 *
 * Fails OPEN (returns true) on a query error. The asymmetry is deliberate: sending
 * an established creator into the onboarding flow because of a transient database
 * blip strands them somewhere they can't act, whereas a new creator wrongly sent to
 * Agent Home just sees its empty state, which already explains what to do next.
 */
export async function creatorHasPosts(
  supabase: SupabaseClient,
  creatorId: string
): Promise<boolean> {
  const { count, error } = await supabase
    .from('posts')
    .select('id', { count: 'exact', head: true })
    .eq('creator_id', creatorId)

  if (error) {
    console.error('Onboarding post-count error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
    return true
  }

  return (count ?? 0) > 0
}
