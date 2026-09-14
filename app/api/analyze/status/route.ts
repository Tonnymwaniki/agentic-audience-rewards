import { NextRequest, NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'

export async function GET(request: NextRequest) {
  const authResult = await requireCreator()
  if (!authResult.ok) return authResult.response

  const postId = request.nextUrl.searchParams.get('post_id')

  if (!postId) {
    return NextResponse.json(
      { error: 'Missing post_id' },
      { status: 400 }
    )
  }

  // Polled every 1.5s during an analysis. The creator_id filter is what stops it
  // reporting another account's progress to anyone who guesses a post id.
  const { data, error } = await authResult.auth.supabase
    .from('posts')
    .select('analysis_status, analysis_stage, comments_total, comments_categorized, members_total, members_evaluated')
    .eq('id', postId)
    .eq('creator_id', authResult.auth.creatorId)
    .maybeSingle()

  if (error || !data) {
    return NextResponse.json(
      { error: 'Post not found' },
      { status: 404 }
    )
  }

  return NextResponse.json(data)
}
