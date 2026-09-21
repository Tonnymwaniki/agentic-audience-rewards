import { NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { logError } from '@/lib/logger'

export async function GET() {
  try {
    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response
    const { supabase, creatorId } = authResult.auth

    const { data: posts, error } = await supabase
      .from('posts')
      .select('external_post_id')
      .eq('creator_id', creatorId)

    if (error) {
      logError('api/creator/analyzed-videos', error, { creator_id: creatorId, stage: 'fetch' })
      return NextResponse.json({ error: 'Failed to fetch analyzed videos' }, { status: 500 })
    }

    return NextResponse.json({ videoIds: (posts || []).map(p => p.external_post_id) })
  } catch (err) {
    logError('api/creator/analyzed-videos', err, { stage: 'request' })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
