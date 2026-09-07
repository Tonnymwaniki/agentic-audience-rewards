'use client'

import { createContext, useCallback, useContext, useMemo, useState } from 'react'

// The conversation lives here rather than inside ResearchChat, because on mobile the
// landing screen and the full-screen chat are now two ROUTES. Component state would
// unmount on navigation and the conversation would reset every time the creator
// tapped Back — requirement: it must survive until they explicitly start a new chat.
//
// Mounted from app/dashboard/research/layout.tsx, which wraps both /research and
// /research/chat. Next preserves a layout across navigations between its own child
// routes, so this provider is never remounted while moving between the two.

export type VideoCard = {
  post_id: string
  title: string
  thumbnail_url: string | null
  total_comments: number
  category_counts: Record<string, number>
  top_topics: Array<{ topic: string; count: number }>
}

export type StatsCard = {
  title: string
  stats: Array<{ label: string; value: string | number }>
}

export type IdeaCard = {
  number: number
  title: string
  description: string
  signal: string
}

export type AnomalyCard = {
  hasAnomaly: boolean
  findings: Array<{ description: string; severity: 'high' | 'medium' }>
}

export type PersonCard = {
  display_name: string
  reason: string
  comment_count: number
}

export type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  videoCards?: VideoCard[]
  statsCards?: StatsCard[]
  ideaCards?: IdeaCard[]
  anomalyCard?: AnomalyCard
  personCards?: PersonCard[]
}

type ResearchChatValue = {
  messages: ChatMessage[]
  input: string
  loading: boolean
  error: string | null
  hasMessages: boolean
  lastAssistantIndex: number
  setInput: (value: string) => void
  sendMessage: (text: string) => Promise<void>
  regenerate: () => Promise<void>
  startNewChat: () => void
}

const ResearchChatContext = createContext<ResearchChatValue | null>(null)

export function useResearchChat(): ResearchChatValue {
  const value = useContext(ResearchChatContext)
  if (!value) {
    throw new Error('useResearchChat must be used inside ResearchChatProvider')
  }
  return value
}

export function ResearchChatProvider({
  creatorId,
  children,
}: {
  creatorId: string
  children: React.ReactNode
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasMessages = messages.length > 0
  const lastAssistantIndex = messages.map(m => m.role).lastIndexOf('assistant')

  // Shared by sendMessage and regenerate — both need "post a user turn's text and
  // append whatever the assistant returns", they just differ in what history and
  // message they start from.
  const requestAssistant = useCallback(
    async (history: ChatMessage[], userText: string) => {
      setLoading(true)
      setError(null)

      try {
        const res = await fetch('/api/research/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            creator_id: creatorId,
            message: userText,
            conversation_history: history,
          }),
        })

        const data = await res.json()

        if (!res.ok) {
          throw new Error(data.error || 'Failed to get a response')
        }

        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            content: data.reply,
            createdAt: new Date().toISOString(),
            videoCards: data.videoCards,
            statsCards: data.statsCards,
            ideaCards: data.ideaCards,
            anomalyCard: data.anomalyCard,
            personCards: data.personCards,
          },
        ])
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong')
      } finally {
        setLoading(false)
      }
    },
    [creatorId]
  )

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || loading) return

      // conversation_history is everything before this new message — the server
      // appends `message` itself as the final turn.
      const history = messages
      setMessages(prev => [
        ...prev,
        { role: 'user', content: trimmed, createdAt: new Date().toISOString() },
      ])
      setInput('')

      await requestAssistant(history, trimmed)
    },
    [loading, messages, requestAssistant]
  )

  // Drops the latest assistant reply and re-asks the user message that produced
  // it, so the replacement is generated from identical context.
  const regenerate = useCallback(async () => {
    if (loading || lastAssistantIndex < 1) return

    let userIndex = -1
    for (let i = lastAssistantIndex - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userIndex = i
        break
      }
    }
    if (userIndex === -1) return

    const userText = messages[userIndex].content
    const history = messages.slice(0, userIndex)

    setMessages(messages.slice(0, lastAssistantIndex))
    await requestAssistant(history, userText)
  }, [loading, lastAssistantIndex, messages, requestAssistant])

  const startNewChat = useCallback(() => {
    setMessages([])
    setInput('')
    setError(null)
    setLoading(false)
  }, [])

  const value = useMemo(
    () => ({
      messages,
      input,
      loading,
      error,
      hasMessages,
      lastAssistantIndex,
      setInput,
      sendMessage,
      regenerate,
      startNewChat,
    }),
    [messages, input, loading, error, hasMessages, lastAssistantIndex, sendMessage, regenerate, startNewChat]
  )

  return <ResearchChatContext.Provider value={value}>{children}</ResearchChatContext.Provider>
}
