import { NextRequest, NextResponse } from 'next/server'
import { categorizePost } from '@/lib/categorize'
import { requireCreator, requirePostOwnership } from '@/lib/api-auth'
import { logError } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    // Paid Anthropic call against a caller-named post: authenticate, then confirm
    // the post is actually theirs before spending anything on it.
    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response

    const { post_id } = await request.json()

    if (!post_id) {
      return NextResponse.json(
        { error: 'Missing post_id' },
        { status: 400 }
      )
    }

    const owned = await requirePostOwnership(authResult.auth.supabase, authResult.auth.creatorId, post_id)
    if (!owned.ok) return owned.response

    const result = await categorizePost(post_id)

    return NextResponse.json(result)
  } catch (err) {
    logError('api/categorize', err, { stage: 'request' })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
