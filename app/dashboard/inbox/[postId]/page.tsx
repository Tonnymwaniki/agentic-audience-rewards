import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import PageHeader from '@/components/PageHeader'
import TrackVideoToggle from '@/components/TrackVideoToggle'
import CommentsList from './CommentsList'
import RegenerateDraftsButton from './RegenerateDraftsButton'
import { logError } from '@/lib/logger'
import { formatEngagementRate, loadPostEngagement } from '@/lib/engagement'

export const dynamic = 'force-dynamic'

export default async function PostInboxPage({
  params,
}: {
  params: Promise<{ postId: string }>
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: creator, error: creatorError } = await supabase
    .from('creators')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (creatorError) {
    logError('page.inbox.post', creatorError, { user_id: user.id, stage: 'fetch_creator' })
    return (
      <div>
        <p className="text-red-500">Failed to load your account details.</p>
      </div>
    )
  }

  if (!creator) {
    redirect('/login')
  }

  const { postId } = await params

  const { data: post, error: postError } = await supabase
    .from('posts')
    .select('id, title')
    .eq('id', postId)
    .eq('creator_id', creator.id)
    .maybeSingle()

  if (postError) {
    logError('page.inbox.post', postError, { creator_id: creator.id, post_id: postId, stage: 'fetch_post' })
    return (
      <div>
        <p className="text-red-500">Failed to load this video.</p>
      </div>
    )
  }

  // Genuinely absent, or owned by another creator — bounce back to the list.
  if (!post) {
    redirect('/dashboard/inbox')
  }

  const { data: posts } = await supabase
    .from('posts')
    .select('id')
    .eq('creator_id', creator.id)

  const allPostIds = (posts || []).map(p => p.id)

  // Batched fetch (same range()-loop pattern used on the Brain and My Videos pages)
  // instead of a single unbounded query — a popular video's comment count can exceed
  // Supabase's default per-request row cap, which would otherwise silently truncate.
  type CommentRow = {
    id: string
    text: string
    posted_at: string
    audience_member_id: string | null
    audience_members: unknown
    comment_categories: unknown
  }

  const comments: CommentRow[] = []
  let commentsFetchError: unknown = null

  {
    let offset = 0
    const batchSize = 1000
    let hasMore = true

    while (hasMore) {
      const { data: batch, error: commentsError } = await supabase
        .from('comments')
        .select(
          `
          id,
          text,
          posted_at,
          audience_member_id,
          audience_members (
            display_name,
            profile_summary
          ),
          comment_categories (
            category,
            topic,
            draft_reply,
            final_reply_text
          )
        `
        )
        .eq('post_id', postId)
        .order('posted_at', { ascending: true })
        .range(offset, offset + batchSize - 1)

      if (commentsError) {
        commentsFetchError = commentsError
        break
      }

      if (batch && batch.length > 0) {
        comments.push(...(batch as unknown as CommentRow[]))
        offset += batchSize
      }

      if (!batch || batch.length < batchSize) {
        hasMore = false
      }
    }
  }

  if (commentsFetchError) {
    logError('page.inbox.post', commentsFetchError, { creator_id: creator.id, post_id: postId, stage: 'fetch_comments' })
    return (
      <div>
        <p className="text-red-500">Failed to load comments</p>
      </div>
    )
  }

  const formattedComments = comments.map(comment => ({
    id: comment.id,
    text: comment.text,
    postedAt: comment.posted_at,
    authorName: (comment.audience_members as unknown as { display_name: string } | null)?.display_name || 'Unknown',
    profileSummary: (comment.audience_members as unknown as { profile_summary: string | null } | null)?.profile_summary || null,
    category: (comment.comment_categories as unknown as { category: string; topic: string; draft_reply?: string | null } | null)?.category || 'other',
    topic: (comment.comment_categories as unknown as { category: string; topic: string; draft_reply?: string | null } | null)?.topic || null,
    draftReply: (comment.comment_categories as unknown as { draft_reply?: string | null } | null)?.draft_reply || null,
    finalReplyText: (comment.comment_categories as unknown as { final_reply_text?: string | null } | null)?.final_reply_text || null,
    audienceMemberId: comment.audience_member_id,
  }))

  const memberIds = formattedComments.map(c => c.audienceMemberId).filter(Boolean) as string[]
  let peopleNoticed = 0
  const rewardedMemberIds = new Set<string>()

  if (memberIds.length > 0) {
    const { data: rewardEvents } = await supabase
      .from('reward_events')
      .select('audience_member_id, post_id')
      .in('audience_member_id', memberIds)

    if (rewardEvents) {
      rewardEvents.forEach(e => {
        if (e.post_id === postId || e.post_id === null) {
          rewardedMemberIds.add(e.audience_member_id)
        }
      })
      peopleNoticed = rewardedMemberIds.size
    }
  }

  const commentsWithRewardFlag = formattedComments.map(c => ({
    ...c,
    hasReward: rewardedMemberIds.has(c.audienceMemberId || ''),
  }))

  const repeatedCommentIdsSet = new Set<string>()

  if (formattedComments.length > 0) {
    const normalizedGroups = new Map<string, Array<{ id: string; audienceMemberId: string }>>()
    for (const comment of formattedComments) {
      const key = comment.text.toLowerCase().trim().replace(/\s+/g, ' ')
      const existing = normalizedGroups.get(key) || []
      existing.push({ id: comment.id, audienceMemberId: comment.audienceMemberId || '' })
      normalizedGroups.set(key, existing)
    }

    for (const entries of normalizedGroups.values()) {
      if (entries.length < 2) continue
      const uniqueMembers = new Set(entries.map(e => e.audienceMemberId).filter(Boolean))
      if (uniqueMembers.size < 2) continue
      for (const entry of entries) {
        repeatedCommentIdsSet.add(entry.id)
      }
    }
  }

  const repeatedCommentIds = Array.from(repeatedCommentIdsSet)

  // Same helper as the My Videos card and the Research agent — one definition of
  // the number, so the three can never disagree about a video.
  const engagement = (await loadPostEngagement(supabase, [post.id])).get(post.id) ?? null
  const engagementRate = engagement ? formatEngagementRate(engagement.rate) : null

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={post.title} backHref="/dashboard/inbox" backLabel="My Videos" />

      {engagement && (
        <section aria-labelledby="engagement-rate" className="card mb-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="engagement-rate" className="font-mono text-[10px] tracking-widest text-text-muted uppercase">
              Engagement rate
            </h2>
            {engagementRate && (
              <p className="font-display text-2xl leading-none font-semibold text-teal">{engagementRate}</p>
            )}
          </div>
          {engagementRate ? (
            <p className="mt-2 text-xs leading-relaxed text-text-muted">
              {engagement.comments.toLocaleString()} comments
              {engagement.likes !== null ? ` + ${engagement.likes.toLocaleString()} likes` : ''}
              {' '}over {engagement.views!.toLocaleString()} views.{' '}
              {/* The definition travels with the number, so it is not mistaken for a
                  count of people — likes aren't individually identifiable, so a
                  viewer who likes AND comments is counted twice. */}
              That&apos;s interactions per view, not unique people.
              {engagement.likesHidden && ' Likes are hidden on this video, so only comments are counted.'}
              {engagement.commentsFromIngest && " Comment count is what we ingested, not YouTube's public total."}
            </p>
          ) : (
            <p className="mt-2 text-xs text-text-muted">
              Unavailable — YouTube doesn&apos;t report a view count for this video.
            </p>
          )}
        </section>
      )}

      <div className="mb-4 flex flex-wrap items-start gap-2">
        <Link
          href="/dashboard/research"
          className="btn-primary inline-flex items-center justify-center"
        >
          Research
        </Link>
        <Link
          href={`/dashboard/rewards?post=${postId}`}
          className="btn-primary inline-flex items-center justify-center"
        >
          Rewards
        </Link>
        <RegenerateDraftsButton postId={postId} />
        <div className="w-48">
          <TrackVideoToggle postId={postId} />
        </div>
      </div>

      <CommentsList
        comments={commentsWithRewardFlag}
        peopleNoticed={peopleNoticed}
        repeatedCommentIds={repeatedCommentIds}
      />
    </div>
  )
}
