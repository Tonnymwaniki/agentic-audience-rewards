'use client'

import { useCallback, useEffect, useState } from 'react'
import { useResearchChat } from './ResearchChatContext'

type ConversationSummary = {
  id: string
  title: string | null
  createdAt: string
  updatedAt: string
  messageCount: number
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (isNaN(date.getTime())) return ''
  const diffMin = Math.floor((Date.now() - date.getTime()) / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour}h ago`
  const diffDay = Math.floor(diffHour / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * Past Research conversations, most recently active first.
 *
 * A panel rather than its own route: opening one has to land the creator back in
 * the chat they were already looking at, and a separate page would mean a
 * navigation out and another back in.
 */
export default function ConversationHistory({
  open,
  onClose,
  onOpened,
}: {
  open: boolean
  onClose: () => void
  /** Fired after a conversation is loaded, so the caller can switch views. */
  onOpened?: () => void
}) {
  const { loadConversation, conversationId, loadingConversation } = useResearchChat()
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/research/conversations')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not load your conversations')
      setConversations(data.conversations ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your conversations')
    } finally {
      setLoading(false)
    }
  }, [])

  // Re-read on every open: a conversation the creator has just added to should be
  // at the top with its new title, not whatever was cached when the panel first
  // mounted.
  useEffect(() => {
    if (open) load()
  }, [open, load])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      <header
        className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3"
        style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}
      >
        <button
          onClick={onClose}
          className="-ml-1 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-text-muted transition-colors active:bg-surface-hover"
        >
          <span aria-hidden="true" className="text-base leading-none">←</span>
          Back
        </button>
        <h1 className="font-display text-base font-semibold text-text-primary">Your conversations</h1>
        <span aria-hidden="true" className="w-14" />
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading && <p className="py-6 text-center text-sm text-text-muted">Loading…</p>}
        {error && <p className="py-6 text-center text-sm text-avax-red">{error}</p>}

        {!loading && !error && conversations.length === 0 && (
          <p className="py-10 text-center text-sm text-text-muted">
            No saved conversations yet. Ask something and it will appear here.
          </p>
        )}

        <ul className="space-y-2">
          {conversations.map(c => (
            <li key={c.id}>
              <button
                type="button"
                disabled={loadingConversation}
                onClick={async () => {
                  await loadConversation(c.id)
                  onOpened?.()
                  onClose()
                }}
                className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors disabled:opacity-50 ${
                  c.id === conversationId
                    ? 'border-purple/40 bg-purple/10'
                    : 'border-white/10 bg-surface hover:bg-surface-hover'
                }`}
              >
                <span className="min-w-0 flex-1">
                  {/* Untitled only while the auto-title is still being generated. */}
                  <span className="block truncate font-body text-sm font-medium text-text-primary">
                    {c.title || 'Untitled conversation'}
                  </span>
                  <span className="mt-0.5 block text-xs text-text-muted">
                    {formatWhen(c.updatedAt)} · {c.messageCount}{' '}
                    {c.messageCount === 1 ? 'message' : 'messages'}
                    {c.id === conversationId ? ' · open' : ''}
                  </span>
                </span>
                <span aria-hidden="true" className="flex-shrink-0 text-text-muted">→</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
