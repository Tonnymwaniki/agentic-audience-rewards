import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { fetchInBatches } from '@/lib/supabase-helpers'
import { loadHighlights } from '@/lib/highlights'
import { buildActivityFeed } from '@/lib/activity'
import { CONNECT_PATH } from '@/lib/onboarding'
import CategoryPrompt from './CategoryPrompt'
import AgentSummary from './AgentFeed'

export const dynamic = 'force-dynamic'

const SUMMARY_WINDOW_HOURS = 24
// Just a preview — the full set lives on Highlights, one click away.
const ATTENTION_PREVIEW_LIMIT = 3
const ACTIVITY_LIMIT = 5

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
    console.error('Agent home creator fetch error:', JSON.stringify(creatorError, Object.getOwnPropertyNames(creatorError), 2))
    return (
      <div className="p-6">
        <p className="text-red-500">Failed to load your account details.</p>
      </div>
    )
  }

  if (!creator) {
    redirect('/login')
  }

  // Falls back to email or "there" only if this creator predates display_name being
  // populated at signup — per product decision, an email value is shown as-is, not parsed.
  const creatorDisplayName = creator.display_name || user.email || 'there'

  const { data: posts, error: postsError } = await supabase
    .from('posts')
    .select('id')
    .eq('creator_id', creator.id)

  if (postsError) {
    console.error('Agent home posts fetch error:', JSON.stringify(postsError, Object.getOwnPropertyNames(postsError), 2))
    return (
      <div className="p-6">
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

  type CommentRow = { id: string; posted_at: string }
  const allComments: CommentRow[] = []

  if (postIds.length > 0) {
    let offset = 0
    const batchSize = 1000
    let hasMore = true

    while (hasMore) {
      const { data: batch, error: commentsError } = await supabase
        .from('comments')
        .select('id, posted_at')
        .in('post_id', postIds)
        .range(offset, offset + batchSize - 1)

      if (commentsError) {
        console.error('Agent home comments fetch error:', JSON.stringify(commentsError, Object.getOwnPropertyNames(commentsError), 2))
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
  }

  let categories: CategoryRow[] = []

  if (allComments.length > 0) {
    categories = await fetchInBatches<CategoryRow>(supabase, {
      table: 'comment_categories',
      select: 'comment_id, category, draft_reply, draft_reply_approved_at',
      inColumn: 'comment_id',
      inValues: allComments.map(c => c.id),
    })
  }

  const categoriesByCommentId = new Map(categories.map(c => [c.comment_id, c]))

  const oneDayAgo = new Date(Date.now() - SUMMARY_WINDOW_HOURS * 60 * 60 * 1000)

  // --- Header stats (rolling 24h — no per-creator timezone is stored, so this is
  // "last 24 hours", not a calendar-aligned day) ---
  const commentsToday = allComments.filter(c => new Date(c.posted_at) >= oneDayAgo)
  const commentsReadCount = commentsToday.length
  const draftsWrittenCount = commentsToday.filter(c => categoriesByCommentId.get(c.id)?.draft_reply).length

  // --- All-time context, shown when today is quiet ---
  const totalCommentsCount = allComments.length
  const totalDraftsCount = categories.filter(c => c.draft_reply).length

  // --- Replies waiting on the creator. purchase_intent is split out because those
  // are the ones with money attached — they drive the "opportunities" banner. ---
  const pendingDraftRows = categories.filter(c => c.draft_reply && !c.draft_reply_approved_at)
  const repliesReadyCount = pendingDraftRows.length
  const purchaseIntentReadyCount = pendingDraftRows.filter(c => c.category === 'purchase_intent').length

  // --- Reward events: only created_at is needed here (counts, not cards) ---
  const { data: creatorAudienceMembers, error: audienceError } = await supabase
    .from('audience_members')
    .select('id')
    .eq('creator_id', creator.id)

  if (audienceError) {
    console.error('Agent home audience members fetch error:', JSON.stringify(audienceError, Object.getOwnPropertyNames(audienceError), 2))
  }

  const memberIds = (creatorAudienceMembers || []).map(m => m.id)

  let recognizedTodayCount = 0
  let totalRecognizedCount = 0
  let latestRewardAt: string | null = null
  let recentRewards: Array<{ personName: string; reason: string; at: string | null }> = []

  if (memberIds.length > 0) {
    // Batched: a single .in() with hundreds of member ids exceeds Supabase's URL
    // length limit and fails outright.
    const events = await fetchInBatches<{
      created_at: string
      reason: string
      audience_members: unknown
    }>(supabase, {
      table: 'reward_events',
      select: 'created_at, reason, audience_members ( display_name )',
      inColumn: 'audience_member_id',
      inValues: memberIds,
    })

    totalRecognizedCount = events.length
    recognizedTodayCount = events.filter(e => new Date(e.created_at) >= oneDayAgo).length

    for (const event of events) {
      if (!latestRewardAt || event.created_at > latestRewardAt) latestRewardAt = event.created_at
    }

    recentRewards = [...events]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, ACTIVITY_LIMIT)
      .map(event => ({
        personName: (event.audience_members as { display_name: string } | null)?.display_name || 'Someone',
        reason: event.reason,
        at: event.created_at,
      }))
  }

  const { data: recentNotifications, error: notificationError } = await supabase
    .from('notifications')
    .select('message, created_at')
    .eq('creator_id', creator.id)
    .order('created_at', { ascending: false })
    .limit(ACTIVITY_LIMIT)

  if (notificationError) {
    console.error('Agent home notification fetch error:', JSON.stringify(notificationError, Object.getOwnPropertyNames(notificationError), 2))
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

  // --- Needs Your Attention: the same selection Highlights uses, previewed ---
  const { draftHighlights, escalatedHighlights, totalPendingDrafts } = await loadHighlights(
    supabase,
    creator.id,
    ATTENTION_PREVIEW_LIMIT
  )

  // --- Recent Activity. Built from data already loaded above rather than
  // re-querying: draftHighlights doubles as the pending-draft stream. ---
  const activity = buildActivityFeed(
    {
      notifications: (recentNotifications || []).map(n => ({ message: n.message, at: n.created_at })),
      pendingDrafts: draftHighlights.map(h => ({
        category: h.category || 'comment',
        videoTitle: h.videoTitle,
        at: h.postedAt,
      })),
      rewards: recentRewards,
    },
    ACTIVITY_LIMIT
  )

  return (
    <div>
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
        pendingHighlightsCount={totalPendingDrafts}
        repliesReadyCount={repliesReadyCount}
        purchaseIntentReadyCount={purchaseIntentReadyCount}
        attentionItems={draftHighlights}
        escalatedItems={escalatedHighlights}
        activity={activity}
      />
    </div>
  )
}
