import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import PageHeader from '@/components/PageHeader'
import { PRO_PLAN } from '@/lib/billing'
import { FREE_LIMITS } from '@/lib/entitlements'
import UpgradePanel from './UpgradePanel'

export const dynamic = 'force-dynamic'

/**
 * Read-only server render of where the creator's billing actually stands, plus
 * the interactive upgrade/renew flow (client component, since it polls
 * /api/billing/status after triggering an STK push).
 *
 * Uses the service client for the subscriptions read the same way every other
 * creator-scoped page in this app does (see lib/api-auth.ts's comment on why):
 * RLS is enabled with no client policy on subscriptions, matching
 * youtube_oauth_tokens — a browser has no business reading billing internals
 * directly, only through requireCreator()-gated routes and this server render.
 */
export default async function BillingPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const service = createServiceClient()

  const { data: creator } = await service.from('creators').select('id, plan').eq('user_id', user.id).maybeSingle()

  if (!creator) {
    redirect('/dashboard/connect')
  }

  const { data: subscription } = await service
    .from('subscriptions')
    .select('status, current_period_start, current_period_end')
    .eq('creator_id', creator.id)
    .maybeSingle()

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title="Billing" backHref="/dashboard/me" />

      <UpgradePanel
        plan={creator.plan as 'free' | 'pro'}
        subscription={subscription ?? null}
        priceKes={PRO_PLAN.amountKes}
        freeVideoLimit={FREE_LIMITS.videosAnalyzedPerMonth}
        freeResearchLimit={FREE_LIMITS.researchQueriesPerMonth}
      />
    </div>
  )
}
