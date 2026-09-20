import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import PlatformGrid from './PlatformGrid'

export const dynamic = 'force-dynamic'

export const metadata = {
  // Matches the on-page heading. The separator is `·`, as the Research pages
  // already use ("Content Ideas · Research") — the root layout sets no title
  // template, so each page spells out its own suffix.
  title: 'Where should I work? · Notice',
}

export default async function PlatformHubPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold text-text-primary">Where should I work?</h1>
        <p className="mt-2 text-sm text-text-muted">
          I handle one platform at a time. YouTube is live and listening — the rest of my crew is
          still in training.
        </p>
      </div>

      <PlatformGrid />
    </div>
  )
}
