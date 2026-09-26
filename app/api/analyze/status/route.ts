import { NextRequest, NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { reconcileStaleRuns } from '@/lib/analysis-staleness'

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

  // Stale-run detection on access. Only after the ownership check above, and
  // scoped by the session's creator, so polling can never touch another account's
  // post. A dead background job is resolved here into its real terminal state,
  // which also ends the client's poll loop instead of leaving it spinning forever.
  if (data.analysis_status === 'running') {
    const [resolved] = await reconcileStaleRuns(authResult.auth.supabase, {
      postId,
      creatorId: authResult.auth.creatorId,
    })
    if (resolved) {
      return NextResponse.json({
        ...data,
        analysis_status: resolved.outcome.status,
        analysis_stage: resolved.outcome.stage,
      })
    }
  }

  return NextResponse.json(data)
}
