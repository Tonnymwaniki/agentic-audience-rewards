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
    .select('id, title, ingested_at, thumbnail_url, external_post_id')
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

  // Every video the channel sync found, analyzed or not. Paged explicitly: a
  // connected channel can hold well over the 1000 rows a single Supabase response
  // returns, and silently showing the first 1000 would look like missing videos.
  const channelVideos: Array<{
    video_id: string
    title: string | null
    thumbnail_url: string | null
    published_at: string | null
    post_id: string | null
  }> = []

  {
    const pageSize = 1000
    let from = 0

    for (;;) {
      const { data: page, error: channelVideosError } = await supabase
        .from('channel_videos')
        .select('video_id, title, thumbnail_url, published_at, post_id')
        .eq('creator_id', creator.id)
        .order('published_at', { ascending: false })
        .range(from, from + pageSize - 1)

      if (channelVideosError) {
        console.error('Channel videos fetch error:', JSON.stringify(channelVideosError, Object.getOwnPropertyNames(channelVideosError), 2))
        break
      }

      if (!page || page.length === 0) break
      channelVideos.push(...page)
      if (page.length < pageSize) break
      from += pageSize
    }
  }


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

  // An analyzed video is shown from its post row, which is the one that carries the
  // comment counts. Videos the sync found but nobody has analyzed yet are shown from
  // their channel_videos row, dimmed, with an Analyze button.
  const analyzedCards = postList.map(post => ({
    id: post.id,
    postId: post.id,
    videoId: null,
    title: post.title,
    sortedAt: post.ingested_at,
    thumbnailUrl: post.thumbnail_url,
    total: totalCounts[post.id] || 0,
    categorized: categorizedCounts[post.id] || 0,
    isTracked: trackedPostIds.has(post.id),
    analyzed: true,
  }))

  // post_id is the authoritative link, but a video analyzed before the
  // channel_videos table existed can have a post without the link being set, so
  // external_post_id is checked too — otherwise it would appear twice, once clear
  // and once blurred.
  const analyzedVideoIds = new Set(postList.map(p => p.external_post_id).filter(Boolean))

  const unanalyzedCards = channelVideos
    .filter(v => !v.post_id && !analyzedVideoIds.has(v.video_id))
    .map(v => ({
      id: `yt:${v.video_id}`,
      postId: null,
      videoId: v.video_id,
      title: v.title || 'Untitled video',
      sortedAt: v.published_at,
      thumbnailUrl: v.thumbnail_url,
      total: 0,
      categorized: 0,
      isTracked: false,
      analyzed: false,
    }))

  const allCards = [...analyzedCards, ...unanalyzedCards]

  return (
    <div>
      <PageHeader title="My Videos" />
      <PasteVideoLink creatorId={creator.id} />

      {allCards.length === 0 ? (
        <div className="card p-6 text-center">
          <p className="text-sm text-text-muted">No videos yet. Connect a channel to get started.</p>
          <Link href="/dashboard/connect" className="btn-primary mt-4 inline-flex">
            Connect a channel
          </Link>
        </div>
      ) : (
        // Sorting and searching happen client-side in VideoGrid over this same list —
        // no extra query, and no round trip on every keystroke.
        <VideoGrid creatorId={creator.id} videos={allCards} />
      )}
    </div>
  )
}
