import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { buildResearchContext, runResearchTurn } from '@/lib/research/engine'
import {
  appendMessage,
  conversationBelongsTo,
  createConversation,
  generateConversationTitle,
  getConversationChannelId,
  truncateMessages,
} from '@/lib/research/conversations'
import { logError, logWarn, logInfo } from '@/lib/logger'
import { checkResearchQuota } from '@/lib/entitlements'

// Gives the tool-use loop (up to ~6 sequential Claude calls) room to finish within
// one invocation. Vercel Hobby caps this at 60s, Pro at 300s.
export const maxDuration = 60

export async function POST(request: NextRequest) {
  try {
    // The creator is derived from the session. This route previously accepted a
    // creator_id and verified it belonged to the caller, which was safe but left
    // a client-supplied id in the code path; deriving it removes the chance of a
    // later edit dropping the check. Every tool is bound to this same creator_id
    // via ctx.postIds/ctx.creatorId, never a raw id Claude passes in.
    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response

    const { supabase, creatorId } = authResult.auth

    const { message, conversation_history, conversation_id, truncate_to, channel_id } = await request.json()

    if (!message) {
      return NextResponse.json({ error: 'Missing message' }, { status: 400 })
    }

    if (channel_id !== undefined && channel_id !== null && typeof channel_id !== 'string') {
      return NextResponse.json({ error: 'channel_id must be a string or null' }, { status: 400 })
    }

    const entitlement = await checkResearchQuota(supabase, creatorId)
    if (!entitlement.allowed) {
      return NextResponse.json(
        { error: entitlement.reason, upgrade_required: true, limit: entitlement.limit, used: entitlement.used },
        { status: 402 }
      )
    }

    // Persistence happens here rather than in the client so one round trip stores
    // both turns. A first message with no conversation_id opens a new one.
    let conversationId: string | null = null
    let isNewConversation = false
    // The scope this turn actually runs with: the client's requested channel_id
    // for a brand-new conversation, or the scope an EXISTING conversation was
    // already created with — never the client's channel_id on a continuing
    // conversation, so mid-conversation the scope can't silently drift turn to
    // turn just because the client sent something different.
    let effectiveChannelId: string | null = null

    if (typeof conversation_id === 'string' && conversation_id) {
      // The id comes from the request body, so it is attacker-controlled until
      // checked against this creator.
      conversationId = (await conversationBelongsTo(supabase, conversation_id, creatorId))
        ? conversation_id
        : null
      if (!conversationId) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
      }
      const storedChannelId = await getConversationChannelId(supabase, conversationId)
      effectiveChannelId = storedChannelId === undefined ? null : storedChannelId
    } else {
      conversationId = await createConversation(supabase, creatorId, channel_id ?? null)
      isNewConversation = Boolean(conversationId)
      effectiveChannelId = channel_id ?? null
    }

    let ctx
    try {
      ctx = await buildResearchContext(supabase, creatorId, effectiveChannelId)
    } catch {
      return NextResponse.json({ error: 'Failed to fetch posts' }, { status: 500 })
    }

    // An edited question replaces everything from that turn onward, so the stored
    // transcript is cut back to match before the new turn is appended.
    if (conversationId && typeof truncate_to === 'number' && truncate_to >= 0) {
      const removed = await truncateMessages(supabase, conversationId, truncate_to)
      logInfo('api/research/chat', 'Conversation truncated for an edited question', { conversation_id: conversationId, keep: truncate_to, removed })
    }

    if (conversationId) await appendMessage(supabase, conversationId, 'user', message)

    const result = await runResearchTurn(ctx, message, conversation_history)

    if (conversationId) {
      await appendMessage(supabase, conversationId, 'assistant', result.reply)

      // The title is a second model call; running it in after() keeps it off the
      // path the creator is waiting on. The list falls back to the first question
      // until it lands, so nothing is ever blank.
      if (isNewConversation) {
        const id = conversationId
        after(async () => {
          try {
            const title = await generateConversationTitle(supabase, id, message)
            logInfo('api/research/chat', 'Conversation titled', { conversation_id: id, title })
          } catch (err) {
            logWarn('api/research/chat', 'Conversation title generation failed; the default title stands', { conversation_id: conversationId, reason: err instanceof Error ? err.message : String(err) })
          }
        })
      }
    }

    return NextResponse.json({ success: true, conversation_id: conversationId, ...result })
  } catch (err) {
    logError('api/research/chat', err, { stage: 'request' })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
