'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'

type ChatMessage = { role: 'user' | 'assistant'; content: string }

const SUGGESTED_QUESTIONS = [
  "What's trending?",
  'What should I post next?',
  'What does my audience want?',
  'Show me repeated comments',
]

export default function ResearchChat({ creatorId }: { creatorId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, loading])

  async function sendMessage(text: string) {
    const trimmed = text.trim()
    if (!trimmed || loading) return

    // conversation_history is everything before this new message — the server
    // appends `message` itself as the final turn.
    const history = messages
    setMessages(prev => [...prev, { role: 'user', content: trimmed }])
    setInput('')
    setLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/research/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creator_id: creatorId,
          message: trimmed,
          conversation_history: history,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Failed to get a response')
      }

      setMessages(prev => [...prev, { role: 'assistant', content: data.reply }])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    sendMessage(input)
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex flex-shrink-0 items-center gap-4 border-b border-white/10 px-6 py-4">
        <Link href="/dashboard/agent" className="text-sm text-text-muted hover:text-text-primary">
          ← Agent
        </Link>
        <h1 className="font-display text-lg font-semibold text-text-primary">Research</h1>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-8">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center gap-6 py-16 text-center">
              <p className="text-sm text-text-muted">Ask anything about your audience.</p>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTED_QUESTIONS.map(question => (
                  <button
                    key={question}
                    onClick={() => sendMessage(question)}
                    className="rounded-full border border-white/10 bg-surface px-4 py-2 text-sm text-text-primary transition-colors hover:bg-surface-hover"
                  >
                    {question}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message, index) =>
            message.role === 'user' ? (
              <div
                key={index}
                className="ml-auto max-w-[75%] rounded-2xl rounded-br-sm bg-cobalt px-4 py-3 text-sm text-white"
              >
                {message.content}
              </div>
            ) : (
              <div key={index} className="card mr-auto max-w-[75%] rounded-tl-sm border-l-2 border-pink">
                <p className="text-sm leading-relaxed text-text-primary">{message.content}</p>
              </div>
            )
          )}

          {loading && (
            <div className="card mr-auto max-w-[75%] rounded-tl-sm border-l-2 border-pink">
              <p className="text-sm text-text-muted">Thinking...</p>
            </div>
          )}

          {error && <p className="mr-auto text-sm text-avax-red">{error}</p>}
        </div>
      </div>

      <form onSubmit={handleSubmit} className="flex-shrink-0 border-t border-white/10 px-6 py-5">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask about your audience..."
            disabled={loading}
            className="h-12 flex-1 rounded-full border border-white/10 bg-surface px-5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-cobalt focus:ring-offset-2 focus:ring-offset-ink disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!input.trim() || loading}
            className="btn-primary h-12 flex-shrink-0 rounded-full px-6 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  )
}
