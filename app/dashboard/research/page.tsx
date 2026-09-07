import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { fetchInBatches } from '@/lib/supabase-helpers'
import { computeTrendingGroups, type TrendingComment } from '@/lib/trending'
import ResearchChat from './ResearchChat'
import ResearchSidebar, {
  type ResearchSidebarData,
  type SidebarInsight,
  type SidebarInterest,
} from './ResearchSidebar'

export const dynamic = 'force-dynamic'

const SIDEBAR_TRENDING_LIMIT = 5
const SIDEBAR_INSIGHTS_LIMIT = 6
const SIDEBAR_INTEREST_LIMIT = 5

// Creator-facing wording for the raw category values.
const INTEREST_LABELS: Record<string, string> = {
  praise: 'Praise & appreciation',
  question: 'Questions',
  complaint: 'Complaints',
  purchase_intent: 'Buying interest',
  spam: 'Spam',
  other: 'Everything else',
}

// TODO: replace with real aggregates. These are placeholder figures so the panel's
// layout can be finished; wire them to counts over audience_members / comments
// (total people, total comments, and members with a comment in the last 7 days).
const PLACEHOLDER_OVERVIEW = {
  totalPeople: 1284,
  totalComments: 5310,
  activeThisWeek: 96,
  isPlaceholder: true,
}

// TODO: replace with real sentiment. Nothing in the schema stores a sentiment score
// today — comment_categories holds intent categories (purchase_intent / question /
// complaint / casual), not sentiment. Deriving this needs either a new classifier
// pass writing a sentiment column, or an agreed mapping from the existing
// categories. Until then these percentages are illustrative only.
const PLACEHOLDER_SENTIMENT = {
  positive: 62,
  neutral: 27,
  negative: 11,
  isPlaceholder: true,
}

type CommentRow = {
  id: string
  text: string
  post_id: string
  audience_member_id: string | null
}

/**
 * Everything the sidebar shows that comes from real data: trending topics, plus a
 * merged "recent insights" stream of notifications, drafts awaiting approval, and
 * rewards issued.
 *
 * Failures here degrade to empty cards rather than taking the whole Research page
 * down — the chat is the primary feature and must still load.
 */
async function loadSidebarData(
  supabase: Awaited<ReturnType<typeof createClient>>,
  creatorId: string
): Promise<ResearchSidebarData> {
  const base: ResearchSidebarData = {
    overview: PLACEHOLDER_OVERVIEW,
    trending: [],
    interests: [],
    sentiment: PLACEHOLDER_SENTIMENT,
    insights: [],
  }

  const { data: posts, error: postsError } = await supabase
    .from('posts')
    .select('id, title')
    .eq('creator_id', creatorId)

  if (postsError) {
    console.error('Research sidebar posts error:', JSON.stringify(postsError, Object.getOwnPropertyNames(postsError), 2))
    return base
  }

  const postList = posts || []
  const postIds = postList.map(p => p.id)
  const postMap = new Map(postList.map(p => [p.id, p.title || 'Untitled video']))

  // Comments are paged rather than fetched in one shot — a busy channel is well
  // past Supabase's 1000-row default cap, and a truncated set would silently
  // under-report which topics repeat.
  const comments: CommentRow[] = []
  if (postIds.length > 0) {
    let offset = 0
    const batchSize = 1000
    let hasMore = true

    while (hasMore) {
      const { data: batch, error: commentsError } = await supabase
        .from('comments')
        .select('id, text, post_id, audience_member_id')
        .in('post_id', postIds)
        .range(offset, offset + batchSize - 1)

      if (commentsError) {
        console.error('Research sidebar comments error:', JSON.stringify(commentsError, Object.getOwnPropertyNames(commentsError), 2))
        break
      }

      if (batch && batch.length > 0) {
        comments.push(...batch)
        offset += batchSize
      }

      if (!batch || batch.length < batchSize) hasMore = false
    }
  }

  const trendingSource: TrendingComment[] = comments.map(c => ({
    text: c.text,
    post_id: c.post_id,
    audience_member_id: c.audience_member_id,
  }))

  const allTrending = computeTrendingGroups(trendingSource, postMap, 2)

  // Share of all repeated mentions, not of all comments — a group that is 4 of the
  // 30 repeated mentions reads as 13%, where "4 of 652 total comments" would read
  // as 0.6% and make every trending row look insignificant.
  const totalTrendingMentions = allTrending.reduce((sum, g) => sum + g.count, 0) || 1

  const trending = allTrending.slice(0, SIDEBAR_TRENDING_LIMIT).map(group => ({
    text: group.text,
    count: group.count,
    unique_people: group.unique_people,
    percentage: Math.round((group.count / totalTrendingMentions) * 100),
  }))

  let interests: SidebarInterest[] = []
  const insights: SidebarInsight[] = []

  const { data: notifications, error: notificationsError } = await supabase
    .from('notifications')
    .select('message, created_at')
    .eq('creator_id', creatorId)
    .order('created_at', { ascending: false })
    .limit(SIDEBAR_INSIGHTS_LIMIT)

  if (notificationsError) {
    console.error('Research sidebar notifications error:', JSON.stringify(notificationsError, Object.getOwnPropertyNames(notificationsError), 2))
  } else {
    for (const notification of notifications || []) {
      insights.push({ kind: 'notification', text: notification.message, at: notification.created_at })
    }
  }

  // Drafts written but not yet approved — scoped to this creator by only ever
  // looking up categories for comment ids we already resolved from their posts.
  if (comments.length > 0) {
    const categories = await fetchInBatches<{
      comment_id: string
      category: string
      draft_reply: string | null
      draft_reply_approved_at: string | null
      draft_reply_created_at: string | null
    }>(supabase, {
      table: 'comment_categories',
      select: 'comment_id, category, draft_reply, draft_reply_approved_at, draft_reply_created_at',
      inColumn: 'comment_id',
      inValues: comments.map(c => c.id),
    })

    // --- "What your audience talks about", from the category mix.
    //
    // Deliberately NOT built from comment_categories.topic: that column is fully
    // populated, but it holds 482 distinct values across 652 rows, with the most
    // common ("content_quality") appearing 10 times. Bars from that would all read
    // ~1% and tell the creator nothing. The category split is coarser but real and
    // meaningfully sized.
    const categoryCounts = new Map<string, number>()
    for (const row of categories) {
      if (!row.category) continue
      categoryCounts.set(row.category, (categoryCounts.get(row.category) || 0) + 1)
    }

    const categorized = Array.from(categoryCounts.values()).reduce((a, b) => a + b, 0)
    if (categorized > 0) {
      interests = Array.from(categoryCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, SIDEBAR_INTEREST_LIMIT)
        .map(([category, count]) => ({
          category,
          label: INTEREST_LABELS[category] || category.replace(/_/g, ' '),
          count,
          percentage: Math.round((count / categorized) * 100),
        }))
    }

    const commentById = new Map(comments.map(c => [c.id, c]))

    const pending = categories
      .filter(c => c.draft_reply && !c.draft_reply_approved_at)
      .sort((a, b) => {
        const aTime = a.draft_reply_created_at ? new Date(a.draft_reply_created_at).getTime() : 0
        const bTime = b.draft_reply_created_at ? new Date(b.draft_reply_created_at).getTime() : 0
        return bTime - aTime
      })
      .slice(0, SIDEBAR_INSIGHTS_LIMIT)

    for (const category of pending) {
      const comment = commentById.get(category.comment_id)
      const video = comment ? postMap.get(comment.post_id) || 'a video' : 'a video'
      insights.push({
        kind: 'pending_draft',
        text: `Reply drafted for a ${category.category.replace(/_/g, ' ')} comment on “${video}” — waiting on your approval.`,
        at: category.draft_reply_created_at,
      })
    }
  }

  const { data: members, error: membersError } = await supabase
    .from('audience_members')
    .select('id')
    .eq('creator_id', creatorId)

  if (membersError) {
    console.error('Research sidebar members error:', JSON.stringify(membersError, Object.getOwnPropertyNames(membersError), 2))
  } else {
    const memberIds = (members || []).map(m => m.id)
    if (memberIds.length > 0) {
      const rewardEvents = await fetchInBatches<{
        reason: string
        created_at: string
        audience_members: unknown
      }>(supabase, {
        table: 'reward_events',
        select: 'reason, created_at, audience_members ( display_name )',
        inColumn: 'audience_member_id',
        inValues: memberIds,
      })

      const recentRewards = rewardEvents
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, SIDEBAR_INSIGHTS_LIMIT)

      for (const event of recentRewards) {
        const name = (event.audience_members as { display_name: string } | null)?.display_name || 'Someone'
        insights.push({ kind: 'reward', text: `${name} recognized — ${event.reason}`, at: event.created_at })
      }
    }
  }

  // Three separately-sorted streams merged into one newest-first list. Undated
  // entries sort last rather than jumping to the top as epoch 0 would.
  insights.sort((a, b) => {
    const aTime = a.at ? new Date(a.at).getTime() : -Infinity
    const bTime = b.at ? new Date(b.at).getTime() : -Infinity
    return bTime - aTime
  })

  return {
    ...base,
    trending,
    interests,
    insights: insights.slice(0, SIDEBAR_INSIGHTS_LIMIT),
  }
}

export default async function ResearchPage() {
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
    console.error('Research creator fetch error:', JSON.stringify(creatorError, Object.getOwnPropertyNames(creatorError), 2))
    return (
      <div className="p-6">
        <p className="text-red-500">Failed to load your account details.</p>
      </div>
    )
  }

  if (!creator) {
    redirect('/login')
  }

  const sidebarData = await loadSidebarData(supabase, creator.id)

  return (
    // Below lg the sidebar is hidden entirely rather than stacked underneath: its
    // content is surfaced inside ResearchChat's own mobile landing view instead, so
    // stacking it too would repeat every card twice on a phone.
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <ResearchChat
        creatorId={creator.id}
        interests={sidebarData.interests}
        trending={sidebarData.trending}
      />
      <div className="hidden lg:block">
        <ResearchSidebar data={sidebarData} />
      </div>
    </div>
  )
}
