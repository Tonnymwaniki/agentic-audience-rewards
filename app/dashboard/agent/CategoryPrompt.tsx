'use client'

import { useState, useEffect } from 'react'
import { BUSINESS_CATEGORIES } from '@/lib/business-categories'

const DISMISS_KEY = 'notice.categoryPromptDismissed'

export default function CategoryPrompt() {
  // Dismissal is a per-viewer UI convenience, so it lives in localStorage rather
  // than costing a schema column. Read in an effect (not during render) so SSR and
  // the first client render agree, avoiding a hydration mismatch.
  const [dismissed, setDismissed] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    try {
      if (window.localStorage.getItem(DISMISS_KEY) === '1') setDismissed(true)
    } catch {
      // storage unavailable — just show the prompt
    }
  }, [])

  function dismiss() {
    setDismissed(true)
    try {
      window.localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // non-fatal
    }
  }

  async function selectCategory(category: string) {
    if (saving) return
    setSaving(true)
    setError(false)

    try {
      const res = await fetch('/api/creator/category', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_category: category }),
      })

      if (!res.ok) throw new Error('failed')
      setSaved(true)
    } catch {
      setError(true)
    } finally {
      setSaving(false)
    }
  }

  if (dismissed) return null

  if (saved) {
    return (
      <div className="mb-6 rounded-lg border border-purple/40 bg-purple/10 px-4 py-3">
        <p className="text-sm text-text-primary">Thanks — that helps.</p>
      </div>
    )
  }

  return (
    <div className="mb-6 rounded-lg border border-white/10 bg-surface-hover px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-text-primary">
          Help us understand your business — what category best describes your channel?
        </p>
        <button
          onClick={dismiss}
          className="flex-shrink-0 text-xs text-text-muted hover:text-text-primary"
          aria-label="Dismiss"
        >
          Not now
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {BUSINESS_CATEGORIES.map(option => (
          <button
            key={option}
            onClick={() => selectCategory(option)}
            disabled={saving}
            className="rounded-full border border-white/10 bg-surface px-3 py-1.5 text-xs text-text-muted transition-colors hover:text-text-primary disabled:opacity-50"
          >
            {option}
          </button>
        ))}
      </div>

      {error && <p className="mt-2 text-xs text-avax-red">Couldn&apos;t save that — try again.</p>}
    </div>
  )
}
