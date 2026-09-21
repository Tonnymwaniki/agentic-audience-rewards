import { NextRequest, NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { conversationBelongsTo, loadMessages } from '@/lib/research/conversations'
import { logError } from '@/lib/logger'

/**
 * One conversation's messages, for resuming it.
 *
 * Returns 404 rather than 403 for someone else's conversation, so this cannot be
 * used to discover which ids exist — the same choice requirePostOwnership makes.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params

    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response
    const { supabase, creatorId } = authResult.auth

    if (!(await conversationBelongsTo(supabase, id, creatorId))) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const messages = await loadMessages(supabase, id)

    return NextResponse.json({ id, messages })
  } catch (err) {
    logError('api/research/conversations/[id]', err, { stage: 'request' })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
