'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'

type EvaluateStatus = 'idle' | 'running' | 'done' | 'error'

type EvaluateButtonProps = {
  creatorId: string
  postId?: string | null
}

export default function EvaluateButton({ creatorId, postId }: EvaluateButtonProps) {
  const [status, setStatus] = useState<EvaluateStatus>('idle')
  const [progressText, setProgressText] = useState('')
  const [progressPercent, setProgressPercent] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()
  const pollingRef = useRef<NodeJS.Timeout | null>(null)

  const clearPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
  }, [])

  useEffect(() => {
    return clearPolling
  }, [clearPolling])

  async function handleClick() {
    setStatus('running')
    setError(null)
    setProgressText('Starting evaluation...')
    setProgressPercent(0)
    clearPolling()

    try {
      const response = await fetch('/api/reward/evaluate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          creator_id: creatorId,
          post_id: postId || null,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Evaluation failed to start')
      }

      if (!postId) {
        setProgressText('Evaluating all audience members...')
        setProgressPercent(50)
        setTimeout(() => {
          setStatus('done')
          router.refresh()
        }, 3000)
        return
      }

      const poll = async () => {
        try {
          const statusRes = await fetch(`/api/analyze/status?post_id=${postId}`)
          if (!statusRes.ok) return
          const statusData = await statusRes.json()

          if (statusData.analysis_stage === 'evaluating') {
            const total = statusData.members_total || 0
            const done = statusData.members_evaluated || 0
            setProgressText(`Evaluating ${done} of ${total}...`)
            setProgressPercent(total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0)
          }

          if (statusData.analysis_status === 'done' || statusData.analysis_status === 'error') {
            clearPolling()
            setStatus(statusData.analysis_status === 'done' ? 'done' : 'error')

            if (statusData.analysis_status === 'done') {
              setProgressText('Evaluation complete')
              setProgressPercent(100)
              router.refresh()
            } else {
              setError('Evaluation failed. Please try again.')
            }
          }
        } catch {
          // polling errors are non-fatal
        }
      }

      poll()
      pollingRef.current = setInterval(poll, 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setStatus('error')
      clearPolling()
    }
  }

  return (
    <div className="mb-6">
      <button
        onClick={handleClick}
        disabled={status === 'running'}
        className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {status === 'running' ? 'Evaluating...' : 'Run Reward Evaluation'}
      </button>
      {status === 'running' && (
        <div className="mt-3 w-full max-w-md">
          <div className="h-2 overflow-hidden rounded-full bg-surface-hover">
            <div
              className="h-full rounded-full bg-cobalt transition-all duration-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-text-muted">{progressText}</p>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-avax-red">{error}</p>}
      {status === 'done' && (
        <p className="mt-2 text-sm text-text-muted">
          Evaluation complete. Refresh to see updated results.
        </p>
      )}
    </div>
  )
}
