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

// Deterministic pseudo-random (seeded by index) rather than Math.random() during
// render — this component is server-rendered then hydrated, and Math.random()
// would produce different values in each pass, causing a hydration mismatch.
function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10000
  return x - Math.floor(x)
}

// Two visual states, driven by whether the conversation has started yet:
//  - "active" (no messages sent): brighter cobalt/pink mix, higher opacity, bouncy
//  - "calm" (after the first message): the original faint, slow, muted drift
// Position/opacity/color all live on the element itself (inline style + the
// .ambient-fragment CSS transition), so React re-rendering with a new `active`
// value animates smoothly rather than snapping between states.
function AmbientBackground({
  fragments,
  active,
  dimmed,
}: {
  fragments: string[]
  active: boolean
  dimmed: boolean
}) {
  if (fragments.length === 0) return null

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 z-0 overflow-hidden transition-all duration-500 ease-out ${
        dimmed ? 'opacity-10 blur-[2px]' : 'opacity-100'
      }`}
    >
      {fragments.map((text, i) => {
        const top = seededRandom(i * 7.3 + 1) * 88
        const left = seededRandom(i * 13.7 + 2) * 78
        const duration = 24 + seededRandom(i * 3.1 + 3) * 22
        const delay = -seededRandom(i * 5.9 + 4) * duration
        const driftX = (seededRandom(i * 2.3 + 5) - 0.5) * 70
        const driftY = (seededRandom(i * 4.1 + 6) - 0.5) * 70
        const isCobalt = i % 2 === 0

        return (
          <span
            key={i}
            className={`ambient-fragment absolute whitespace-nowrap text-sm ${active ? 'ambient-fragment-active' : ''}`}
            style={{
              top: `${top}%`,
              left: `${left}%`,
              animationDuration: `${duration}s`,
              animationDelay: `${delay}s`,
              opacity: active ? 0.3 : 0.07,
              color: active ? (isCobalt ? 'var(--cobalt)' : 'var(--pink)') : 'var(--text-muted)',
              '--drift-x': `${driftX}px`,
              '--drift-y': `${driftY}px`,
            } as React.CSSProperties}
          >
            {text}
          </span>
        )
      })}
    </div>
  )
}

export default function ResearchChat({
  creatorId,
  ambientFragments = [],
}: {
  creatorId: string
  ambientFragments?: string[]
}) {
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
    <div className="relative flex h-screen flex-col overflow-hidden bg-background">
      {/* Ambient "Quiet Room" backdrop — sits behind everything; the header, message
          area, and input bar above all get z-10 so content is never obscured. It
          dims sharply (via the `loading` flag) while a message is in flight, then
          fades back once the reply lands. */}
      <AmbientBackground fragments={ambientFragments} active={messages.length === 0} dimmed={loading} />

      <header className="relative z-10 flex flex-shrink-0 items-center gap-4 border-b border-white/10 bg-background px-6 py-4">
        <Link href="/dashboard/agent" className="text-sm text-text-muted hover:text-text-primary">
          ← Agent
        </Link>
        <h1 className="font-display text-lg font-semibold text-text-primary">Research</h1>
      </header>

      <div ref={scrollRef} className="relative z-10 flex-1 overflow-y-auto px-6 py-8">
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

      <form onSubmit={handleSubmit} className="relative z-10 flex-shrink-0 border-t border-white/10 bg-background px-6 py-5">
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
