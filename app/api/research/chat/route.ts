import { NextRequest, NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { buildResearchContext, runResearchTurn } from '@/lib/research/engine'

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

    const { message, conversation_history } = await request.json()

    if (!message) {
      return NextResponse.json({ error: 'Missing message' }, { status: 400 })
    }

    let ctx
    try {
      ctx = await buildResearchContext(supabase, creatorId)
    } catch {
      return NextResponse.json({ error: 'Failed to fetch posts' }, { status: 500 })
    }

    const result = await runResearchTurn(ctx, message, conversation_history)

    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    console.error('Research chat error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
