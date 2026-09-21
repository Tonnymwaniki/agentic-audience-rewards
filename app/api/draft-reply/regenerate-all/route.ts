import { NextRequest, NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { regenerateDraftsForCreator } from '@/lib/draft-regeneration'
import { logError } from '@/lib/logger'

// Each comment can cost two sequential Claude calls, so this needs far more room
// than a normal request. Vercel Hobby caps this at 60s, Pro at 300s — the
// MAX_REGENERATIONS_PER_RUN cap in lib/draft-regeneration.ts is what keeps a run
// bounded enough to finish inside it.
export const maxDuration = 300

export async function POST(request: NextRequest) {
  try {
    const { post_id } = await request.json()

    if (!post_id) {
      return NextResponse.json({ error: 'Missing post_id' }, { status: 400 })
    }

    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response
    const { supabase, creatorId } = authResult.auth

    // Confirm the post belongs to this creator before regenerating anything on it.
    const { data: post } = await supabase
      .from('posts')
      .select('id')
      .eq('id', post_id)
      .eq('creator_id', creatorId)
      .maybeSingle()

    if (!post) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }

    const result = await regenerateDraftsForCreator(creatorId, post_id)

    return NextResponse.json(result)
  } catch (err) {
    logError('api/draft-reply/regenerate-all', err, { stage: 'request' })
    return NextResponse.json({ error: 'Failed to regenerate drafts' }, { status: 500 })
  }
}
