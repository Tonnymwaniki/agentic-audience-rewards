import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { fetchInBatches } from '@/lib/supabase-helpers'
import PageHeader from '@/components/PageHeader'
import PasteVideoLink from './PasteVideoLink'
import VideoGrid from './VideoGrid'

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
    .maybeSingle()

  if (creatorError) {
    console.error('My Videos creator fetch error:', JSON.stringify(creatorError, Object.getOwnPropertyNames(creatorError), 2))
    return (
      <div className="p-6">
        <p className="text-red-500">Failed to load your account details.</p>
      </div>
    )
  }

  if (!creator) {
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

  const totalCounts: Record<string, number> = {}
  const categorizedCounts: Record<string, number> = {}

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


    const commentIds = commentRows.map(c => c.id)

    for (const row of commentRows) {
      totalCounts[row.post_id] = (totalCounts[row.post_id] || 0) + 1
    }


    if (commentIds.length > 0) {
      const categoryRows = await fetchInBatches<{ comment_id: string }>(supabase, {
        table: 'comment_categories',
        select: 'comment_id',
        inColumn: 'comment_id',
        inValues: commentIds,
      })

      const categorizedIds = new Set((categoryRows || []).map(c => c.comment_id))


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
        // Sorting and searching happen client-side in VideoGrid over this same list —
        // no extra query, and no round trip on every keystroke.
        <VideoGrid
          videos={postList.map(post => ({
            id: post.id,
            title: post.title,
            ingestedAt: post.ingested_at,
            thumbnailUrl: post.thumbnail_url,
            total: totalCounts[post.id] || 0,
            categorized: categorizedCounts[post.id] || 0,
            isTracked: trackedPostIds.has(post.id),
          }))}
        />
      )}
    </div>
  )
}
