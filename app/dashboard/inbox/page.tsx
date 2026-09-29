import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { fetchInBatches } from '@/lib/supabase-helpers'
import PageHeader from '@/components/PageHeader'
import PasteVideoLink from './PasteVideoLink'
import VideoGrid from './VideoGrid'
import { logError } from '@/lib/logger'
import { getChannelVerificationSummary, type ChannelSummary } from '@/lib/channel-verification'
import ChannelVerificationBanner from './ChannelVerificationBanner'
import { engagementLabel, formatEngagementRate, loadPostEngagement } from '@/lib/engagement'

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
    logError('page.inbox', creatorError, { user_id: user.id, stage: 'fetch_creator' })
    return (
      <div>
        <p className="text-red-500">Failed to load your account details.</p>
      </div>
    )
  }

  if (!creator) {
    redirect('/login')
  }

  // channel_title (migration 51) may not exist yet on every database this code
  // runs against — same self-healing pattern as the write side (ingest.ts,
  // channel-videos.ts): probe for it and fall back to the older column list
  // rather than breaking the whole page over a missing label.
  const isMissingColumnError = (error: { code?: string; message?: string } | null, column: string) =>
    !!error && (error.code === 'PGRST204' || error.code === '42703') && (error.message ?? '').includes(column)

  type PostRow = {
    id: string
    title: string | null
    ingested_at: string | null
    thumbnail_url: string | null
    external_post_id: string | null
    duration_seconds: number | null
    view_count: number | null
    channel_id: string | null
    channel_title: string | null
  }

  const POSTS_COLUMNS = 'id, title, ingested_at, thumbnail_url, external_post_id, duration_seconds, view_count, channel_id'

  let posts: PostRow[] | null = null
  let postsError: { code?: string; message?: string } | null = null

  {
    const first = await supabase
      .from('posts')
      .select(`${POSTS_COLUMNS}, channel_title`)
      .eq('creator_id', creator.id)
      .order('ingested_at', { ascending: false })
    posts = first.data as unknown as PostRow[] | null
    postsError = first.error

    if (postsError && isMissingColumnError(postsError, 'channel_title')) {
      const fallback = await supabase
        .from('posts')
        .select(POSTS_COLUMNS)
        .eq('creator_id', creator.id)
        .order('ingested_at', { ascending: false })
      // channel_title wasn't selected here — every row gets it back as null below.
      posts = (fallback.data as unknown as Omit<PostRow, 'channel_title'>[] | null)?.map(p => ({
        ...p,
        channel_title: null,
      })) ?? null
      postsError = fallback.error
    }
  }

  if (postsError) {
    logError('page.inbox', postsError, { creator_id: creator.id, stage: 'fetch_posts' })
    return (
      <div>
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
    channel_id: string | null
    channel_title: string | null
  }> = []

  type ChannelVideoRow = {
    video_id: string
    title: string | null
    thumbnail_url: string | null
    published_at: string | null
    post_id: string | null
    channel_id: string | null
    channel_title: string | null
  }

  {
    const pageSize = 1000
    let from = 0
    const BASE_COLUMNS = 'video_id, title, thumbnail_url, published_at, post_id'
    const FULL_COLUMNS = `${BASE_COLUMNS}, channel_id, channel_title`
    // Resolved on the first page and reused after: channel_id/channel_title
    // (migration 51) either exist on this database or they don't.
    let hasChannelColumns = true

    for (;;) {
      const res = await supabase
        .from('channel_videos')
        .select(hasChannelColumns ? FULL_COLUMNS : BASE_COLUMNS)
        .eq('creator_id', creator.id)
        .order('published_at', { ascending: false })
        .range(from, from + pageSize - 1)

      let page = res.data as unknown as Partial<ChannelVideoRow>[] | null
      let channelVideosError = res.error

      if (channelVideosError && hasChannelColumns && isMissingColumnError(channelVideosError, 'channel_id')) {
        hasChannelColumns = false
        const retry = await supabase
          .from('channel_videos')
          .select(BASE_COLUMNS)
          .eq('creator_id', creator.id)
          .order('published_at', { ascending: false })
          .range(from, from + pageSize - 1)
        page = retry.data as unknown as Partial<ChannelVideoRow>[] | null
        channelVideosError = retry.error
      }

      if (channelVideosError) {
        logError('page.inbox', channelVideosError, { creator_id: creator.id, stage: 'fetch_channel_videos' })
        break
      }

      if (!page || page.length === 0) break
      channelVideos.push(
        ...page.map(v => ({
          video_id: v.video_id!,
          title: v.title ?? null,
          thumbnail_url: v.thumbnail_url ?? null,
          published_at: v.published_at ?? null,
          post_id: v.post_id ?? null,
          channel_id: v.channel_id ?? null,
          channel_title: v.channel_title ?? null,
        }))
      )
      if (page.length < pageSize) break
      from += pageSize
    }
  }


  const { data: trackedRows, error: trackedError } = await supabase
    .from('tracked_videos')
    .select('post_id, polling_enabled')
    .eq('creator_id', creator.id)

  if (trackedError) {
    logError('page.inbox', trackedError, { creator_id: creator.id, stage: 'fetch_tracked_videos' })
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
        logError('page.inbox', commentsError, { creator_id: creator.id, stage: 'fetch_comments' })
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
  // One batched read for every analyzed card, via the same helper Research uses,
  // so the card and the agent can never quote different rates for one video.
  const engagementByPost = await loadPostEngagement(supabase, postList.map(p => p.id))

  const analyzedCards = postList.map(post => ({
    id: post.id,
    postId: post.id,
    videoId: null,
    title: post.title || 'Untitled video',
    sortedAt: post.ingested_at,
    durationSeconds: (post.duration_seconds as number | null) ?? null,
    viewCount: (post.view_count as number | null) ?? null,
    engagement: (() => {
      const e = engagementByPost.get(post.id)
      const rate = e ? formatEngagementRate(e.rate) : null
      return e && rate ? { rate, likesHidden: e.likesHidden, full: engagementLabel(e) ?? rate } : null
    })(),
    thumbnailUrl: post.thumbnail_url,
    total: totalCounts[post.id] || 0,
    categorized: categorizedCounts[post.id] || 0,
    isTracked: trackedPostIds.has(post.id),
    analyzed: true,
    channelId: (post.channel_id as string | null) ?? null,
    channelTitle: (post.channel_title as string | null) ?? null,
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
      // channel_videos is metadata only — duration and views arrive with analysis.
      durationSeconds: null,
      viewCount: null,
      thumbnailUrl: v.thumbnail_url,
      total: 0,
      categorized: 0,
      isTracked: false,
      analyzed: false,
      channelId: v.channel_id,
      channelTitle: v.channel_title,
    }))

  const allCards = [...analyzedCards, ...unanalyzedCards]

  // Per-channel ownership status. Never throws the page: a failure here means the
  // banner is absent, not that My Videos is unavailable.
  let channelSummary: ChannelSummary[] = []
  //
  // Service client, not the cookie client: the summary reads youtube_oauth_tokens,
  // which has RLS enabled and no policies. Under the signed-in user's session that
  // read returns zero rows WITHOUT an error, so every channel — including ones the
  // creator genuinely verified — was shown as unverified. Safe to bypass RLS here
  // because creator.id was derived from the session above, never from the request.
  try {
    channelSummary = await getChannelVerificationSummary(createServiceClient(), creator.id)
  } catch (summaryError) {
    logError('page.inbox', summaryError, { creator_id: creator.id, stage: 'channel_verification_summary' })
  }

  return (
    <div>
      <PageHeader title="My Videos" />
      <PasteVideoLink creatorId={creator.id} />
      <ChannelVerificationBanner channels={channelSummary} />

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
