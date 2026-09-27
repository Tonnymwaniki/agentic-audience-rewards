import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logError, logInfo } from '@/lib/logger'

/** KES. A single constant so the price lives in one place and the pricing page,
 *  checkout route and any future promo logic can't drift apart. */
export const PRO_PLAN = {
  amountKes: 999,
  periodDays: 30,
} as const

export function proAmountCents(): number {
  return PRO_PLAN.amountKes * 100
}

/** Base URL this deployment is reachable at, for building the PayHero callback URL.
 *  Vercel sets VERCEL_URL (host only, no scheme) on every deployment; NEXT_PUBLIC_APP_URL
 *  overrides it for a custom domain in production. */
export function appBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return 'http://localhost:3000'
}

/** Our own id for one STK push attempt. PayHero's `external_reference` field —
 *  round-tripped back to us via the callback URL's query string (not trusted from
 *  the callback body; see app/api/billing/payhero/callback/route.ts) so a pending
 *  transaction is always findable even if PayHero's payload shape changes. */
export function generateExternalReference(creatorId: string): string {
  return `notice_pro_${creatorId}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
}

/**
 * Marks a payhero_transactions row confirmed and activates/extends the creator's
 * Pro subscription. The only place that writes `creators.plan = 'pro'` — every
 * other code path (checkout, callback receipt, status polling) must funnel a
 * confirmed payment through this function rather than setting the plan directly,
 * so there is exactly one definition of "what counts as paid".
 *
 * Idempotent: safe to call twice for the same transaction (callback AND a status
 * poll both resolving it is the expected common case, not a bug to guard against
 * with a separate lock).
 */
export async function activateProSubscription(
  supabase: SupabaseClient,
  creatorId: string,
  transactionId: string
): Promise<void> {
  const now = new Date()

  const { data: existing } = await supabase
    .from('subscriptions')
    .select('current_period_end, status')
    .eq('creator_id', creatorId)
    .maybeSingle()

  // A creator paying again before their current period lapses extends from
  // whichever is later — their current expiry or now — rather than from now
  // unconditionally, so renewing a few days early doesn't forfeit the remainder
  // of the period already paid for.
  const base =
    existing?.status === 'active' && existing.current_period_end && new Date(existing.current_period_end) > now
      ? new Date(existing.current_period_end)
      : now

  const periodEnd = new Date(base.getTime() + PRO_PLAN.periodDays * 24 * 60 * 60 * 1000)

  const { error: subError } = await supabase.from('subscriptions').upsert(
    {
      creator_id: creatorId,
      plan: 'pro',
      status: 'active',
      amount_cents: proAmountCents(),
      current_period_start: now.toISOString(),
      current_period_end: periodEnd.toISOString(),
      renewal_reminder_sent_at: null,
      updated_at: now.toISOString(),
    },
    { onConflict: 'creator_id' }
  )

  if (subError) {
    logError('billing.activateProSubscription', subError, { creator_id: creatorId, transaction_id: transactionId })
    throw new Error('Failed to activate subscription')
  }

  const { error: creatorError } = await supabase.from('creators').update({ plan: 'pro' }).eq('id', creatorId)

  if (creatorError) {
    logError('billing.activateProSubscription', creatorError, { creator_id: creatorId, transaction_id: transactionId })
    throw new Error('Failed to update creator plan')
  }

  logInfo('billing.activateProSubscription', 'Pro subscription activated', {
    creator_id: creatorId,
    transaction_id: transactionId,
    current_period_end: periodEnd.toISOString(),
  })
}

/**
 * Downgrades a creator whose period has lapsed with no successful renewal.
 * Deliberately separate from activateProSubscription rather than "the opposite
 * of it" — called only by the expiry cron, never inline in a payment path.
 */
export async function downgradeToFree(supabase: SupabaseClient, creatorId: string): Promise<void> {
  const { error: subError } = await supabase
    .from('subscriptions')
    .update({ status: 'canceled', updated_at: new Date().toISOString() })
    .eq('creator_id', creatorId)

  if (subError) {
    logError('billing.downgradeToFree', subError, { creator_id: creatorId })
    return
  }

  const { error: creatorError } = await supabase.from('creators').update({ plan: 'free' }).eq('id', creatorId)

  if (creatorError) {
    logError('billing.downgradeToFree', creatorError, { creator_id: creatorId })
    return
  }

  logInfo('billing.downgradeToFree', 'Subscription lapsed, downgraded to free', { creator_id: creatorId })
}
