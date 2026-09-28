import { NextRequest, NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { checkTransactionStatus } from '@/lib/payhero'
import { activateProSubscription } from '@/lib/billing'
import { logError } from '@/lib/logger'

/**
 * Two jobs in one GET:
 *
 *  1. Always returns the creator's current plan + subscription period, for the
 *     billing panel to render.
 *  2. If `?ref=` names a transaction that is STILL pending, actively re-checks
 *     it with PayHero right now rather than waiting on their callback.
 *
 * (2) exists because a webhook is a best-effort delivery, not a guarantee — if
 * PayHero's callback to us is slow, dropped, or misconfigured on their end, a
 * creator staring at "check your phone" with no callback ever arriving would be
 * stuck with no path to Pro even after actually paying. The upgrade UI polls
 * this endpoint every few seconds after checkout, which makes the callback an
 * optimization (usually faster) rather than the only way in.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireCreator()
  if (!authResult.ok) return authResult.response
  const { supabase, creatorId } = authResult.auth

  const ref = request.nextUrl.searchParams.get('ref')

  if (ref) {
    const { data: transaction } = await supabase
      .from('payhero_transactions')
      .select('id, creator_id, status, external_reference, payhero_reference')
      .eq('external_reference', ref)
      .maybeSingle()

    // GET /transaction-status only recognizes PAYHERO'S OWN reference (returned
    // when the push was initiated, stored as payhero_reference) — polling with
    // our own external_reference returns "transaction with the given reference
    // not found" (confirmed live), leaving a real, already-paid transaction
    // stuck showing as pending forever.
    if (transaction && transaction.creator_id === creatorId && transaction.status === 'pending' && transaction.payhero_reference) {
      try {
        const result = await checkTransactionStatus(transaction.payhero_reference)

        if (result.status === 'success') {
          await supabase
            .from('payhero_transactions')
            .update({ status: 'confirmed', raw_status_response: result.raw, resolved_at: new Date().toISOString() })
            .eq('id', transaction.id)
          await activateProSubscription(supabase, creatorId, transaction.id)
        } else if (result.status === 'failed' || result.status === 'cancelled') {
          await supabase
            .from('payhero_transactions')
            .update({ status: result.status, raw_status_response: result.raw, resolved_at: new Date().toISOString() })
            .eq('id', transaction.id)
        }
      } catch (err) {
        // Swallow: the panel just reports "still pending" this round and the
        // client tries again shortly. Not the caller's problem to see a 500 for.
        logError('api/billing/status', err, { creator_id: creatorId, ref, stage: 'poll' })
      }
    }
  }

  const [{ data: creator }, { data: subscription }, { data: latestTransaction }] = await Promise.all([
    supabase.from('creators').select('plan').eq('id', creatorId).maybeSingle(),
    supabase
      .from('subscriptions')
      .select('status, current_period_start, current_period_end')
      .eq('creator_id', creatorId)
      .maybeSingle(),
    ref
      ? supabase
          .from('payhero_transactions')
          .select('status, external_reference')
          .eq('external_reference', ref)
          .eq('creator_id', creatorId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  return NextResponse.json({
    plan: creator?.plan ?? 'free',
    subscription: subscription ?? null,
    transaction: latestTransaction ?? null,
  })
}
