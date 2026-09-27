import { NextRequest, NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { logError } from '@/lib/logger'
import { initiateStkPush, normalizeKenyanPhone, PayHeroError } from '@/lib/payhero'
import { appBaseUrl, generateExternalReference, PRO_PLAN } from '@/lib/billing'

/**
 * Starts a Pro upgrade: validates the phone number, records a pending
 * payhero_transactions row, then fires the STK push.
 *
 * Returns as soon as the push is ACCEPTED, not once it succeeds — the phone's
 * PIN prompt happens after this responds. The client is expected to poll
 * GET /api/billing/status with the returned external_reference until it
 * resolves (see that route for why polling exists alongside the callback).
 */
export async function POST(request: NextRequest) {
  const authResult = await requireCreator()
  if (!authResult.ok) return authResult.response
  const { supabase, creatorId } = authResult.auth

  const body = await request.json().catch(() => ({}))
  const phoneNumberInput = typeof body.phoneNumber === 'string' ? body.phoneNumber : ''

  let phoneNumber: string
  try {
    phoneNumber = normalizeKenyanPhone(phoneNumberInput)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid phone number' },
      { status: 400 }
    )
  }

  const externalReference = generateExternalReference(creatorId)
  // The creator id travels in the callback URL itself, not just the request body,
  // so the callback handler can find the right row without trusting anything
  // PayHero's payload claims about identity — only about payment outcome, and
  // even that gets re-verified against the status endpoint.
  const callbackUrl = `${appBaseUrl()}/api/billing/payhero/callback?ref=${encodeURIComponent(externalReference)}`

  const { error: insertError } = await supabase.from('payhero_transactions').insert({
    creator_id: creatorId,
    external_reference: externalReference,
    plan: 'pro',
    amount_cents: PRO_PLAN.amountKes * 100,
    phone_number: phoneNumber,
    status: 'pending',
  })

  if (insertError) {
    logError('api/billing/checkout', insertError, { creator_id: creatorId, stage: 'insert_transaction' })
    return NextResponse.json({ error: 'Failed to start checkout' }, { status: 500 })
  }

  try {
    const push = await initiateStkPush({
      amount: PRO_PLAN.amountKes,
      phoneNumber,
      externalReference,
      callbackUrl,
    })

    if (push.reference) {
      await supabase
        .from('payhero_transactions')
        .update({ payhero_reference: push.reference })
        .eq('external_reference', externalReference)
    }

    return NextResponse.json({
      success: true,
      externalReference,
      message: 'Check your phone and enter your M-Pesa PIN to complete the payment.',
    })
  } catch (err) {
    await supabase
      .from('payhero_transactions')
      .update({ status: 'failed', resolved_at: new Date().toISOString() })
      .eq('external_reference', externalReference)

    const detail = err instanceof PayHeroError ? err.body : undefined
    logError('api/billing/checkout', err, { creator_id: creatorId, stage: 'stk_push', detail })
    return NextResponse.json({ error: 'Could not reach M-Pesa. Please try again.' }, { status: 502 })
  }
}
