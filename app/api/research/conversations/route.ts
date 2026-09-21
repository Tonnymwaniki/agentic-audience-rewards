import { NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { listConversations } from '@/lib/research/conversations'
import { logError } from '@/lib/logger'

/** This creator's saved Research conversations, most recently active first. */
export async function GET() {
  try {
    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response
    const { supabase, creatorId } = authResult.auth

    const conversations = await listConversations(supabase, creatorId)

    return NextResponse.json({ conversations })
  } catch (err) {
    logError('api/research/conversations', err, { stage: 'request' })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
