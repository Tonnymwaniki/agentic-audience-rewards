import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ResearchChatProvider } from './ResearchChatContext'

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
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (error) {
    console.error('Research layout creator fetch error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
  }

  if (!creator) {
    redirect('/login')
  }

  return <ResearchChatProvider creatorId={creator.id}>{children}</ResearchChatProvider>
}
