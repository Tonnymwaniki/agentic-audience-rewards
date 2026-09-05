import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { fetchInBatches } from '@/lib/supabase-helpers'
import PageHeader from '@/components/PageHeader'
import AgentFeed, { type FeedGroup, type FeedItem } from './AgentFeed'

export const dynamic = 'force-dynamic'

const FEED_WINDOW_DAYS = 7
const SUMMARY_WINDOW_HOURS = 24
const PENDING_DRAFTS_LIMIT = 30
const NOTIFICATIONS_LIMIT = 50

export default async function AgentHomePage() {
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

  const { data: posts, error: postsError } = await supabase
    .from('posts')
    .select('id, title')
    .eq('creator_id', creator.id)

  if (postsError) {
    console.error('Agent home posts fetch error:', JSON.stringify(postsError, Object.getOwnPropertyNames(postsError), 2))
    return (
      <div className="p-6">
        <p className="text-red-500">Failed to load your videos.</p>
      </div>
    )
  }

  const postList = posts || []
  const postIds = postList.map(p => p.id)
  const postMap = new Map(postList.map(p => [p.id, p.title]))

  type CommentRow = {
    id: string
    text: string
    posted_at: string
    post_id: string
    audience_member_id: string
    audience_members: { display_name: string } | null
  }

  // Full (not time-bound) fetch, same batched pattern as the Brain/Inbox pages —
  // pending drafts need to surface regardless of how old the underlying comment is,
  // so we can't pre-filter this by date at the query level.
  const allComments: CommentRow[] = []

  if (postIds.length > 0) {
    let offset = 0
    const batchSize = 1000
    let hasMore = true

    while (hasMore) {
      const { data: batch, error: commentsError } = await supabase
        .from('comments')
        .select('id, text, posted_at, post_id, audience_member_id, audience_members (display_name)')
        .in('post_id', postIds)
        .order('posted_at', { ascending: false })
        .range(offset, offset + batchSize - 1)

      if (commentsError) {
        console.error('Agent home comments fetch error:', JSON.stringify(commentsError, Object.getOwnPropertyNames(commentsError), 2))
        break
      }

      if (batch && batch.length > 0) {
        allComments.push(...(batch as unknown as CommentRow[]))
        offset += batchSize
      }

      if (!batch || batch.length < batchSize) {
        hasMore = false
      }
    }
  }

  const commentIds = allComments.map(c => c.id)

  type CategoryRow = {
    comment_id: string
    category: string
    topic: string | null
    draft_reply: string | null
    draft_reply_approved_at: string | null
  }

  let categories: CategoryRow[] = []

  if (commentIds.length > 0) {
    categories = await fetchInBatches<CategoryRow>(supabase, {
      table: 'comment_categories',
      select: 'comment_id, category, topic, draft_reply, draft_reply_approved_at',
      inColumn: 'comment_id',
      inValues: commentIds,
    })
  }

  const categoriesByCommentId = new Map(categories.map(c => [c.comment_id, c]))

  const now = Date.now()
  const sevenDaysAgo = new Date(now - FEED_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const oneDayAgo = new Date(now - SUMMARY_WINDOW_HOURS * 60 * 60 * 1000)

  const recentComments = allComments.filter(c => new Date(c.posted_at) >= sevenDaysAgo)

  // --- All-time totals, for the empty state — proves the agent has real history
  // even when nothing happened in the recent-activity windows above ---
  const totalCommentsCount = allComments.length
  const totalDraftsCount = categories.filter(c => c.draft_reply).length

  // --- Header summary stats (rolling 24h — there's no per-creator timezone stored,
  // so this is "last 24 hours," not a calendar-aligned "today") ---
  const commentsToday = allComments.filter(c => new Date(c.posted_at) >= oneDayAgo)
  const commentsReadCount = commentsToday.length
  const draftsWrittenCount = commentsToday.filter(c => categoriesByCommentId.get(c.id)?.draft_reply).length

  // --- Recent comment activity, grouped per video (satisfies "grouped by count") ---
  const activityByPost = new Map<string, { count: number; categoryBreakdown: Record<string, number>; latest: string }>()

  for (const comment of recentComments) {
    const category = categoriesByCommentId.get(comment.id)?.category || 'other'
    const existing = activityByPost.get(comment.post_id)

    if (existing) {
      existing.count++
      existing.categoryBreakdown[category] = (existing.categoryBreakdown[category] || 0) + 1
      if (comment.posted_at > existing.latest) existing.latest = comment.posted_at
    } else {
      activityByPost.set(comment.post_id, {
        count: 1,
        categoryBreakdown: { [category]: 1 },
        latest: comment.posted_at,
      })
    }
  }

  const commentActivityItems: FeedItem[] = Array.from(activityByPost.entries()).map(([postId, data]) => ({
    type: 'comment_activity',
    key: `activity-${postId}`,
    postId,
    videoTitle: postMap.get(postId) || 'Untitled video',
    count: data.count,
    categoryBreakdown: data.categoryBreakdown,
    timestamp: data.latest,
  }))

  // --- Pending drafted replies — a backlog, so no time bound, just a UI safety cap ---
  const pendingDrafts = allComments
    .filter(c => {
      const cat = categoriesByCommentId.get(c.id)
      return cat?.draft_reply && !cat.draft_reply_approved_at
    })
    .sort((a, b) => new Date(b.posted_at).getTime() - new Date(a.posted_at).getTime())
    .slice(0, PENDING_DRAFTS_LIMIT)

  const pendingDraftItems: FeedItem[] = pendingDrafts.map(comment => {
    const cat = categoriesByCommentId.get(comment.id)!
    return {
      type: 'pending_draft',
      key: `draft-${comment.id}`,
      commentId: comment.id,
      postId: comment.post_id,
      videoTitle: postMap.get(comment.post_id) || 'Untitled video',
      authorName: comment.audience_members?.display_name || 'Unknown',
      commentText: comment.text,
      draftReply: cat.draft_reply!,
      category: cat.category,
      timestamp: comment.posted_at,
    }
  })

  // --- Recent reward events (last 7 days) ---
  const { data: creatorAudienceMembers, error: audienceError } = await supabase
    .from('audience_members')
    .select('id')
    .eq('creator_id', creator.id)

  if (audienceError) {
    console.error('Agent home audience members fetch error:', JSON.stringify(audienceError, Object.getOwnPropertyNames(audienceError), 2))
  }

  const memberIds = (creatorAudienceMembers || []).map(m => m.id)

  let rewardEventItems: FeedItem[] = []
  let recognizedTodayCount = 0
  let totalRecognizedCount = 0

  if (memberIds.length > 0) {
    // Fetched all-time (no gte filter) so we can report a real total for the empty
    // state, then filtered client-side for the 7-day feed and 24h header count —
    // same full-fetch-then-filter approach already used for comments above.
    const { data: rewardEvents, error: rewardError, count: rewardCount } = await supabase
      .from('reward_events')
      .select('id, post_id, reason, status, claim_token, tx_hash, created_at, audience_members (display_name)', { count: 'exact' })
      .in('audience_member_id', memberIds)
      .order('created_at', { ascending: false })

    if (rewardError) {
      console.error('Agent home reward events fetch error:', JSON.stringify(rewardError, Object.getOwnPropertyNames(rewardError), 2))
    } else {
      const events = rewardEvents || []
      totalRecognizedCount = rewardCount ?? events.length
      recognizedTodayCount = events.filter(e => new Date(e.created_at) >= oneDayAgo).length
      const recentEvents = events.filter(e => new Date(e.created_at) >= sevenDaysAgo)

      rewardEventItems = recentEvents.map(event => ({
        type: 'reward',
        key: `reward-${event.id}`,
        rewardEventId: event.id,
        postId: event.post_id,
        videoTitle: event.post_id ? postMap.get(event.post_id) || 'Untitled video' : 'General',
        displayName: (event.audience_members as unknown as { display_name: string } | null)?.display_name || 'Unknown',
        reason: event.reason,
        status: event.status,
        claimToken: event.claim_token,
        txHash: event.tx_hash,
        timestamp: event.created_at,
      }))
    }
  }

  // --- Unread notifications ---
  const { data: notifications, error: notificationsError } = await supabase
    .from('notifications')
    .select('id, type, message, created_at, comments (post_id)')
    .eq('creator_id', creator.id)
    .eq('read', false)
    .order('created_at', { ascending: false })
    .limit(NOTIFICATIONS_LIMIT)

  if (notificationsError) {
    console.error('Agent home notifications fetch error:', JSON.stringify(notificationsError, Object.getOwnPropertyNames(notificationsError), 2))
  }

  const notificationItems: FeedItem[] = (notifications || []).map(n => {
    const postId = (n.comments as unknown as { post_id: string } | null)?.post_id || null
    return {
      type: 'notification',
      key: `notification-${n.id}`,
      notificationId: n.id,
      postId,
      videoTitle: postId ? postMap.get(postId) || 'Untitled video' : 'General',
      message: n.message,
      notifType: n.type,
      timestamp: n.created_at,
    }
  })

  // --- Combine everything and group by video ---
  const allItems: FeedItem[] = [
    ...commentActivityItems,
    ...pendingDraftItems,
    ...rewardEventItems,
    ...notificationItems,
  ]

  const groupsMap = new Map<string, FeedGroup>()

  for (const item of allItems) {
    const groupKey = item.postId || 'general'
    const existing = groupsMap.get(groupKey)

    if (existing) {
      existing.items.push(item)
      if (item.timestamp > existing.latestTimestamp) existing.latestTimestamp = item.timestamp
    } else {
      groupsMap.set(groupKey, {
        postId: groupKey,
        videoTitle: item.videoTitle,
        items: [item],
        latestTimestamp: item.timestamp,
      })
    }
  }

  const groups: FeedGroup[] = Array.from(groupsMap.values())
    .map(group => ({
      ...group,
      items: group.items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()),
    }))
    .sort((a, b) => new Date(b.latestTimestamp).getTime() - new Date(a.latestTimestamp).getTime())

  const groupByVideo = groups.length > 1

  return (
    <div>
      <PageHeader title="Agent Home" />
      <AgentFeed
        commentsReadCount={commentsReadCount}
        draftsWrittenCount={draftsWrittenCount}
        recognizedCount={recognizedTodayCount}
        totalCommentsCount={totalCommentsCount}
        totalDraftsCount={totalDraftsCount}
        totalRecognizedCount={totalRecognizedCount}
        groups={groups}
        groupByVideo={groupByVideo}
      />
    </div>
  )
}
