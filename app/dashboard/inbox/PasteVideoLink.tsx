'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useAnalyze } from '@/lib/hooks/useAnalyze'

export default function PasteVideoLink({ creatorId }: { creatorId: string }) {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const { start, status, progressText, progressPercent, error, result } = useAnalyze(creatorId)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!url.trim() || status === 'running') return
    start(url.trim())
  }

  function handleClose() {
    setOpen(false)
    setUrl('')
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-4 text-sm text-cobalt underline hover:text-cobalt-hover"
      >
        + Paste a video link instead
      </button>
    )
  }

  return (
    <div className="card mb-6">
      {result && status === 'done' ? (
        <div className="space-y-3">
          <p className="text-sm text-text-primary">
            Analysis complete — <span className="font-medium">{result.commentsIngested}</span> comments found.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href={`/dashboard/inbox/${result.postId}`} className="btn-primary">
              View Results
            </Link>
            <button
              type="button"
              onClick={handleClose}
              className="text-sm text-text-muted underline hover:text-text-primary"
            >
              Close
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="flex items-center justify-between">
            <label htmlFor="paste-video-url" className="text-sm font-medium text-text-muted">
              Paste a single video link
            </label>
            <button
              type="button"
              onClick={handleClose}
              className="text-xs text-text-muted underline hover:text-text-primary"
            >
              Cancel
            </button>
          </div>
          <input
            id="paste-video-url"
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
            disabled={status === 'running'}
            className="flex h-10 w-full rounded-md border border-white/10 bg-surface px-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-cobalt focus:ring-offset-2 focus:ring-offset-ink disabled:opacity-50"
          />

          {status === 'running' && (
            <div className="space-y-2">
              <div className="h-2 overflow-hidden rounded-full bg-surface-hover">
                <div
                  className="h-full rounded-full bg-cobalt transition-all duration-500"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <p className="text-xs text-text-muted">{progressText}</p>
            </div>
          )}

          {error && status === 'error' && (
            <p className="text-xs text-avax-red">{error}</p>
          )}

          <button
            type="submit"
            disabled={!url.trim() || status === 'running'}
            className="btn-primary disabled:opacity-50"
          >
            {status === 'running' ? 'Analyzing...' : 'Analyze Video'}
          </button>
        </form>
      )}
    </div>
  )
}
