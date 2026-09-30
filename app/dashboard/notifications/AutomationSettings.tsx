'use client'

import { useEffect, useState } from 'react'

type Settings = {
  enabled: boolean
  categories: string[]
  minConfidence: string
  maxPerRun: number
  selectableCategories: string[]
  migrated: boolean
  proOnly: boolean
}

const CONFIDENCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'high', label: 'High confidence only (safest)' },
  { value: 'medium', label: 'Medium or high confidence' },
  { value: 'low', label: 'Any confidence, including low' },
]

/**
 * Lets a Pro creator turn on unattended reply-sending and set its rules —
 * which categories, how sure the agent has to be, and a per-run cap — and see
 * that at-a-glance whether it's on. The toggle is deliberately the fastest
 * thing on the page to find: turning it off is how a creator pauses
 * unattended sending immediately if something looks wrong, without hunting
 * through a settings page elsewhere.
 */
export default function AutomationSettings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/creator/automation')
      .then(res => res.json())
      .then(data => {
        if (cancelled) return
        setSettings(data)
      })
      .catch(() => {
        if (!cancelled) setError('Could not load automation settings.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function save(patch: Partial<Pick<Settings, 'enabled' | 'categories' | 'minConfidence' | 'maxPerRun'>>) {
    if (!settings) return
    const next = { ...settings, ...patch }
    setSettings(next)
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/creator/automation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        setError(body?.error || 'Could not save automation settings.')
        setSettings(settings) // revert the optimistic update
      }
    } catch {
      setError('Could not save automation settings.')
      setSettings(settings)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return null

  if (!settings) {
    return error ? <p className="card mb-4 text-sm text-red-500">{error}</p> : null
  }

  if (!settings.migrated) {
    return null
  }

  return (
    <section className="card mb-4">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex w-full min-h-11 items-center justify-between text-left"
      >
        <span className="flex items-center gap-2">
          <span className="font-body text-sm font-medium text-text-primary">Auto-reply</span>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              settings.enabled ? 'bg-green/15 text-green' : 'bg-surface-hover text-text-muted'
            }`}
          >
            {settings.enabled ? 'On' : 'Off'}
          </span>
        </span>
        <span className="text-xs text-text-muted">{expanded ? 'Hide' : 'Configure'}</span>
      </button>

      {settings.proOnly && !settings.enabled && (
        <p className="mt-1 text-xs text-text-muted">Pro feature — upgrade to send drafted replies automatically.</p>
      )}

      {expanded && (
        <div className="mt-3 space-y-4 border-t border-white/10 pt-3">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={settings.enabled}
              disabled={saving || (settings.proOnly && !settings.enabled)}
              onChange={e => void save({ enabled: e.target.checked })}
            />
            <span className="text-sm text-text-primary">
              Automatically send drafted replies that match the rules below, without waiting for manual approval.
              <span className="mt-1 block text-xs text-text-muted">
                Turn this off any time to pause sending immediately — it stops the next run, not just future ones.
              </span>
            </span>
          </label>

          <div>
            <p className="mb-1.5 text-sm font-medium text-text-primary">Categories eligible for auto-send</p>
            <div className="flex flex-wrap gap-2">
              {settings.selectableCategories.map(cat => {
                const checked = settings.categories.includes(cat)
                return (
                  <label
                    key={cat}
                    className={`flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg border px-3 text-xs font-medium ${
                      checked ? 'border-purple-text bg-purple-text/10 text-purple-text' : 'border-white/10 text-text-muted'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      disabled={saving}
                      onChange={e => {
                        const nextCategories = e.target.checked
                          ? [...settings.categories, cat]
                          : settings.categories.filter(c => c !== cat)
                        void save({ categories: nextCategories })
                      }}
                    />
                    {cat.replace(/_/g, ' ')}
                  </label>
                )
              })}
            </div>
            <p className="mt-1 text-xs text-text-muted">
              Complaints are never auto-sent — those always wait for your manual review.
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-primary" htmlFor="automation-min-confidence">
              Minimum confidence to auto-send
            </label>
            <select
              id="automation-min-confidence"
              className="min-h-11 w-full rounded-lg border border-white/10 bg-surface px-3 text-sm text-text-primary"
              value={settings.minConfidence}
              disabled={saving}
              onChange={e => void save({ minConfidence: e.target.value })}
            >
              {CONFIDENCE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-primary" htmlFor="automation-max-per-run">
              Max replies sent per run
            </label>
            <input
              id="automation-max-per-run"
              type="number"
              min={1}
              max={200}
              className="min-h-11 w-24 rounded-lg border border-white/10 bg-surface px-3 text-sm text-text-primary"
              value={settings.maxPerRun}
              disabled={saving}
              onChange={e => {
                const value = Number(e.target.value)
                if (Number.isInteger(value) && value >= 1 && value <= 200) void save({ maxPerRun: value })
              }}
            />
            <p className="mt-1 text-xs text-text-muted">Checked roughly every 30 minutes; anything past the cap waits for the next run.</p>
          </div>

          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      )}
    </section>
  )
}
