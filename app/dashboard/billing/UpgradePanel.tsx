'use client'

import { useEffect, useRef, useState } from 'react'

type Subscription = {
  status: string
  current_period_start: string | null
  current_period_end: string | null
} | null

type Props = {
  plan: 'free' | 'pro'
  subscription: Subscription
  priceKes: number
  freeVideoLimit: number
  freeResearchLimit: number
}

type FlowState =
  | { stage: 'idle' }
  | { stage: 'submitting' }
  | { stage: 'awaiting_pin'; ref: string }
  | { stage: 'confirmed' }
  | { stage: 'failed'; message: string }

const POLL_INTERVAL_MS = 4000
const POLL_TIMEOUT_MS = 2 * 60 * 1000

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function UpgradePanel({ plan, subscription, priceKes, freeVideoLimit, freeResearchLimit }: Props) {
  const [phoneNumber, setPhoneNumber] = useState('')
  const [flow, setFlow] = useState<FlowState>({ stage: 'idle' })
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollDeadline = useRef<number>(0)

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current)
    }
  }, [])

  function startPolling(ref: string) {
    pollDeadline.current = Date.now() + POLL_TIMEOUT_MS
    if (pollTimer.current) clearInterval(pollTimer.current)

    pollTimer.current = setInterval(async () => {
      if (Date.now() > pollDeadline.current) {
        if (pollTimer.current) clearInterval(pollTimer.current)
        setFlow({
          stage: 'failed',
          message: 'Still waiting on M-Pesa confirmation. If the money left your account, refresh this page in a minute — it can take a little longer to reflect.',
        })
        return
      }

      try {
        const res = await fetch(`/api/billing/status?ref=${encodeURIComponent(ref)}`)
        const data = await res.json()

        if (data.plan === 'pro') {
          if (pollTimer.current) clearInterval(pollTimer.current)
          setFlow({ stage: 'confirmed' })
          setTimeout(() => window.location.reload(), 1500)
          return
        }

        if (data.transaction?.status === 'failed' || data.transaction?.status === 'cancelled') {
          if (pollTimer.current) clearInterval(pollTimer.current)
          setFlow({
            stage: 'failed',
            message:
              data.transaction.status === 'cancelled'
                ? 'Payment was cancelled on your phone.'
                : 'Payment failed. No charge was made — you can try again.',
          })
        }
      } catch {
        // Transient network hiccup — the next tick tries again.
      }
    }, POLL_INTERVAL_MS)
  }

  async function handleUpgrade(e: React.FormEvent) {
    e.preventDefault()
    setFlow({ stage: 'submitting' })

    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber }),
      })
      const data = await res.json()

      if (!res.ok) {
        setFlow({ stage: 'failed', message: data.error || 'Could not start checkout.' })
        return
      }

      setFlow({ stage: 'awaiting_pin', ref: data.externalReference })
      startPolling(data.externalReference)
    } catch {
      setFlow({ stage: 'failed', message: 'Network error. Please try again.' })
    }
  }

  const isActive = plan === 'pro' && subscription?.status === 'active'

  return (
    <div className="space-y-6">
      <section className="card">
        <p className="font-mono text-[10px] tracking-widest text-text-muted uppercase">Current plan</p>
        <p className="mt-1 font-display text-2xl font-semibold text-text-primary">
          {plan === 'pro' ? 'Pro' : 'Free'}
        </p>

        {isActive ? (
          <p className="mt-2 text-sm text-text-muted">
            Renews {formatDate(subscription?.current_period_end ?? null)}
          </p>
        ) : plan === 'free' ? (
          <p className="mt-2 text-sm text-text-muted">
            {freeVideoLimit} videos analyzed/month · {freeResearchLimit} research questions/month · no reply-sending yet
          </p>
        ) : (
          <p className="mt-2 text-sm text-amber-400">
            Your Pro period has ended. Renew below to restore full access.
          </p>
        )}
      </section>

      {!isActive && (
        <section className="card space-y-4">
          <div>
            <p className="font-display text-lg font-semibold text-text-primary">
              Upgrade to Pro — KES {priceKes}/month
            </p>
            <p className="mt-1 text-sm text-text-muted">
              Unlimited video analysis, unlimited research chat, and everything else Notice adds going forward.
              Paid by M-Pesa — you&apos;ll get a prompt on your phone to enter your PIN.
            </p>
          </div>

          {flow.stage === 'awaiting_pin' && (
            <div className="rounded-lg border border-purple/40 bg-purple/10 p-4 text-sm text-text-primary">
              Check your phone and enter your M-Pesa PIN to complete the payment. This updates automatically once
              it&apos;s confirmed — no need to refresh.
            </div>
          )}

          {flow.stage === 'confirmed' && (
            <div className="rounded-lg border border-green/40 bg-green-dim p-4 text-sm text-green">
              Payment confirmed — you&apos;re on Pro. Refreshing…
            </div>
          )}

          {flow.stage === 'failed' && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-400">
              {flow.message}
            </div>
          )}

          {(flow.stage === 'idle' || flow.stage === 'submitting' || flow.stage === 'failed') && (
            <form onSubmit={handleUpgrade} className="space-y-3">
              <div className="space-y-1">
                <label htmlFor="phoneNumber" className="text-sm font-medium text-text-primary">
                  M-Pesa phone number
                </label>
                <input
                  id="phoneNumber"
                  type="tel"
                  required
                  placeholder="07XX XXX XXX"
                  value={phoneNumber}
                  onChange={e => setPhoneNumber(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-white/10 bg-transparent px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-purple/50"
                />
              </div>
              <button
                type="submit"
                disabled={flow.stage === 'submitting'}
                className="inline-flex h-10 w-full items-center justify-center rounded-md bg-purple px-4 text-sm font-medium text-white transition-colors hover:bg-purple/90 disabled:opacity-50"
              >
                {flow.stage === 'submitting' ? 'Starting checkout…' : `Pay KES ${priceKes}`}
              </button>
            </form>
          )}
        </section>
      )}
    </div>
  )
}
