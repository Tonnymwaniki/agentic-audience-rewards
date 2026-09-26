'use client'

import { useState } from 'react'

/** A non-OK profile-fact state, computed on the server (lib/profile-fact-status.ts). */
export type FactStatusView =
  | { state: 'stale'; ageLabel: string }
  | { state: 'contradicted'; summary: string; example: string | null }

/**
 * Shown under a Business Profile field that is STALE (not confirmed for 90+ days)
 * or CONTRADICTED (several customers recently said otherwise). Either can be cleared
 * in one click without re-editing the value; editing and saving clears it too.
 */
export default function FactStatusNote({
  source,
  fieldKey,
  status,
}: {
  source: 'fixed' | 'custom'
  fieldKey: string
  status: FactStatusView
}) {
  const [phase, setPhase] = useState<'idle' | 'saving' | 'done' | 'error'>('idle')

  async function confirm() {
    setPhase('saving')
    try {
      const res = await fetch('/api/creator/profile/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, field_key: fieldKey }),
      })
      setPhase(res.ok ? 'done' : 'error')
    } catch {
      setPhase('error')
    }
  }

  if (phase === 'done') {
    return <p className="mt-2 text-xs text-green">Confirmed as accurate — thanks.</p>
  }

  if (status.state === 'stale') {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-gold-light">Last confirmed {status.ageLabel} — still accurate?</span>
        <button
          type="button"
          onClick={confirm}
          disabled={phase === 'saving'}
          className="inline-flex min-h-9 items-center rounded-lg border border-gold/30 bg-gold-dim px-3 font-medium text-gold-light transition-colors hover:border-gold/50 disabled:opacity-50"
        >
          {phase === 'saving' ? 'Saving…' : 'Yes, still accurate'}
        </button>
        {phase === 'error' && <span className="text-avax-red">Couldn&apos;t save — try again.</span>}
      </div>
    )
  }

  return (
    <div className="mt-2 rounded-lg border border-avax-red/30 bg-avax-red/10 p-3 text-xs leading-relaxed">
      <p className="font-medium text-avax-red">Customers are saying something different</p>
      <p className="mt-1 text-text-primary">{status.summary}</p>
      {status.example && <p className="mt-1 text-text-muted italic">e.g. &ldquo;{status.example}&rdquo;</p>}
      <p className="mt-2 text-text-muted">
        Until you review it, drafted replies won&apos;t state this as fact. Update it above and save if it&apos;s
        changed, or:
      </p>
      <button
        type="button"
        onClick={confirm}
        disabled={phase === 'saving'}
        className="mt-2 inline-flex min-h-9 items-center rounded-lg border border-white/15 px-3 font-medium text-text-primary transition-colors hover:bg-surface-hover disabled:opacity-50"
      >
        {phase === 'saving' ? 'Saving…' : 'Keep as is — it’s accurate'}
      </button>
      {phase === 'error' && <span className="ml-2 text-avax-red">Couldn&apos;t save — try again.</span>}
    </div>
  )
}
