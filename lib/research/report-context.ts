import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { buildResearchContext, type ToolContext } from '@/lib/research/engine'

/**
 * The tool context for a Research report page, for the signed-in creator.
 *
 * The creator is resolved from the session — never from the URL — and the same
 * service-role context the chat route builds is then used, so a report page runs
 * exactly the logic (and the same creator scoping) as the equivalent chat tool.
 *
 * Redirects to /login when there is no session or creator. Must not be called
 * inside try/catch: redirect() works by throwing.
 */
export async function getReportContext(): Promise<ToolContext> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: creator } = await supabase.from('creators').select('id').eq('user_id', user.id).maybeSingle()
  if (!creator) redirect('/login')

  return buildResearchContext(createServiceClient(), creator.id)
}
