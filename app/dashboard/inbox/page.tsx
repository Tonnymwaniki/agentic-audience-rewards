import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { fetchInBatches } from '@/lib/supabase-helpers'
import PageHeader from '@/components/PageHeader'
import PasteVideoLink from './PasteVideoLink'

export const dynamic = 'force-dynamic'

export default async function InboxPage() {
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
    .select('id, title, ingested_at, thumbnail_url')
    .eq('creator_id', creator.id)
    .order('ingested_at', { ascending: false })

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

  console.log("MY VIDEOS DEBUG - total posts:", postList.length, "postIds:", postIds)

  const { data: trackedRows, error: trackedError } = await supabase
    .from('tracked_videos')
    .select('post_id, polling_enabled')
    .eq('creator_id', creator.id)

  if (trackedError) {
    console.error('Tracked videos fetch error:', JSON.stringify(trackedError, Object.getOwnPropertyNames(trackedError), 2))
  }

  const trackedPostIds = new Set(
    (trackedRows || []).filter(t => t.polling_enabled).map(t => t.post_id)
  )

  let totalCounts: Record<string, number> = {}
  let categorizedCounts: Record<string, number> = {}

  if (postIds.length > 0) {
    const allCommentRows: Array<{ id: string; post_id: string }> = []
    let offset = 0
    const batchSize = 1000
    let hasMore = true

    while (hasMore) {
      const { data: batch, error: commentsError } = await supabase
        .from('comments')
        .select('id, post_id')
        .in('post_id', postIds)
        .range(offset, offset + batchSize - 1)

      if (commentsError) {
        console.error('Comments paginated fetch error:', JSON.stringify(commentsError, Object.getOwnPropertyNames(commentsError), 2))
        break
      }

      if (batch && batch.length > 0) {
        allCommentRows.push(...batch)
        offset += batchSize
      }

      if (!batch || batch.length < batchSize) {
        hasMore = false
      }
    }

    const commentRows = allCommentRows

    console.log("MY VIDEOS DEBUG - total commentRows:", commentRows.length)

    const commentIds = commentRows.map(c => c.id)

    for (const row of commentRows) {
      totalCounts[row.post_id] = (totalCounts[row.post_id] || 0) + 1
    }

    const debugPostIds = ['ba59207a-99a6-4e5c-b155-60de5da84e92', 'ddd5fe06-5fc8-49e6-8588-6b444ce4dcf3']
    for (const postId of debugPostIds) {
      const commentCount = commentRows.filter(c => c.post_id === postId).length
      console.log("MY VIDEOS DEBUG - post:", postId, "commentCount query result:", commentCount)
    }

    if (commentIds.length > 0) {
      const categoryRows = await fetchInBatches<{ comment_id: string }>(supabase, {
        table: 'comment_categories',
        select: 'comment_id',
        inColumn: 'comment_id',
        inValues: commentIds,
      })

      const categorizedIds = new Set((categoryRows || []).map(c => c.comment_id))

      console.log('Inbox debug - commentIds sample:', commentIds.slice(0, 5))
      console.log('Inbox debug - categoryRows sample:', categoryRows?.slice(0, 5))
      console.log('Inbox debug - categorizedIds set size:', categorizedIds.size)
      console.log('Inbox debug - matches:', commentIds.filter(id => categorizedIds.has(id)).length)

      for (const row of commentRows || []) {
        if (categorizedIds.has(row.id)) {
          categorizedCounts[row.post_id] = (categorizedCounts[row.post_id] || 0) + 1
        }
      }
    }
  }

  return (
    <div>
      <PageHeader title="My Videos" />
      <PasteVideoLink creatorId={creator.id} />

      {postList.length === 0 ? (
        <div className="card p-6 text-center">
          <p className="text-sm text-text-muted">No videos yet. Connect a channel to get started.</p>
          <Link href="/dashboard/connect" className="btn-primary mt-4 inline-flex">
            Connect a channel
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {postList.map(post => {
            const total = totalCounts[post.id] || 0
            const categorized = categorizedCounts[post.id] || 0
            const isTracked = trackedPostIds.has(post.id)

            return (
              <Link
                key={post.id}
                href={`/dashboard/inbox/${post.id}`}
                className="card block overflow-hidden transition-all duration-200 hover:bg-surface-hover hover:scale-[1.01]"
              >
                <div className="aspect-video w-full overflow-hidden rounded-t-lg bg-surface-hover">
                  {post.thumbnail_url ? (
                    <img
                      src={post.thumbnail_url}
                      alt={post.title}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.5}
                        className="h-10 w-10 text-text-muted"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M15.75 10.5l4.72-2.36a.75.75 0 0 1 1.08.67v8.38a.75.75 0 0 1-1.08.67l-4.72-2.36M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-7.5A2.25 2.25 0 0 0 13.5 6.75h-9A2.25 2.25 0 0 0 2.25 9v7.5a2.25 2.25 0 0 0 2.25 2.25Z"
                        />
                      </svg>
                    </div>
                  )}
                </div>
                <div className="p-4">
                  <h2 className="truncate font-body font-medium text-text-primary">{post.title}</h2>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <p className="text-xs text-text-muted">
                      {total > 0 ? `${categorized}/${total} categorized` : '0 comments'}
                    </p>
                    {isTracked && (
                      <span className="inline-flex flex-shrink-0 items-center rounded-full border border-cobalt/40 bg-cobalt/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-cobalt">
                        Tracked
                      </span>
                    )}
                  </div>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
