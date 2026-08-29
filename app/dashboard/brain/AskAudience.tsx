'use client'

import { useState } from 'react'

type AskAudienceProps = {
  creatorId: string
  postId?: string | null
}

export default function AskAudience({ creatorId, postId }: AskAudienceProps) {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!question.trim()) return

    setLoading(true)
    setError(null)
    setAnswer(null)

    try {
      const response = await fetch('/api/ask', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          creator_id: creatorId,
          post_id: postId || null,
          question: question.trim(),
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to get answer')
      }

      setAnswer(data.answer)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="card">
      <h2 className="mb-4 font-display text-lg font-semibold text-text-primary">Ask your audience</h2>
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="text"
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="Ask your audience anything..."
          className="flex h-10 w-full rounded-md border border-white/10 bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-cobalt focus:ring-offset-2 focus:ring-offset-ink"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !question.trim()}
          className="btn-primary inline-flex h-10 items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Thinking...' : 'Ask'}
        </button>
      </form>

      {error && (
        <p className="mt-3 text-sm text-avax-red">{error}</p>
      )}

      {answer && (
        <div className="mt-4 rounded-md bg-surface-hover p-4">
          <p className="text-sm font-body font-medium text-text-primary">{answer}</p>
        </div>
      )}
    </div>
  )
}
