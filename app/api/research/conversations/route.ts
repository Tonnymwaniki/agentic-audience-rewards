import { NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { listConversations } from '@/lib/research/conversations'

/** This creator's saved Research conversations, most recently active first. */
export async function GET() {
  try {
    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response
    const { supabase, creatorId } = authResult.auth

    const conversations = await listConversations(supabase, creatorId)

    return NextResponse.json({ conversations })
  } catch (err) {
    console.error('List conversations error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
