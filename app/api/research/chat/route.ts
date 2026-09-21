import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { buildResearchContext, runResearchTurn } from '@/lib/research/engine'
import {
  appendMessage,
  conversationBelongsTo,
  createConversation,
  generateConversationTitle,
} from '@/lib/research/conversations'

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

    const { message, conversation_history, conversation_id } = await request.json()

    if (!message) {
      return NextResponse.json({ error: 'Missing message' }, { status: 400 })
    }

    let ctx
    try {
      ctx = await buildResearchContext(supabase, creatorId)
    } catch {
      return NextResponse.json({ error: 'Failed to fetch posts' }, { status: 500 })
    }

    // Persistence happens here rather than in the client so one round trip stores
    // both turns. A first message with no conversation_id opens a new one.
    let conversationId: string | null = null
    let isNewConversation = false

    if (typeof conversation_id === 'string' && conversation_id) {
      // The id comes from the request body, so it is attacker-controlled until
      // checked against this creator.
      conversationId = (await conversationBelongsTo(supabase, conversation_id, creatorId))
        ? conversation_id
        : null
      if (!conversationId) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
      }
    } else {
      conversationId = await createConversation(supabase, creatorId)
      isNewConversation = Boolean(conversationId)
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
            console.log('Research conversation titled:', JSON.stringify({ id, title }))
          } catch (err) {
            console.error('Conversation title error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
          }
        })
      }
    }

    return NextResponse.json({ success: true, conversation_id: conversationId, ...result })
  } catch (err) {
    console.error('Research chat error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
