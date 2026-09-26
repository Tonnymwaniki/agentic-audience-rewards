import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import PageHeader from '@/components/PageHeader'
import BusinessProfileForm from './BusinessProfileForm'
import { loadCustomProfileFields } from '@/lib/custom-profile-fields'
import { logError } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'
import { describeAge, factKey, factState, loadFactStatuses } from '@/lib/profile-fact-status'
import { FIXED_PROFILE_FIELDS } from '@/lib/knowledge-gaps'
import type { FactStatusView } from './FactStatusNote'

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
      'id, display_name, business_phone, business_whatsapp, business_location, business_hours, business_website, delivery_info'
    )
    .eq('user_id', user.id)
    .maybeSingle()

  // A query failure (a missing column after an unrun migration, a network blip) is
  // not an auth problem. Redirecting to /login for it makes a schema error look
  // like a session error and hides the real cause.
  if (creatorError) {
    logError('page.profile', creatorError, { user_id: user.id, stage: 'fetch_creator' })
    return (
      <div>
        <p className="text-red-500">Failed to load your profile.</p>
      </div>
    )
  }

  if (!creator) {
    redirect('/login')
  }

  // Read with the page's own RLS-scoped client: the policy on custom_profile_fields
  // limits this to the signed-in creator's own rows.
  const customFields = await loadCustomProfileFields(supabase, creator.id)

  // Stale / contradicted states. Service client: profile_fact_status is readable only
  // by the service role; creator.id comes from the session above.
  const statuses = await loadFactStatuses(createServiceClient(), creator.id)
  const factStatuses: Record<string, FactStatusView> = {}
  const view = (key: string, value: string | null) => {
    const s = factState(statuses.get(key), value?.trim() || null)
    if (s.state === 'stale') factStatuses[key] = { state: 'stale', ageLabel: describeAge(s.ageDays) }
    if (s.state === 'contradicted') factStatuses[key] = { state: 'contradicted', summary: s.summary, example: s.example }
  }
  for (const f of FIXED_PROFILE_FIELDS) view(factKey('fixed', f.column), (creator as Record<string, string | null>)[f.column] ?? null)
  for (const f of customFields) view(factKey('custom', f.fieldKey), f.fieldValue)

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Business Profile" backHref="/dashboard/agent" backLabel="Agent Home" />

      <p className="mb-6 text-sm text-text-muted">
        Real details about your business. Everything here is optional, and it&apos;s used to keep drafted
        replies accurate — so only fill in what you&apos;d be happy for your audience to be told.
      </p>

      <BusinessProfileForm
        initial={{
          // A creator row is created at signup with display_name already set to
          // the signup email, so "is it set?" cannot be a plain null check here.
          // Showing the email pre-filled would imply the creator chose it; an
          // empty box matches the hint ("leave blank and we'll use your email").
          display_name:
            creator.display_name && creator.display_name !== user.email ? creator.display_name : '',
          business_phone: creator.business_phone || '',
          business_whatsapp: creator.business_whatsapp || '',
          business_location: creator.business_location || '',
          business_hours: creator.business_hours || '',
          business_website: creator.business_website || '',
          delivery_info: creator.delivery_info || '',
        }}
        customFields={customFields}
        factStatuses={factStatuses}
      />
    </div>
  )
}
