import { NextRequest, NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { logError } from '@/lib/logger'

/**
 * Confirms or corrects the Pinned Comments page's best-effort pin guess
 * (posts.pinned_comment_id / pinned_comment_confirmed — migration 55). YouTube's
 * API has no "is this pinned" field, so ingestion can only guess (the first
 * comment under the default relevance order); this is how a creator turns that
 * guess into ground truth, or throws it out.
 *
 * - { action: 'confirm' }: marks the current guess as correct.
 * - { action: 'clear' }: the guess was wrong — un-pins it entirely. A future
 *   re-ingest can guess again (guessPinnedComment only ever fires when
 *   pinned_comment_id is null AND not confirmed), or the creator can pin the
 *   right comment by editing/re-fetching later.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ postId: string }> }) {
  try {
    const { postId } = await params
    const { action } = await request.json().catch(() => ({}))

    if (action !== 'confirm' && action !== 'clear') {
      return NextResponse.json({ error: "action must be 'confirm' or 'clear'" }, { status: 400 })
    }

    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response
    const { supabase, creatorId } = authResult.auth

    // 404 rather than 403: a post belonging to someone else should be
    // indistinguishable from one that does not exist.
    const { data: post, error: postError } = await supabase
      .from('posts')
      .select('id, creator_id')
      .eq('id', postId)
      .maybeSingle()

    if (postError) {
      logError('api/creator/pinned', postError, { creator_id: creatorId, post_id: postId, stage: 'lookup' })
      return NextResponse.json({ error: 'Failed to update pinned comment' }, { status: 500 })
    }
    if (!post || post.creator_id !== creatorId) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }

    const payload = action === 'confirm' ? { pinned_comment_confirmed: true } : { pinned_comment_id: null, pinned_comment_confirmed: false }

    const { error: updateError } = await supabase.from('posts').update(payload).eq('id', postId)
    if (updateError) {
      logError('api/creator/pinned', updateError, { creator_id: creatorId, post_id: postId, stage: 'update' })
      return NextResponse.json({ error: 'Failed to update pinned comment' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    logError('api/creator/pinned', err, { stage: 'request' })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
