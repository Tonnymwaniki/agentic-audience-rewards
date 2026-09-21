import type { SupabaseClient } from '@supabase/supabase-js'
import { logError, logWarn } from '@/lib/logger'

/**
 * Durable storage for Research chat conversations.
 *
 * Every function here is creator-scoped by an explicit filter, never by RLS: these
 * run on the service-role client from requireCreator(), which bypasses RLS by
 * design, so the filters below are the actual authorization.
 *
 * Nothing here throws. A conversation failing to save must never turn a good
 * answer into an error the creator sees — the reply is the product, the transcript
 * is bookkeeping.
 */

export type StoredMessage = { role: 'user' | 'assistant'; content: string; createdAt: string }

export type ConversationSummary = {
  id: string
  title: string | null
  createdAt: string
  updatedAt: string
  messageCount: number
}

const TITLE_TIMEOUT_MS = 10000
export const MAX_TITLE_LENGTH = 60

/** False once the database reports the tables missing (migration 20240101000033). */
let tablesAvailable = true

function markUnavailable(error: { code?: string }): boolean {
  if (error.code === '42P01' || error.code === 'PGRST205') {
    tablesAvailable = false
    console.warn('research_conversations/messages do not exist yet (migration 20240101000033); chat will not persist')
    return true
  }
  return false
}

export function conversationsAvailable(): boolean {
  return tablesAvailable
}

/** Creates a conversation for this creator. Returns null if storage is unavailable. */
export async function createConversation(
  supabase: SupabaseClient,
  creatorId: string
): Promise<string | null> {
  if (!tablesAvailable) return null

  const { data, error } = await supabase
    .from('research_conversations')
    .insert([{ creator_id: creatorId }])
    .select('id')
    .single()

  if (error) {
    if (!markUnavailable(error)) logError('research.conversations.create', error, { creator_id: creatorId })
    return null
  }
  return data.id as string
}

/**
 * Confirms a conversation belongs to this creator.
 *
 * The id arrives in a request body, so it is attacker-controlled: without this a
 * crafted conversation_id would append someone else's transcript and, worse, feed
 * their questions back as context. Same reasoning as requirePostOwnership.
 */
export async function conversationBelongsTo(
  supabase: SupabaseClient,
  conversationId: string,
  creatorId: string
): Promise<boolean> {
  if (!tablesAvailable) return false

  const { data, error } = await supabase
    .from('research_conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('creator_id', creatorId)
    .maybeSingle()

  if (error) {
    if (!markUnavailable(error)) logError('research.conversations.ownership', error, { conversation_id: conversationId, creator_id: creatorId })
    return false
  }
  return Boolean(data)
}

/** Appends one turn and bumps the conversation's updated_at so the list re-sorts. */
export async function appendMessage(
  supabase: SupabaseClient,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string
): Promise<void> {
  if (!tablesAvailable) return

  const { error } = await supabase
    .from('research_messages')
    .insert([{ conversation_id: conversationId, role, content }])

  if (error) {
    if (!markUnavailable(error)) logError('research.conversations.appendMessage', error, { conversation_id: conversationId, role })
    return
  }

  const { error: touchError } = await supabase
    .from('research_conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId)

  if (touchError) logError('research.conversations.appendMessage', touchError, { conversation_id: conversationId, stage: 'touch_updated_at' })
}

/**
 * Drops every stored message after the first `keepCount`, oldest-first.
 *
 * Used when a creator edits an earlier question: the old answer, and everything
 * that followed it, stop being part of the conversation and must stop being part
 * of the transcript too. Leaving them would mean a resumed conversation replayed
 * a branch the creator had already discarded, and would feed that dead branch back
 * as context on the next question.
 *
 * Truncates by POSITION rather than timestamp: the client knows which turn is being
 * edited by its index, and client-generated createdAt values do not match the
 * server-generated created_at stored here.
 */
export async function truncateMessages(
  supabase: SupabaseClient,
  conversationId: string,
  keepCount: number
): Promise<number> {
  if (!tablesAvailable || keepCount < 0) return 0

  const { data, error } = await supabase
    .from('research_messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })

  if (error) {
    if (!markUnavailable(error)) logError('research.conversations.truncate', error, { conversation_id: conversationId, stage: 'read' })
    return 0
  }

  const doomed = (data ?? []).slice(keepCount).map(r => r.id as string)
  if (doomed.length === 0) return 0

  const { error: deleteError } = await supabase
    .from('research_messages')
    .delete()
    .in('id', doomed)

  if (deleteError) {
    logError('research.conversations.truncate', deleteError, { conversation_id: conversationId, stage: 'delete', doomed_count: doomed.length })
    return 0
  }

  return doomed.length
}

/** This creator's conversations, most recently active first. */
export async function listConversations(
  supabase: SupabaseClient,
  creatorId: string,
  limit = 50
): Promise<ConversationSummary[]> {
  if (!tablesAvailable) return []

  const { data, error } = await supabase
    .from('research_conversations')
    .select('id, title, created_at, updated_at')
    .eq('creator_id', creatorId)
    .order('updated_at', { ascending: false })
    .limit(limit)

  if (error) {
    if (!markUnavailable(error)) logError('research.conversations.list', error, { creator_id: creatorId })
    return []
  }

  const rows = data ?? []
  if (rows.length === 0) return []

  // One read for the counts rather than one per conversation.
  const { data: messages } = await supabase
    .from('research_messages')
    .select('conversation_id')
    .in('conversation_id', rows.map(r => r.id as string))

  const counts = new Map<string, number>()
  for (const m of messages ?? []) {
    const id = m.conversation_id as string
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }

  return rows.map(r => ({
    id: r.id as string,
    title: (r.title as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    messageCount: counts.get(r.id as string) ?? 0,
  }))
}

/** One conversation's messages in order. Caller must have verified ownership. */
export async function loadMessages(
  supabase: SupabaseClient,
  conversationId: string
): Promise<StoredMessage[]> {
  if (!tablesAvailable) return []

  const { data, error } = await supabase
    .from('research_messages')
    .select('role, content, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })

  if (error) {
    if (!markUnavailable(error)) logError('research.conversations.loadMessages', error, { conversation_id: conversationId })
    return []
  }

  return (data ?? []).map(row => ({
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content as string,
    createdAt: row.created_at as string,
  }))
}

/** Trimmed, unquoted, and clipped to something that fits one line in the list. */
function tidyTitle(raw: string): string {
  const cleaned = raw.trim().replace(/^["'`]|["'`]$/g, '').replace(/\s+/g, ' ')
  if (cleaned.length <= MAX_TITLE_LENGTH) return cleaned
  return cleaned.slice(0, MAX_TITLE_LENGTH - 1).trimEnd() + '…'
}

/**
 * Writes a short title for a conversation, from its first question.
 *
 * One Haiku call with a tiny token budget — the same weight as isBusinessRelevant.
 * Intended to run in after(), so the creator's answer is never held up by it.
 *
 * Falls back to a trimmed version of the question itself if the call fails, so a
 * conversation is never left untitled in the list because of a model hiccup.
 */
export async function generateConversationTitle(
  supabase: SupabaseClient,
  conversationId: string,
  firstQuestion: string
): Promise<string | null> {
  if (!tablesAvailable) return null

  let title = tidyTitle(firstQuestion)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS)
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 24,
        messages: [
          {
            role: 'user',
            content: `A creator asked this question about their audience's comments: "${firstQuestion}"\n\nWrite a title for this conversation: at most 6 words, no quotes, no trailing punctuation, title case off. Describe the SUBJECT, not the act of asking — "Slow delivery complaints", not "Question about complaints". Respond with ONLY the title.`,
          },
        ],
      }),
      signal: controller.signal,
    })

    if (response.ok) {
      const data = await response.json()
      const text = Array.isArray(data.content)
        ? data.content.find((b: { type?: string }) => b?.type === 'text')?.text
        : null
      if (typeof text === 'string' && text.trim().length > 0) title = tidyTitle(text)
    } else {
      logWarn('research.conversations.title', 'Title API returned a non-OK status; falling back to the question', { conversation_id: conversationId, status: response.status })
    }
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError' ? 'timed out' : String(err)
    logWarn('research.conversations.title', 'Title generation failed; falling back to the question', { conversation_id: conversationId, reason })
  } finally {
    clearTimeout(timeoutId)
  }

  const { error } = await supabase
    .from('research_conversations')
    .update({ title })
    .eq('id', conversationId)

  if (error) {
    if (!markUnavailable(error)) logError('research.conversations.title', error, { conversation_id: conversationId, stage: 'write' })
    return null
  }

  return title
}
