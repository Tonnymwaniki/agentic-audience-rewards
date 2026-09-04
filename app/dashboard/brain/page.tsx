import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import PageHeader from '@/components/PageHeader'
import { fetchInBatches } from '@/lib/supabase-helpers'
import AskAudience from './AskAudience'

export const dynamic = 'force-dynamic'

const CATEGORIES = [
  'question',
  'praise',
  'complaint',
  'purchase_intent',
  'spam',
  'other',
] as const

export default async function BrainPage({
  searchParams,
}: {
  searchParams: Promise<{ post?: string }>
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

  const { data: posts, error: postsError } = await supabase
    .from('posts')
    .select('id, title, ingested_at')
    .eq('creator_id', creator.id)

  if (postsError) {
    console.error('Posts fetch error:', JSON.stringify(postsError, Object.getOwnPropertyNames(postsError), 2))
    return (
      <div className="p-6">
        <p className="text-red-500">Failed to load posts</p>
      </div>
    )
  }

  const postList = posts || []
  const postIds = postList.map(p => p.id)

  let comments: Array<{
    id: string
    text: string
    posted_at: string
    post_id: string
    audience_members: { display_name: string } | null
  }> = []
  let commentCategories: Array<{ comment_id: string; category: string; topic: string | null }> = []

  if (postIds.length > 0) {
    const allCommentRows: Array<{
      id: string
      text: string
      posted_at: string
      post_id: string
      audience_members: { display_name: string } | null
    }> = []
    let offset = 0
    const batchSize = 1000
    let hasMore = true

    while (hasMore) {
      const { data: batch, error: commentsError } = await supabase
        .from('comments')
        .select('id, text, posted_at, post_id, audience_members (display_name)')
        .in('post_id', postIds)
        .order('posted_at', { ascending: false })
        .range(offset, offset + batchSize - 1)

      if (commentsError) {
        console.error('Comments paginated fetch error:', JSON.stringify(commentsError, Object.getOwnPropertyNames(commentsError), 2))
        break
      }

      if (batch && batch.length > 0) {
        allCommentRows.push(...(batch as any))
        offset += batchSize
      }

      if (!batch || batch.length < batchSize) {
        hasMore = false
      }
    }

    comments = allCommentRows

    const commentIds = comments.map(c => c.id)

    if (commentIds.length > 0) {
      const categoryRows = await fetchInBatches<{ comment_id: string; category: string; topic: string | null }>(supabase, {
        table: 'comment_categories',
        select: 'comment_id, category, topic',
        inColumn: 'comment_id',
        inValues: commentIds,
      })

      commentCategories = categoryRows
    }
  }

  const params = await searchParams
  const selectedPostId = params.post || null

  let filteredComments = comments
  let filteredCategories = commentCategories

  if (selectedPostId) {
    filteredComments = comments.filter(c => c.post_id === selectedPostId)
    const filteredCommentIds = new Set(filteredComments.map(c => c.id))
    filteredCategories = commentCategories.filter(c => filteredCommentIds.has(c.comment_id))
  }

  const categoriesByCommentId = new Map(
    filteredCategories.map(c => [c.comment_id, c])
  )

  const totalComments = filteredComments.length

  const categoryCounts: Record<string, number> = {}
  for (const cat of CATEGORIES) {
    categoryCounts[cat] = 0
  }
  for (const cat of filteredCategories) {
    if (cat.category in categoryCounts) {
      categoryCounts[cat.category]++
    } else {
      categoryCounts['other']++
    }
  }

  const topicCounts: Record<string, number> = {}
  for (const cat of filteredCategories) {
    if (!cat.topic) continue
    topicCounts[cat.topic] = (topicCounts[cat.topic] || 0) + 1
  }

  const sortedTopics = Object.entries(topicCounts)
    .filter(([, count]) => count > 1 || Object.keys(topicCounts).length <= 15)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)

  const postMap = new Map(postList.map(p => [p.id, p]))

  const purchaseIntents = filteredComments
    .filter(c => categoriesByCommentId.get(c.id)?.category === 'purchase_intent')
    .slice(0, 10)

  const OFFTOPIC_KEYWORDS = ['political', 'government', 'economic_reality', 'election']

  function isOffTopic(comment: typeof filteredComments[number]): boolean {
    const category = categoriesByCommentId.get(comment.id)
    const topic = category?.topic || ''
    const lowered = topic.toLowerCase()
    return OFFTOPIC_KEYWORDS.some(keyword => lowered.includes(keyword))
  }

  const allComplaints = filteredComments
    .filter(c => categoriesByCommentId.get(c.id)?.category === 'complaint')

  const complaints = allComplaints.filter(c => !isOffTopic(c)).slice(0, 10)
  const hiddenComplaintsCount = allComplaints.filter(c => isOffTopic(c)).length

  const maxCategoryCount = Math.max(...Object.values(categoryCounts), 1)

  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

  function formatHour(hour: number): string {
    const period = hour < 12 ? 'AM' : 'PM'
    const displayHour = hour % 12 === 0 ? 12 : hour % 12
    return `${displayHour} ${period}`
  }

  // Groups comment posted_at timestamps by day-of-week + hour-of-day (UTC, since
  // posted_at comes from the YouTube API as UTC and there's no per-creator timezone
  // preference stored anywhere) to find when this audience is most active.
  const activityBuckets = new Map<string, number>()
  for (const comment of filteredComments) {
    const date = new Date(comment.posted_at)
    if (isNaN(date.getTime())) continue
    const key = `${date.getUTCDay()}-${date.getUTCHours()}`
    activityBuckets.set(key, (activityBuckets.get(key) || 0) + 1)
  }

  const bestTimes = Array.from(activityBuckets.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, count]) => {
      const [day, hour] = key.split('-').map(Number)
      return {
        day,
        hour,
        count,
        percentage: totalComments > 0 ? (count / totalComments) * 100 : 0,
      }
    })

  return (
    <div>
      <PageHeader title="Audience Brain" backHref="/dashboard/inbox" backLabel="My Videos" />
      <AskAudience creatorId={creator.id} postId={selectedPostId} />

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <section className="card">
          <h2 className="mb-4 font-display text-lg font-semibold text-text-primary">Top Topics</h2>
          {sortedTopics.length === 0 ? (
            <p className="text-sm text-text-muted">No topics yet. Categorize comments to see patterns.</p>
          ) : (
            <ol className="space-y-2">
              {sortedTopics.map(([topic, count], index) => (
                <li key={topic} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-xs text-text-muted">{index + 1}.</span>
                    <span className="font-body font-medium text-text-primary">{topic.replace(/_/g, ' ')}</span>
                  </span>
                  <span className="text-text-muted">{count} mentions</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="card">
          <h2 className="mb-4 font-display text-lg font-semibold text-text-primary">Category Breakdown</h2>
          {totalComments === 0 ? (
            <p className="text-sm text-text-muted">No comments yet.</p>
          ) : (
            <div className="space-y-3">
              {CATEGORIES.map(cat => {
                const count = categoryCounts[cat] || 0
                const percentage = totalComments > 0 ? (count / totalComments) * 100 : 0

                return (
                  <div key={cat} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-body capitalize text-text-primary">{cat.replace(/_/g, ' ')}</span>
                      <span className="text-text-muted">{count}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-surface-hover">
                      <div
                        className="h-full rounded-full bg-cobalt transition-all"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>

      <section className="card mt-8">
        <h2 className="mb-4 font-display text-lg font-semibold text-text-primary">Best Time to Post</h2>
        {totalComments < 5 ? (
          <p className="text-sm text-text-muted">Not enough comment data yet to find a reliable pattern.</p>
        ) : (
          <div className="space-y-4">
            <div>
              <p className="text-sm text-text-primary">
                Your audience is most active on{' '}
                <span className="font-body font-medium">{DAY_NAMES[bestTimes[0].day]}</span> around{' '}
                <span className="font-body font-medium">{formatHour(bestTimes[0].hour)} UTC</span>.
              </p>
              <p className="mt-1 text-xs text-text-muted">
                {bestTimes[0].percentage.toFixed(0)}% of engagement happens in this window.
              </p>
            </div>

            {bestTimes.length > 1 && (
              <ol className="space-y-2 border-t border-white/10 pt-3">
                {bestTimes.map((slot, index) => (
                  <li key={`${slot.day}-${slot.hour}`} className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-xs text-text-muted">{index + 1}.</span>
                      <span className="font-body text-text-primary">
                        {DAY_NAMES[slot.day]}, {formatHour(slot.hour)} UTC
                      </span>
                    </span>
                    <span className="text-text-muted">{slot.percentage.toFixed(0)}%</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </section>

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-2">
        <section className="card">
          <h2 className="mb-4 font-display text-lg font-semibold text-text-primary">Needs Attention — Purchase Intent</h2>
          {purchaseIntents.length === 0 ? (
            <p className="text-sm text-text-muted">No purchase intent comments yet.</p>
          ) : (
            <ul className="space-y-3">
              {purchaseIntents.map(comment => {
                const category = categoriesByCommentId.get(comment.id)
                const post = postMap.get(comment.post_id)

                return (
                  <li key={comment.id} className="card !bg-pink-dim/50">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1">
                        <p className="text-sm font-body font-medium text-text-primary">
                          {(comment.audience_members as { display_name: string } | null)?.display_name || 'Unknown'}
                        </p>
                        <p className="mt-1 text-sm text-text-primary">
                          <span className="highlight">{comment.text}</span>
                        </p>
                        {post && (
                          <Link
                            href={`/dashboard/inbox/${post.id}`}
                            className="mt-2 inline-block text-xs text-text-muted underline hover:text-text-primary"
                          >
                            View in inbox →
                          </Link>
                        )}
                      </div>
                      {category && (
                        <span className={`badge badge-${category.category}`}>
                          {category.category.replace(/_/g, ' ')}
                        </span>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="card">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold text-text-primary">Needs Attention — Complaints</h2>
            {hiddenComplaintsCount > 0 && (
              <span className="text-xs text-text-muted">
                {hiddenComplaintsCount} off-topic comment{hiddenComplaintsCount === 1 ? '' : 's'} hidden
              </span>
            )}
          </div>
          {complaints.length === 0 && allComplaints.length === 0 ? (
            <p className="text-sm text-text-muted">No complaints yet.</p>
          ) : complaints.length === 0 ? (
            <p className="text-sm text-text-muted">No relevant complaints to show.</p>
          ) : (
            <ul className="space-y-3">
              {complaints.map(comment => {
                const category = categoriesByCommentId.get(comment.id)
                const post = postMap.get(comment.post_id)

                return (
                  <li key={comment.id} className="card !bg-pink-dim/50">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1">
                        <p className="text-sm font-body font-medium text-text-primary">
                          {(comment.audience_members as { display_name: string } | null)?.display_name || 'Unknown'}
                        </p>
                        <p className="mt-1 text-sm text-text-primary">
                          <span className="highlight">{comment.text}</span>
                        </p>
                        {post && (
                          <Link
                            href={`/dashboard/inbox/${post.id}`}
                            className="mt-2 inline-block text-xs text-text-muted underline hover:text-text-primary"
                          >
                            View in inbox →
                          </Link>
                        )}
                      </div>
                      {category && (
                        <span className={`badge badge-${category.category}`}>
                          {category.category.replace(/_/g, ' ')}
                        </span>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
