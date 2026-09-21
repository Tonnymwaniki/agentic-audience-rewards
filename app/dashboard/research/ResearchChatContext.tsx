'use client'

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

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

// Evidence cited by an answer — mirrors lib/research/evidence.ts, re-declared here
// so this client module doesn't reach into server-side code.
export type SourceItem =
  | {
      ref: string
      type: 'comment'
      comment_id: string
      text: string
      author: string | null
      post_id: string | null
      video_title: string | null
    }
  | { ref: string; type: 'video'; post_id: string; title: string }
  | { ref: string; type: 'aggregate'; label: string; comment_count: number; video_count: number }

export type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  videoCards?: VideoCard[]
  statsCards?: StatsCard[]
  ideaCards?: IdeaCard[]
  anomalyCard?: AnomalyCard
  personCards?: PersonCard[]
  sources?: SourceItem[]
}

type ResearchChatValue = {
  messages: ChatMessage[]
  input: string
  loading: boolean
  error: string | null
  hasMessages: boolean
  lastAssistantIndex: number
  /** The row this conversation is being saved to; null until the first answer. */
  /** Shown in the chat's opening greeting. */
  creatorName: string
  conversationId: string | null
  /** True while a saved conversation is being fetched back. */
  loadingConversation: boolean
  setInput: (value: string) => void
  sendMessage: (text: string) => Promise<void>
  regenerate: () => Promise<void>
  /** Rewrites the user message at `index` and re-answers, dropping everything after it. */
  editMessage: (index: number, text: string) => Promise<void>
  startNewChat: () => void
  loadConversation: (id: string) => Promise<void>
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
  creatorName,
  children,
}: {
  creatorId: string
  creatorName: string
  children: React.ReactNode
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [loadingConversation, setLoadingConversation] = useState(false)

  // Read inside requestAssistant without making it a dependency: adding the id to
  // the dep array would rebuild the callback the moment the first answer assigns
  // one, and sendMessage's own deps with it, for no behavioural gain.
  const conversationIdRef = useRef<string | null>(null)

  const hasMessages = messages.length > 0
  const lastAssistantIndex = messages.map(m => m.role).lastIndexOf('assistant')

  // Shared by sendMessage and regenerate — both need "post a user turn's text and
  // append whatever the assistant returns", they just differ in what history and
  // message they start from.
  const requestAssistant = useCallback(
    async (history: ChatMessage[], userText: string, truncateTo?: number) => {
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
            // Absent on the first turn: the server opens a conversation and
            // returns its id, which every later turn then appends to.
            conversation_id: conversationIdRef.current,
            // Set only when an earlier question was edited: tells the server how
            // many stored turns to keep before appending this one.
            truncate_to: truncateTo,
          }),
        })

        const data = await res.json()

        if (!res.ok) {
          throw new Error(data.error || 'Failed to get a response')
        }

        if (data.conversation_id && conversationIdRef.current !== data.conversation_id) {
          conversationIdRef.current = data.conversation_id
          setConversationId(data.conversation_id)
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
            sources: data.sources,
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

  // Clearing the id is what makes this a NEW conversation rather than a reset of
  // the old one: the previous rows stay in the database, reachable from history.
  /**
   * Replaces an earlier question with an edited one and re-answers from there.
   *
   * Standard chat behaviour: everything from that turn onward is discarded — the
   * old answer and any turns after it — rather than a new branch being appended.
   * The same cut is applied to research_messages via truncate_to, so the stored
   * transcript can never disagree with what is on screen.
   */
  const editMessage = useCallback(
    async (index: number, text: string) => {
      const trimmed = text.trim()
      if (!trimmed || loading) return
      if (index < 0 || index >= messages.length || messages[index].role !== 'user') return

      // Everything before the edited turn is the context the new answer is built
      // from; index is also exactly how many stored turns the server should keep.
      const history = messages.slice(0, index)
      setMessages([
        ...history,
        { role: 'user', content: trimmed, createdAt: new Date().toISOString() },
      ])
      setInput('')

      await requestAssistant(history, trimmed, index)
    },
    [loading, messages, requestAssistant]
  )

  const startNewChat = useCallback(() => {
    setMessages([])
    setInput('')
    setError(null)
    setLoading(false)
    conversationIdRef.current = null
    setConversationId(null)
  }, [])

  /**
   * Pulls a saved conversation back into the chat.
   *
   * The restored messages become the real conversation_history sent with the next
   * question, so a follow-up is answered with the full prior context rather than
   * as if it were a fresh first turn.
   *
   * Cards and citation chips are not restored — they are not persisted, because a
   * chip rebuilt from ids that may have changed would be a quiet lie. The prose
   * comes back; any new answer in the resumed conversation gets fresh cards.
   */
  const loadConversation = useCallback(async (id: string) => {
    setLoadingConversation(true)
    setError(null)
    try {
      const res = await fetch(`/api/research/conversations/${id}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not open that conversation')

      setMessages(
        (data.messages ?? []).map((m: { role: string; content: string; createdAt: string }) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
          createdAt: m.createdAt,
        }))
      )
      conversationIdRef.current = id
      setConversationId(id)
      setInput('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open that conversation')
    } finally {
      setLoadingConversation(false)
    }
  }, [])

  const value = useMemo(
    () => ({
      messages,
      input,
      loading,
      error,
      hasMessages,
      lastAssistantIndex,
      creatorName,
      conversationId,
      loadingConversation,
      setInput,
      sendMessage,
      regenerate,
      editMessage,
      startNewChat,
      loadConversation,
    }),
    [messages, input, loading, error, hasMessages, lastAssistantIndex, creatorName, conversationId, loadingConversation, sendMessage, regenerate, editMessage, startNewChat, loadConversation]
  )

  return <ResearchChatContext.Provider value={value}>{children}</ResearchChatContext.Provider>
}
