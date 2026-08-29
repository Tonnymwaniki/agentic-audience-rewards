import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import PageHeader from '@/components/PageHeader'
import CommentsList from './CommentsList'

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
    .single()

  if (creatorError || !creator) {
    redirect('/login')
  }

  const { postId } = await params

  const { data: post, error: postError } = await supabase
    .from('posts')
    .select('id, title')
    .eq('id', postId)
    .eq('creator_id', creator.id)
    .single()

  if (postError || !post) {
    redirect('/dashboard/inbox')
  }

  const { data: posts } = await supabase
    .from('posts')
    .select('id')
    .eq('creator_id', creator.id)

  const allPostIds = (posts || []).map(p => p.id)

  const { data: comments, error: commentsError } = await supabase
    .from('comments')
    .select(
      `
      id,
      text,
      posted_at,
      audience_member_id,
      audience_members (
        display_name
      ),
      comment_categories (
        category,
        topic,
        draft_reply
      )
    `
    )
    .eq('post_id', postId)
    .order('posted_at', { ascending: true })

  if (commentsError) {
    console.error('Comments fetch error:', JSON.stringify(commentsError, Object.getOwnPropertyNames(commentsError), 2))
    return (
      <div className="p-6">
        <p className="text-red-500">Failed to load comments</p>
      </div>
    )
  }

  const formattedComments = (comments || []).map(comment => ({
    id: comment.id,
    text: comment.text,
    postedAt: comment.posted_at,
    authorName: (comment.audience_members as unknown as { display_name: string } | null)?.display_name || 'Unknown',
    category: (comment.comment_categories as unknown as { category: string; topic: string; draft_reply?: string | null } | null)?.category || 'other',
    topic: (comment.comment_categories as unknown as { category: string; topic: string; draft_reply?: string | null } | null)?.topic || null,
    draftReply: (comment.comment_categories as unknown as { draft_reply?: string | null } | null)?.draft_reply || null,
    audienceMemberId: comment.audience_member_id,
  }))

  const categoryCounts: Record<string, number> = {}
  for (const comment of formattedComments) {
    categoryCounts[comment.category] = (categoryCounts[comment.category] || 0) + 1
  }

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
    hasReward: rewardedMemberIds.has(c.audienceMemberId),
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

  return (
    <div className="mx-auto max-w-3xl p-6">
      <PageHeader title={post.title} backHref="/dashboard/inbox" backLabel="My Videos" />

      <div className="mb-4 flex gap-2">
        <Link
          href={`/dashboard/brain?post=${postId}`}
          className="btn-primary inline-flex items-center justify-center"
        >
          Audience Brain
        </Link>
        <Link
          href={`/dashboard/rewards?post=${postId}`}
          className="btn-primary inline-flex items-center justify-center"
        >
          Rewards
        </Link>
      </div>

      <CommentsList
        comments={commentsWithRewardFlag}
        categoryCounts={categoryCounts}
        peopleNoticed={peopleNoticed}
        repeatedCommentIds={repeatedCommentIds}
      />
    </div>
  )
}
