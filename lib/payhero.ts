import { logError, logInfo } from '@/lib/logger'

/**
 * PayHero M-Pesa STK push client.
 *
 * PayHero's own docs site renders client-side and resists plain fetches, so this
 * was built directly against their published PHP SDK (github.com/PAY-HERO-KENYA/
 * payhero-php-package), which is the only place the concrete request/response
 * shape is actually visible. Confirmed from that source:
 *
 *   Base URL      https://backend.payhero.co.ke/api/v2/
 *   Auth          HTTP Basic, base64(api_username:api_password) — the pair
 *                 issued at https://app.payhero.co.ke/api_keys, NOT your PayHero
 *                 account login.
 *   POST /payments            body: amount, phone_number, channel_id,
 *                             external_reference, callback_url, provider
 *   GET /transaction-status   query: reference
 *
 * No recurring-billing endpoint exists in that SDK. This is a one-off STK push
 * API — a "subscription" here is an application-level construct (see the
 * `subscriptions` table), not something PayHero tracks for you. That also means
 * there is nothing to silently auto-charge: M-Pesa STK always needs the payer to
 * enter their PIN, so every renewal is a fresh push the creator actively approves.
 *
 * PayHero's callback payload shape is not documented anywhere public, and there
 * is no visible HMAC/signature scheme to verify it came from PayHero and not from
 * anyone who guesses (or is handed, e.g. in a browser network tab) the callback
 * URL. Treat the callback as a hint that something happened, never as proof by
 * itself — the callback handler in app/api/billing/payhero/callback/route.ts
 * always re-confirms with checkTransactionStatus() before crediting a plan.
 */

const BASE_URL = 'https://backend.payhero.co.ke/api/v2'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

function authHeader(): string {
  const username = requireEnv('PAYHERO_API_USERNAME')
  const password = requireEnv('PAYHERO_API_PASSWORD')
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
}

export class PayHeroError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = 'PayHeroError'
    this.status = status
    this.body = body
  }
}

async function payheroFetch(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
  })

  const body = await response.json().catch(() => null)

  if (!response.ok) {
    throw new PayHeroError(
      (body as { error_message?: string })?.error_message || `PayHero returned ${response.status}`,
      response.status,
      body
    )
  }

  return body
}

export type StkPushRequest = {
  /** Whole KES, not cents — PayHero's amount field is the shilling amount. */
  amount: number
  /** M-Pesa phone number. Accepts 07/01-prefixed or 2547/2541-prefixed; normalized below. */
  phoneNumber: string
  /** Our own id for this attempt — becomes payhero_transactions.external_reference. */
  externalReference: string
  callbackUrl: string
}

export type StkPushResult = {
  /** PayHero's own reference for this push, used to poll status later. */
  reference: string | null
  raw: unknown
}

/**
 * Normalizes to the 2547XXXXXXXX / 2541XXXXXXXX form PayHero expects.
 * Throws on anything that isn't recognizably a Kenyan mobile number, rather than
 * sending PayHero a malformed number and getting back an opaque rejection.
 */
export function normalizeKenyanPhone(input: string): string {
  const digits = input.replace(/[^\d]/g, '')

  if (/^(254)(7|1)\d{8}$/.test(digits)) return digits
  if (/^0(7|1)\d{8}$/.test(digits)) return '254' + digits.slice(1)
  if (/^(7|1)\d{8}$/.test(digits)) return '254' + digits

  throw new Error(`"${input}" does not look like a Kenyan mobile number`)
}

/**
 * Initiates an STK push to the customer's phone. Resolves as soon as PayHero
 * accepts the request — that is NOT the same as the payment succeeding. The
 * actual outcome arrives later via callback (unverified) or is discovered by
 * polling checkTransactionStatus (verified).
 */
export async function initiateStkPush(req: StkPushRequest): Promise<StkPushResult> {
  const channelId = requireEnv('PAYHERO_CHANNEL_ID')
  const phoneNumber = normalizeKenyanPhone(req.phoneNumber)

  const raw = await payheroFetch('/payments', {
    method: 'POST',
    body: JSON.stringify({
      amount: req.amount,
      phone_number: phoneNumber,
      channel_id: channelId,
      external_reference: req.externalReference,
      callback_url: req.callbackUrl,
      provider: 'm-pesa',
    }),
  })

  logInfo('payhero.initiateStkPush', 'STK push initiated', {
    external_reference: req.externalReference,
  })

  return {
    reference: (raw as { reference?: string; CheckoutRequestID?: string })?.reference ??
      (raw as { CheckoutRequestID?: string })?.CheckoutRequestID ??
      null,
    raw,
  }
}

export type TransactionStatus = 'pending' | 'success' | 'failed' | 'cancelled' | 'unknown'

export type TransactionStatusResult = {
  status: TransactionStatus
  raw: unknown
}

/**
 * The only trustworthy source of truth for whether a push actually succeeded.
 * PayHero's exact status vocabulary in the response isn't documented publicly,
 * so this reads defensively across the field/value spellings seen in the wild
 * (`status`, `Status`, `ResultCode`) rather than assuming one shape — an unknown
 * shape maps to 'unknown', which callers must treat as "not yet confirmed",
 * never as "confirmed" or "failed".
 */
export async function checkTransactionStatus(reference: string): Promise<TransactionStatusResult> {
  const raw = await payheroFetch(`/transaction-status?reference=${encodeURIComponent(reference)}`, {
    method: 'GET',
  })

  const record = raw as Record<string, unknown>
  const rawStatus = String(record.status ?? record.Status ?? '').toLowerCase()
  const resultCode = record.ResultCode ?? record.result_code

  let status: TransactionStatus = 'unknown'
  if (rawStatus.includes('success') || resultCode === 0 || resultCode === '0') {
    status = 'success'
  } else if (rawStatus.includes('cancel')) {
    status = 'cancelled'
  } else if (rawStatus.includes('fail') || rawStatus.includes('error')) {
    status = 'failed'
  } else if (rawStatus.includes('pending') || rawStatus.includes('processing') || rawStatus === '') {
    status = 'pending'
  }

  if (status === 'unknown') {
    logError('payhero.checkTransactionStatus', new Error('Unrecognized status shape from PayHero'), { reference, raw })
  }

  return { status, raw }
}
