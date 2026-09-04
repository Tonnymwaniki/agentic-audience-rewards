'use client'

import { useState, useEffect } from 'react'

export default function TrackVideoToggle({ postId }: { postId: string }) {
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false

    fetch(`/api/tracked-videos?post_id=${postId}`)
      .then(res => res.json())
      .then(data => {
        if (!cancelled) setEnabled(Boolean(data.polling_enabled))
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [postId])

  async function handleToggle() {
    const next = !enabled
    setSaving(true)
    setEnabled(next)

    try {
      const response = await fetch('/api/tracked-videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post_id: postId, polling_enabled: next }),
      })

      if (!response.ok) {
        setEnabled(!next)
      }
    } catch {
      setEnabled(!next)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return null

  return (
    <button
      type="button"
      onClick={handleToggle}
      disabled={saving}
      className={`inline-flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors disabled:opacity-50 ${
        enabled
          ? 'border-cobalt bg-cobalt/10 text-cobalt'
          : 'border-white/10 bg-surface text-text-muted hover:text-text-primary'
      }`}
    >
      <span className={`h-2 w-2 rounded-full ${enabled ? 'bg-cobalt' : 'bg-text-muted'}`} />
      {enabled ? 'Tracking new comments' : 'Track this video'}
    </button>
  )
}
