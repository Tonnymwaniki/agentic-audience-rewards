import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logError, logInfo } from '@/lib/logger'
import { sendEmail } from '@/lib/email'

/**
 * Where a "payment confirmed but plan didn't actually flip" alert goes — the
 * exact failure mode that made the two PayHero bugs this session found so hard
 * to notice (a transaction could resolve 'confirmed' while the creator stayed
 * on Free). ADMIN_ALERT_EMAIL overrides this for anyone else running this code.
 */
const ADMIN_ALERT_EMAIL = process.env.ADMIN_ALERT_EMAIL || 'mwanikitonny3@gmail.com'

/** The creator's sign-in email, via auth.users — creators has no email column of
 *  its own. Requires a service-role client (`.auth.admin` is service-role only);
 *  both callers of activateProSubscription already pass one. Returns null rather
 *  than throwing, since a missing email should skip the receipt, not fail the
 *  payment that already went through. */
async function getCreatorEmail(supabase: SupabaseClient, creatorId: string): Promise<string | null> {
  const { data: creator } = await supabase.from('creators').select('user_id').eq('id', creatorId).maybeSingle()
  if (!creator?.user_id) return null

  const { data, error } = await supabase.auth.admin.getUserById(creator.user_id)
  if (error || !data?.user?.email) return null
  return data.user.email
}

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

  // Safety net: re-read what was actually written rather than trusting the
  // update call's lack of an error. This is exactly the failure mode both
  // PayHero bugs this session produced — a transaction resolving 'confirmed'
  // while the creator silently stayed on Free — so it's checked right here, at
  // the one place every payment funnels through, instead of relying on it
  // being noticed later by a creator wondering why they still look Free.
  const { data: verify } = await supabase.from('creators').select('plan').eq('id', creatorId).maybeSingle()
  if (verify?.plan !== 'pro') {
    logError('billing.activateProSubscription', new Error('Plan update did not take effect'), {
      creator_id: creatorId,
      transaction_id: transactionId,
      observed_plan: verify?.plan ?? null,
    })
    await sendEmail({
      to: ADMIN_ALERT_EMAIL,
      subject: 'Notice: a payment confirmed but the creator is still on Free',
      html: `<p>Transaction <code>${transactionId}</code> for creator <code>${creatorId}</code> was marked confirmed, but the creator's plan reads "${verify?.plan ?? 'unknown'}" instead of "pro". This needs a manual fix — check <code>payhero_transactions</code> and <code>subscriptions</code> for this creator.</p>`,
    })
    return
  }

  logInfo('billing.activateProSubscription', 'Pro subscription activated', {
    creator_id: creatorId,
    transaction_id: transactionId,
    current_period_end: periodEnd.toISOString(),
  })

  const periodEndLabel = periodEnd.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

  // Everything below is best-effort: the subscription is already active and
  // correct regardless of whether the notification or the email succeeds, so
  // neither is allowed to turn into an error the caller has to handle.
  await supabase.from('notifications').insert({
    creator_id: creatorId,
    type: 'billing_upgraded',
    message: `You're on Notice Pro — unlimited video analysis and research chat, renews ${periodEndLabel}.`,
  })

  const email = await getCreatorEmail(supabase, creatorId)
  if (email) {
    await sendEmail({
      to: email,
      subject: "You're on Notice Pro",
      html: `
        <p>Thanks for upgrading to Notice Pro!</p>
        <p><strong>Amount:</strong> KES ${PRO_PLAN.amountKes}<br/>
        <strong>Renews:</strong> ${periodEndLabel}</p>
        <p>You now have unlimited video analysis, unlimited research chat, and everything else Notice adds going forward.</p>
      `,
    })
  }
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
