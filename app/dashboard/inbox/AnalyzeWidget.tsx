'use client'

import { useState } from 'react'
import { useAnalyze } from '@/lib/hooks/useAnalyze'
import Link from 'next/link'

type AnalyzeWidgetProps = {
  creatorId: string
}

export default function AnalyzeWidget({ creatorId }: AnalyzeWidgetProps) {
  const [url, setUrl] = useState('')
  const { start, status, progressText, progressPercent, error, result } = useAnalyze(creatorId)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!url.trim() || status === 'running') return

    await start(url.trim())
  }

  return (
    <div className="mb-8">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="youtube-url" className="mb-2 block text-sm font-medium text-text-muted">
            Paste a YouTube video link
          </label>
          <input
            id="youtube-url"
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
            disabled={status === 'running'}
            className="flex h-12 w-full rounded-lg border border-white/10 bg-surface px-4 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-cobalt focus:ring-offset-2 focus:ring-offset-ink disabled:opacity-50"
          />
        </div>

        {status !== 'running' && !result && (
          <button
            type="submit"
            disabled={!url.trim()}
            className="btn-primary w-full"
          >
            Notice This Video
          </button>
        )}

        {status === 'running' && (
          <div className="space-y-3">
            <div className="h-2 overflow-hidden rounded-full bg-surface-hover">
              <div
                className="h-full rounded-full bg-cobalt transition-all duration-500"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <p className="text-sm text-text-primary">{progressText}</p>
          </div>
        )}

        {error && status === 'error' && (
          <p className="text-sm text-avax-red">{error}</p>
        )}

        {result && status === 'done' && (
          <div className="card space-y-4">
            <div>
              <h3 className="text-lg font-semibold text-text-primary">Analysis Complete</h3>
              <p className="mt-1 text-sm text-text-muted">
                Found <span className="font-medium text-text-primary">{result.commentsIngested}</span> comments,
                categorized <span className="font-medium text-text-primary">{result.categorized}</span> of them,
                and recognized <span className="font-medium text-pink">{result.qualified}</span> people worth noticing.
              </p>
            </div>
            <div className="flex gap-2">
              <a
                href={`/dashboard/inbox/${result.postId}`}
                className="btn-primary inline-flex items-center justify-center"
              >
                View Inbox
              </a>
              <button
                type="button"
                onClick={() => {
                  setResult(null)
                  setUrl('')
                }}
                className="rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-text-muted hover:bg-surface-hover hover:text-text-primary"
              >
                Analyze another
              </button>
            </div>
          </div>
        )}
      </form>
    </div>
  )
}
