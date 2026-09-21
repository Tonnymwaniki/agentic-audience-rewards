import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ResearchChatProvider } from './ResearchChatContext'
import { logError } from '@/lib/logger'

export const dynamic = 'force-dynamic'

/**
 * Wraps BOTH /dashboard/research and /dashboard/research/chat.
 *
 * That scope is the whole point: Next keeps a layout mounted while navigating
 * between its own child routes, so the conversation held in ResearchChatProvider
 * survives moving from the overview into the full-screen chat and back. Putting the
 * provider in either page instead would reset the conversation on every navigation.
 */
export default async function ResearchLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: creator, error } = await supabase
    .from('creators')
    .select('id, display_name')
    .eq('user_id', user.id)
    .maybeSingle()

  if (error) {
    logError('layout.research', error, { user_id: user.id, stage: 'fetch_creator' })
  }

  if (!creator) {
    redirect('/login')
  }

  // The greeting is shown by the chat's empty state, so the name is provided here
  // rather than fetched again inside it. Same fallback chain as Agent Home.
  const creatorName = creator.display_name || user.email || 'there'

  return (
    <ResearchChatProvider creatorId={creator.id} creatorName={creatorName}>
      {children}
    </ResearchChatProvider>
  )
}
