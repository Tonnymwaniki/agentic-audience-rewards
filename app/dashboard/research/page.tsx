import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import ResearchChat from './ResearchChat'

export const dynamic = 'force-dynamic'

export default async function ResearchPage() {
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
    .single()

  if (creatorError || !creator) {
    redirect('/login')
  }

  return <ResearchChat creatorId={creator.id} />
}
