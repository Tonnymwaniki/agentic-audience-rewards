import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import PageHeader from '@/components/PageHeader'
import BusinessProfileForm from './BusinessProfileForm'

export const dynamic = 'force-dynamic'

export default async function BusinessProfilePage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: creator, error: creatorError } = await supabase
    .from('creators')
    .select(
      'id, business_phone, business_whatsapp, business_location, business_hours, business_website, delivery_info'
    )
    .eq('user_id', user.id)
    .maybeSingle()

  // A query failure (a missing column after an unrun migration, a network blip) is
  // not an auth problem. Redirecting to /login for it makes a schema error look
  // like a session error and hides the real cause.
  if (creatorError) {
    console.error('Business profile creator fetch error:', JSON.stringify(creatorError, Object.getOwnPropertyNames(creatorError), 2))
    return (
      <div className="p-6">
        <p className="text-red-500">Failed to load your profile.</p>
      </div>
    )
  }

  if (!creator) {
    redirect('/login')
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Business Profile" backHref="/dashboard/agent" backLabel="Agent Home" />

      <p className="mb-6 text-sm text-text-muted">
        Real details about your business. Everything here is optional, and it&apos;s used to keep drafted
        replies accurate — so only fill in what you&apos;d be happy for your audience to be told.
      </p>

      <BusinessProfileForm
        initial={{
          business_phone: creator.business_phone || '',
          business_whatsapp: creator.business_whatsapp || '',
          business_location: creator.business_location || '',
          business_hours: creator.business_hours || '',
          business_website: creator.business_website || '',
          delivery_info: creator.delivery_info || '',
        }}
      />
    </div>
  )
}
