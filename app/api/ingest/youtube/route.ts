import { NextRequest, NextResponse, after } from 'next/server'
import { ingestYouTubeVideo } from '@/lib/ingest'
import { requireCreator } from '@/lib/api-auth'
import { embedPostCommentsSafely } from '@/lib/embeddings'
import { createServiceClient } from '@/lib/supabase/service'
import { logError } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    // Writes posts, audience_members and comments — session-derived creator only.
    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response

    const { youtube_url } = await request.json()

    if (!youtube_url) {
      return NextResponse.json(
        { error: 'Missing youtube_url' },
        { status: 400 }
      )
    }

    const result = await ingestYouTubeVideo(authResult.auth.creatorId, youtube_url)

    // After the response, so embedding never lengthens the ingest request.
    after(() => embedPostCommentsSafely(createServiceClient(), result.postId))

    return NextResponse.json(result)
  } catch (err) {
    logError('api/ingest/youtube', err, { stage: 'request' })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
