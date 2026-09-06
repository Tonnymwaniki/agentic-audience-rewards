import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { loadHighlights } from '@/lib/highlights'
import PageHeader from '@/components/PageHeader'
import HighlightsList from './HighlightsList'

export const dynamic = 'force-dynamic'

const HIGHLIGHTS_LIMIT = 35

export default async function HighlightsPage() {
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
    console.error('Highlights creator fetch error:', JSON.stringify(creatorError, Object.getOwnPropertyNames(creatorError), 2))
    return (
      <div className="p-6">
        <p className="text-red-500">Failed to load your account details.</p>
      </div>
    )
  }

  if (!creator) {
    redirect('/login')
  }

  // Selection/ordering lives in lib/highlights so Agent Home's preview of this
  // same data can't drift out of sync with the full list here.
  const { draftHighlights, repeatedHighlights } = await loadHighlights(
    supabase,
    creator.id,
    HIGHLIGHTS_LIMIT
  )

  return (
    <div className="mx-auto max-w-3xl p-6">
      <PageHeader title="Highlights" backHref="/dashboard/agent" backLabel="Agent Home" />
      <HighlightsList draftHighlights={draftHighlights} repeatedHighlights={repeatedHighlights} />
    </div>
  )
}
