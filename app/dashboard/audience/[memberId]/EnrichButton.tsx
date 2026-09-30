'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Triggers Phase 5's on-demand channel enrichment (app/api/audience/[memberId]/enrich)
 * for this one profile. Deliberately a click, not something that fires on page
 * load — this spends real YouTube API quota per person, so it only happens when
 * a creator actually wants it for the person in front of them.
 */
export default function EnrichButton({ memberId, label }: { memberId: string; label: string }) {
  const router = useRouter()
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleClick() {
    setState('loading')
    setErrorMessage(null)
    try {
      const res = await fetch(`/api/audience/${memberId}/enrich`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setState('error')
        setErrorMessage(body.error || 'Could not fetch channel info.')
        return
      }
      setState('idle')
      router.refresh()
    } catch {
      setState('error')
      setErrorMessage('Could not fetch channel info.')
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={state === 'loading'}
        className="min-h-9 rounded-lg border border-white/10 bg-surface px-3 text-xs text-text-primary transition-colors hover:bg-surface-hover disabled:opacity-60"
      >
        {state === 'loading' ? 'Fetching…' : label}
      </button>
      {state === 'error' && errorMessage && <p className="mt-1 text-[11px] text-red-400">{errorMessage}</p>}
    </div>
  )
}
