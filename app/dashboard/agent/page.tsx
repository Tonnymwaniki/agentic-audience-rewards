import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { fetchInBatches } from '@/lib/supabase-helpers'
import { CONNECT_PATH } from '@/lib/onboarding'
import CategoryPrompt from './CategoryPrompt'
import AgentSummary from './AgentFeed'
import {
  computeActivityWindows,
  computeWeeklyActivity,
  computeHourlyActivity,
  computeLatencyActivity,
} from '@/lib/timing'
import RefreshOnFocus from './RefreshOnFocus'
import AudienceAnalytics, { AudienceAnalyticsSkeleton } from './AudienceAnalytics'
import { Suspense } from 'react'
import AgentWorkspace, { AgentWorkspaceSkeleton } from './AgentWorkspace'
import { logError } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'
import { resolveVerifiedPostIds } from '@/lib/channel-verification'
import { countsAsRecognition } from '@/lib/rewards/status'
import { computeAgentHeaderStats, type StatsRewardEvent } from '@/lib/agent-stats'

export const dynamic = 'force-dynamic'

// Just a preview — the full set lives on Highlights, one click away.
// A glanceable row, not a directory — Rewards is the full list.

// Server-clock based, and the server is UTC on Vercel. No per-creator timezone is
// stored anywhere in the schema, so this is genuinely the best available signal —
// storing one would be the fix, not guessing from the request.
function greetingFor(date: Date): string {
  const hour = date.getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

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
    .select('id, display_name, business_category')
    .eq('user_id', user.id)
    .maybeSingle()

  if (creatorError) {
    logError('page.agent', creatorError, { user_id: user.id, stage: 'fetch_creator' })
    return (
      <div>
        <p className="text-red-500">Failed to load your account details.</p>
      </div>
    )
  }

  if (!creator) {
    redirect('/login')
  }

  // display_name is what the creator set on Business Profile. Signup seeds it with
  // the email address, and clearing the field stores NULL, so both the "never set
  // it" and the "set it then cleared it" paths land on the email — which is shown
  // as-is, not parsed, per product decision. "there" is the last resort.
  const creatorDisplayName = creator.display_name || user.email || 'there'

  // posted_at is the video's real YouTube upload time, needed by the "since
  // posted" view to measure how long after publication each comment arrived.
  const { data: posts, error: postsError } = await supabase
    .from('posts')
    .select('id, title, posted_at')
    .eq('creator_id', creator.id)

  if (postsError) {
    logError('page.agent', postsError, { creator_id: creator.id, stage: 'fetch_posts' })
    return (
      <div>
        <p className="text-red-500">Failed to load your videos.</p>
      </div>
    )
  }

  const postIds = (posts || []).map(p => p.id)

  // Safeguard for anyone landing here directly — a bookmark, the back button, or a
  // typed URL — before analyzing anything. Agent Home with no videos is a page of
  // zeroes that explains nothing, so send them to the connect flow instead.
  //
  // Reuses the posts fetch above rather than calling creatorHasPosts(): the rows are
  // already loaded here, and a second count query would be pure waste. The postsError
  // branch above returns first, so an empty list here genuinely means zero posts
  // rather than a failed read.
  //
  // Must stay outside any try/catch — redirect() signals by throwing.
  if (postIds.length === 0) {
    redirect(CONNECT_PATH)
  }

  type CommentRow = { id: string; posted_at: string; post_id: string; ingested_at: string | null }
  const allComments: CommentRow[] = []

  if (postIds.length > 0) {
    let offset = 0
    const batchSize = 1000
    let hasMore = true

    while (hasMore) {
      const { data: batch, error: commentsError } = await supabase
        .from('comments')
        .select('id, posted_at, post_id, ingested_at')
        .in('post_id', postIds)
        .range(offset, offset + batchSize - 1)

      if (commentsError) {
        logError('page.agent', commentsError, { creator_id: creator.id, stage: 'fetch_comments', offset })
        break
      }

      if (batch && batch.length > 0) {
        allComments.push(...batch)
        offset += batchSize
      }

      if (!batch || batch.length < batchSize) {
        hasMore = false
      }
    }
  }

  type CategoryRow = {
    comment_id: string
    category: string
    draft_reply: string | null
    draft_reply_approved_at: string | null
    draft_reply_created_at: string | null
  }

  let categories: CategoryRow[] = []

  if (allComments.length > 0) {
    categories = await fetchInBatches<CategoryRow>(supabase, {
      table: 'comment_categories',
      select: 'comment_id, category, draft_reply, draft_reply_approved_at, draft_reply_created_at',
      inColumn: 'comment_id',
      inValues: allComments.map(c => c.id),
    })
  }


  // --- Header stats are computed below by computeAgentHeaderStats (lib/agent-stats),
  // once reward events are loaded, so the page and its tests share the arithmetic.
  //
  // Only drafts on channels the creator has VERIFIED are actionable. Drafts written
  // before ownership verification existed, on channels still unverified, are kept
  // but not offered for approval anywhere (the approve endpoint refuses them too).
  // Service client: the verification lookup reads youtube_oauth_tokens, which the
  // signed-in role cannot see; creator.id comes from the session above.
  const actionablePostIds = await resolveVerifiedPostIds(createServiceClient(), creator.id, postIds)

  // --- Reward events: only created_at is needed here (counts, not cards) ---
  const { data: creatorAudienceMembers, error: audienceError } = await supabase
    .from('audience_members')
    .select('id')
    .eq('creator_id', creator.id)

  if (audienceError) {
    logError('page.agent', audienceError, { creator_id: creator.id, stage: 'fetch_audience_members' })
  }

  const memberIds = (creatorAudienceMembers || []).map(m => m.id)

  let rewardEventsForStats: StatsRewardEvent[] = []
  let latestRewardAt: string | null = null

  if (memberIds.length > 0) {
    // Batched: a single .in() with hundreds of member ids exceeds Supabase's URL
    // length limit and fails outright.
    const allEvents = await fetchInBatches<{
      audience_member_id: string
      created_at: string
      status: string
    }>(supabase, {
      table: 'reward_events',
      select: 'audience_member_id, created_at, status',
      inColumn: 'audience_member_id',
      inValues: memberIds,
    })
    // Voided rewards (issued before ownership verification) are audit rows, not
    // recognition: excluded from the counts and from "last activity".
    const events = allEvents.filter(e => countsAsRecognition(e.status))
    rewardEventsForStats = allEvents

    for (const event of events) {
      if (!latestRewardAt || event.created_at > latestRewardAt) latestRewardAt = event.created_at
    }
  }

  const {
    commentsReadCount,
    draftsWrittenCount,
    repliesReadyCount,
    purchaseIntentReadyCount,
    recognizedTodayCount,
    totalCommentsCount,
    totalDraftsCount,
    totalRecognizedCount,
  } = computeAgentHeaderStats({
    comments: allComments,
    categories,
    rewardEvents: rewardEventsForStats,
    actionablePostIds,
  })

  // Only the newest notification's time is needed, for "last activity".
  const { data: recentNotifications, error: notificationError } = await supabase
    .from('notifications')
    .select('created_at')
    .eq('creator_id', creator.id)
    .order('created_at', { ascending: false })
    .limit(1)

  if (notificationError) {
    logError('page.agent', notificationError, { creator_id: creator.id, stage: 'fetch_notifications' })
  }

  let latestCommentAt: string | null = null
  for (const comment of allComments) {
    if (!latestCommentAt || comment.posted_at > latestCommentAt) latestCommentAt = comment.posted_at
  }

  // --- Last activity: the newest timestamp across everything the agent does, so
  // the status card reflects real work rather than page-load time.
  // ISO-8601 UTC strings compare correctly as plain strings, so no Date parsing needed. ---
  const lastActivityAt = [latestCommentAt, latestRewardAt, recentNotifications?.[0]?.created_at ?? null]
    .filter((value): value is string => Boolean(value))
    .sort()
    .pop() ?? null

  // Busiest posting windows, in EAT. allComments already carries posted_at for the
  // 24h stats, so this is arithmetic over memory rather than another query.
  const activityWindows = computeActivityWindows(allComments, 3)
  const weeklyActivity = computeWeeklyActivity(allComments)
  const hourlyActivity = computeHourlyActivity(allComments)

  // How long after each video went live its comments arrived. Uses the posts rows
  // already loaded above, so no extra query — and any post still missing a publish
  // timestamp is reported rather than silently assumed.
  const latencyActivity = computeLatencyActivity(
    allComments,
    new Map((posts || []).map(p => [p.id, (p.posted_at as string | null) ?? null]))
  )

  // Every category row for this creator is already loaded above for the drafts and
  // stats, so the breakdown is a tally over memory rather than another query.
  const categoryCounts: Record<string, number> = {}
  for (const row of categories) {
    if (!row.category) continue
    categoryCounts[row.category] = (categoryCounts[row.category] ?? 0) + 1
  }

  // The same tally again, split per video, so the breakdown widget can cycle
  // through them. Built from the two arrays already in memory — commentsById maps
  // a category row back to the video its comment belongs to.
  const postById = new Map((posts || []).map(p => [p.id, (p.title as string | null) || 'Untitled video']))
  const postIdByCommentId = new Map(allComments.map(c => [c.id, c.post_id]))
  const countsByPost = new Map<string, Record<string, number>>()

  for (const row of categories) {
    if (!row.category) continue
    const postId = postIdByCommentId.get(row.comment_id)
    if (!postId) continue
    const bucket = countsByPost.get(postId) ?? {}
    bucket[row.category] = (bucket[row.category] ?? 0) + 1
    countsByPost.set(postId, bucket)
  }

  // Busiest video first, so the cycle opens on the one with the most to say.
  const videoBreakdowns = [...countsByPost.entries()]
    .map(([postId, counts]) => ({
      postId,
      title: postById.get(postId) ?? 'Untitled video',
      counts,
      total: Object.values(counts).reduce((sum, n) => sum + n, 0),
    }))
    .sort((a, b) => b.total - a.total)

  return (
    <div>
      {/* force-dynamic already makes every navigation re-render on the server; this
          additionally refreshes a tab that was left open in the background. */}
      <RefreshOnFocus />
      {!creator.business_category && (
        <div className="mb-6">
          <CategoryPrompt />
        </div>
      )}
      <AgentSummary
        greeting={greetingFor(new Date())}
        creatorDisplayName={creatorDisplayName}
        lastActivityAt={lastActivityAt}
        commentsReadCount={commentsReadCount}
        draftsWrittenCount={draftsWrittenCount}
        recognizedCount={recognizedTodayCount}
        totalCommentsCount={totalCommentsCount}
        totalDraftsCount={totalDraftsCount}
        totalRecognizedCount={totalRecognizedCount}
        repliesReadyCount={repliesReadyCount}
        purchaseIntentReadyCount={purchaseIntentReadyCount}
        workspace={
          <Suspense fallback={<AgentWorkspaceSkeleton />}>
            <AgentWorkspace creatorId={creator.id} />
          </Suspense>
        }
        categoryCounts={categoryCounts}
        videoBreakdowns={videoBreakdowns}
        activityWindows={activityWindows.windows}
        datedCommentCount={activityWindows.totalComments}
        weekdayActivity={weeklyActivity.days}
        hourlyActivity={hourlyActivity.hours}
        latencyBuckets={latencyActivity.buckets}
        latencyTotal={latencyActivity.totalComments}
        latencySkipped={latencyActivity.skippedNoPublishDate}
      />
      {/* Streams in on its own: four YouTube Analytics calls must never delay the
          rest of Agent Home. Renders nothing without a verified channel. */}
      <div className="mt-5">
        <Suspense fallback={<AudienceAnalyticsSkeleton />}>
          <AudienceAnalytics creatorId={creator.id} />
        </Suspense>
      </div>
    </div>
  )
}
