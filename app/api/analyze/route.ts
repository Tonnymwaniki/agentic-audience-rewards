import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { ingestYouTubeVideo } from '@/lib/ingest'
import { categorizePost, type ProgressCallback as CategorizeProgress } from '@/lib/categorize'
import { evaluateRewards, type EvaluateProgressCallback } from '@/lib/rewards/evaluate'
import { createServiceClient } from '@/lib/supabase/service'
import { requireCreator } from '@/lib/api-auth'
import { embedPostCommentsSafely } from '@/lib/embeddings'

async function updatePostStatus(postId: string, updates: Record<string, unknown>) {
  const supabase = createServiceClient()
  await supabase.from('posts').update(updates).eq('id', postId)
}

async function processAnalysisInBackground(postId: string, creatorId: string) {
  const supabase = createServiceClient()

  try {
    const categorizeProgress: CategorizeProgress = (count) => {
      updatePostStatus(postId, { comments_categorized: count, analysis_stage: 'categorizing' }).catch(() => {})
    }

    const categorizeResult = await categorizePost(postId, categorizeProgress)

    if (!categorizeResult.success) {
      await updatePostStatus(postId, { analysis_status: 'error', analysis_stage: 'categorization_failed' })
      return
    }

    const { data: commentMembers } = await supabase
      .from('comments')
      .select('audience_member_id')
      .eq('post_id', postId)

    const uniqueCommenterIds = new Set((commentMembers || []).map(c => c.audience_member_id))

    const { data: eligibleMembersData } = await supabase
      .from('audience_members')
      .select('id')
      .eq('creator_id', creatorId)
      .eq('reward_status', 'none')
      .in('id', Array.from(uniqueCommenterIds))

    const membersTotal = eligibleMembersData?.length || 0

    await updatePostStatus(postId, {
      analysis_stage: 'evaluating',
      members_total: membersTotal,
    })

    const evaluateProgress: EvaluateProgressCallback = (evaluated, total) => {
      updatePostStatus(postId, { members_evaluated: evaluated, analysis_stage: 'evaluating' }).catch(() => {})
    }

    const evaluateResult = await evaluateRewards(creatorId, postId, evaluateProgress)

    if (!evaluateResult.success) {
      await updatePostStatus(postId, { analysis_status: 'error', analysis_stage: 'evaluation_failed' })
      return
    }

    await updatePostStatus(postId, {
      analysis_status: 'done',
      analysis_stage: 'complete',
      comments_categorized: categorizeResult.categorized,
      members_evaluated: evaluateResult.evaluated,
    })
  } catch (err) {
    console.error('Background analysis error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    await updatePostStatus(postId, { analysis_status: 'error', analysis_stage: 'unknown_error' }).catch(() => {})
  }
}

export async function POST(request: NextRequest) {
  try {
    // The creator is taken from the session, never from the body. This route
    // triggers YouTube ingestion, database writes and paid Anthropic calls, so a
    // client-supplied creator_id would let anyone spend against any account.
    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response
    const creator_id = authResult.auth.creatorId

    const { youtube_url } = await request.json()

    if (!youtube_url) {
      return NextResponse.json(
        { error: 'Missing youtube_url' },
        { status: 400 }
      )
    }

    const ingestResult = await ingestYouTubeVideo(creator_id, youtube_url)

    if (!ingestResult.success) {
      return NextResponse.json(
        { error: 'Ingestion failed', details: ingestResult },
        { status: 500 }
      )
    }

    const postId = ingestResult.postId

    await updatePostStatus(postId, {
      analysis_status: 'running',
      analysis_stage: 'categorizing',
      comments_total: ingestResult.commentsIngested,
      comments_categorized: 0,
      members_evaluated: 0,
      members_total: 0,
    })

    after(async () => {
      // Embedding runs beside analysis, not inside ingestion: this request waits on
      // ingestYouTubeVideo before responding, and embedding a large comment thread
      // there would stretch the creator's "Reading comments" wait. The two jobs are
      // independent, and embedPostCommentsSafely never throws, so a Voyage outage
      // or a not-yet-run migration can't affect the analysis result.
      await Promise.all([
        embedPostCommentsSafely(createServiceClient(), postId),
        processAnalysisInBackground(postId, creator_id).catch(err => {
          console.error('Background analysis crash:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
        }),
      ])
    })

    return NextResponse.json({
      success: true,
      postId,
      commentsIngested: ingestResult.commentsIngested,
    })
  } catch (err) {
    console.error('Analyze error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
