import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { evaluateRewards, type EvaluateProgressCallback } from '@/lib/rewards/evaluate'
import { createServiceClient } from '@/lib/supabase/service'
import { requireCreator, requirePostOwnership } from '@/lib/api-auth'

async function updatePostStatus(postId: string, updates: Record<string, unknown>) {
  const supabase = createServiceClient()
  await supabase.from('posts').update(updates).eq('id', postId)
}

export async function POST(request: NextRequest) {
  try {
    // Runs evaluateRewards — a paid Anthropic tool-loop per audience member — so
    // the creator comes from the session, and a named post must belong to them.
    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response
    const creator_id = authResult.auth.creatorId

    const { post_id } = await request.json()

    if (post_id) {
      const owned = await requirePostOwnership(authResult.auth.supabase, creator_id, post_id)
      if (!owned.ok) return owned.response
    }

    after(async () => {
      try {
        if (post_id) {
          await updatePostStatus(post_id, {
            analysis_status: 'running',
            analysis_stage: 'evaluating',
            members_total: 0,
            members_evaluated: 0,
          })
        }

        const onProgress: EvaluateProgressCallback | undefined = post_id
          ? (evaluated, total) => {
              updatePostStatus(post_id, {
                members_evaluated: evaluated,
                members_total: total,
                analysis_stage: 'evaluating',
              }).catch(() => {})
            }
          : undefined

        const result = await evaluateRewards(creator_id, post_id || undefined, onProgress)

        if (post_id) {
          if (result.success) {
            await updatePostStatus(post_id, {
              analysis_status: 'done',
              analysis_stage: 'complete',
              members_evaluated: result.evaluated,
            })
          } else {
            await updatePostStatus(post_id, {
              analysis_status: 'error',
              analysis_stage: 'evaluation_failed',
            })
          }
        }
      } catch (err) {
        console.error('Background reward evaluation error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
        if (post_id) {
          await updatePostStatus(post_id, {
            analysis_status: 'error',
            analysis_stage: 'unknown_error',
          }).catch(() => {})
        }
      }
    })

    return NextResponse.json({ success: true, status: 'started' })
  } catch (err) {
    console.error('Reward evaluate error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
