import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { checkTransactionStatus } from '@/lib/payhero'
import { activateProSubscription } from '@/lib/billing'
import { logError, logInfo, logWarn } from '@/lib/logger'

/**
 * PayHero's webhook target. Called by PayHero's servers, not by a signed-in
 * creator — there is no session here, hence the service-role client and the
 * `ref` query param (set by us in the callback_url when the push was created)
 * as the only trusted way to find which transaction this is about.
 *
 * PayHero's callback body is UNTRUSTED. Their docs don't publish a payload
 * schema or a signature scheme, so this handler treats the POST body only as a
 * signal to re-check now, and always re-derives the actual outcome from
 * GET /transaction-status before crediting anything — the same call
 * app/api/billing/status/route.ts makes when polling. That is what makes a
 * forged or replayed callback harmless: the worst it can do is trigger an extra
 * status check, which is idempotent.
 *
 * Always returns 200 on a request that was at least parseable, so PayHero does
 * not retry-storm a case we've already handled (e.g. a reference that resolved
 * seconds ago via the status-polling fallback).
 */
export async function POST(request: NextRequest) {
  const ref = request.nextUrl.searchParams.get('ref')
  const rawBody = await request.json().catch(() => null)

  if (!ref) {
    logWarn('api/billing/payhero/callback', 'Callback received with no ref query param', { raw: rawBody })
    return NextResponse.json({ ok: true })
  }

  const supabase = createServiceClient()

  const { data: transaction, error: fetchError } = await supabase
    .from('payhero_transactions')
    .select('id, creator_id, status, external_reference, payhero_reference')
    .eq('external_reference', ref)
    .maybeSingle()

  if (fetchError || !transaction) {
    logWarn('api/billing/payhero/callback', 'Callback for unknown external_reference', { ref })
    return NextResponse.json({ ok: true })
  }

  await supabase.from('payhero_transactions').update({ raw_callback: rawBody }).eq('id', transaction.id)

  if (transaction.status !== 'pending') {
    // Already resolved by a previous callback delivery or a status poll.
    return NextResponse.json({ ok: true })
  }

  // GET /transaction-status only recognizes PAYHERO'S OWN reference (returned
  // when the push was initiated, stored as payhero_reference) — our own
  // external_reference is meaningless to their lookup and returns "transaction
  // with the given reference not found" (confirmed live, not just from docs).
  if (!transaction.payhero_reference) {
    logWarn('api/billing/payhero/callback', 'No payhero_reference stored yet; cannot verify', { ref })
    return NextResponse.json({ ok: true })
  }

  try {
    const result = await checkTransactionStatus(transaction.payhero_reference)
    await resolveTransaction(supabase, transaction, result)
  } catch (err) {
    // Leave it pending — the status-polling fallback (app/api/billing/status)
    // will retry this same verification the next time the client checks in.
    logError('api/billing/payhero/callback', err, { ref, stage: 'verify' })
  }

  return NextResponse.json({ ok: true })
}

async function resolveTransaction(
  supabase: ReturnType<typeof createServiceClient>,
  transaction: { id: string; creator_id: string; external_reference: string },
  result: Awaited<ReturnType<typeof checkTransactionStatus>>
) {
  if (result.status === 'success') {
    await supabase
      .from('payhero_transactions')
      .update({ status: 'confirmed', raw_status_response: result.raw, resolved_at: new Date().toISOString() })
      .eq('id', transaction.id)

    await activateProSubscription(supabase, transaction.creator_id, transaction.id)

    logInfo('api/billing/payhero/callback', 'Payment confirmed via status check', {
      creator_id: transaction.creator_id,
      external_reference: transaction.external_reference,
    })
  } else if (result.status === 'failed' || result.status === 'cancelled') {
    await supabase
      .from('payhero_transactions')
      .update({
        status: result.status,
        raw_status_response: result.raw,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', transaction.id)
  }
  // 'pending' or 'unknown': leave the row untouched. The status route's poll
  // (or PayHero's eventual retry of this same callback) will resolve it later.
}
