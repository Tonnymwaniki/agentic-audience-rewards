'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

type EvaluateButtonProps = {
  creatorId: string
  postId?: string | null
}

export default function EvaluateButton({ creatorId, postId }: EvaluateButtonProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [evaluated, setEvaluated] = useState<number | null>(null)
  const [qualified, setQualified] = useState<number | null>(null)
  const router = useRouter()

  async function handleClick() {
    setLoading(true)
    setError(null)
    setEvaluated(null)
    setQualified(null)

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
        throw new Error(data.error || 'Evaluation failed')
      }

      setEvaluated(data.evaluated)
      setQualified(data.qualified)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mb-6">
      <button
        onClick={handleClick}
        disabled={loading}
        className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? 'Evaluating...' : 'Run Reward Evaluation'}
      </button>
      {error && <p className="mt-2 text-sm text-avax-red">{error}</p>}
      {evaluated !== null && qualified !== null && !error && (
        <p className="mt-2 text-sm text-text-muted">
          Evaluated {evaluated} members, {qualified} qualified.
        </p>
      )}
    </div>
  )
}
