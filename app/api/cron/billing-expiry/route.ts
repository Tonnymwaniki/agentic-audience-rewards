import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { isCronAuthorized } from '@/lib/cron-auth'
import { downgradeToFree } from '@/lib/billing'
import { logError } from '@/lib/logger'

/**
 * Daily: downgrades any Pro creator whose period has lapsed with no renewal,
 * and flags subscriptions renewing soon so the dashboard's billing panel can
 * show "renews in 2 days" / "renew now" — there is no separate reminder
 * notification row (notifications.comment_id is NOT NULL, i.e. that table is
 * purpose-built for comment alerts, not account-level ones); the billing
 * status endpoint and dashboard read current_period_end directly instead.
 *
 * No auto-charging happens here, deliberately: M-Pesa STK always needs the
 * payer to enter their PIN on their phone, so there is nothing this job COULD
 * silently charge — renewal is always the creator tapping "Renew" in-app,
 * which calls POST /api/billing/checkout same as a first-time upgrade.
 */
export const maxDuration = 60

const REMINDER_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET) {
    logError('api/cron/billing-expiry', new Error('CRON_SECRET is not configured'), { stage: 'auth_precondition' })
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
  }

  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const now = new Date()

  const { data: lapsed, error: lapsedError } = await supabase
    .from('subscriptions')
    .select('creator_id')
    .eq('status', 'active')
    .lt('current_period_end', now.toISOString())

  if (lapsedError) {
    logError('api/cron/billing-expiry', lapsedError, { stage: 'select_lapsed' })
    return NextResponse.json({ error: 'Failed to query lapsed subscriptions' }, { status: 500 })
  }

  for (const row of lapsed ?? []) {
    await downgradeToFree(supabase, row.creator_id)
  }

  const { data: renewingSoon, error: reminderError } = await supabase
    .from('subscriptions')
    .select('id')
    .eq('status', 'active')
    .is('renewal_reminder_sent_at', null)
    .lt('current_period_end', new Date(now.getTime() + REMINDER_WINDOW_MS).toISOString())
    .gt('current_period_end', now.toISOString())

  if (reminderError) {
    logError('api/cron/billing-expiry', reminderError, { stage: 'select_renewing_soon' })
  } else if (renewingSoon && renewingSoon.length > 0) {
    await supabase
      .from('subscriptions')
      .update({ renewal_reminder_sent_at: now.toISOString() })
      .in('id', renewingSoon.map(r => r.id))
  }

  return NextResponse.json({
    downgraded: lapsed?.length ?? 0,
    flaggedForReminder: renewingSoon?.length ?? 0,
  })
}
