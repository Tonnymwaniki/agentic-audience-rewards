'use client'

import { useState } from 'react'

type Result = {
  regenerated: number
  skippedCasual: number
  failed: number
  remaining: number
}

export default function RegenerateDraftsButton({ postId }: { postId: string }) {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleClick() {
    if (running) return

    setRunning(true)
    setError(null)
    setResult(null)

    try {
      const res = await fetch('/api/draft-reply/regenerate-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post_id: postId }),
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Failed to regenerate drafts')
      }

      setResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={handleClick}
        disabled={running}
        className="inline-flex items-center justify-center rounded-lg border border-white/10 bg-surface px-4 py-2 text-sm font-medium text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        {running ? 'Regenerating...' : 'Regenerate all drafts'}
      </button>

      {result && (
        <p className="text-xs text-text-muted">
          {result.regenerated} draft{result.regenerated === 1 ? '' : 's'} regenerated
          {result.skippedCasual > 0 && `, ${result.skippedCasual} skipped as casual`}
          {result.failed > 0 && `, ${result.failed} failed`}
          {result.remaining > 0 && ` — ${result.remaining} left, run again to continue`}
          {'. Refresh to see them.'}
        </p>
      )}

      {error && <p className="text-xs text-avax-red">{error}</p>}
    </div>
  )
}
