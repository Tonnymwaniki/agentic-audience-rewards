import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import PlatformGrid from './PlatformGrid'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Choose a platform',
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
      <div className="mb-8">
        <h1 className="font-display text-3xl font-semibold text-text-primary">Choose a platform</h1>
        <p className="mt-2 text-sm text-text-muted">
          Your audience agent works one platform at a time. YouTube is ready now — more are on the way.
        </p>
      </div>

      <PlatformGrid />
    </div>
  )
}
