import { createServiceClient } from '@/lib/supabase/service'
import { fetchVideoMeta, fetchVideoComments, fetchCommentReplies, type FetchedComment, type FetchedReply } from '@/lib/youtube'
import { linkChannelVideoToPost } from '@/lib/channel-videos'
import { logError, logWarn, logInfo } from '@/lib/logger'

type SupabaseService = ReturnType<typeof createServiceClient>

type CommentRow = {
  post_id: string
  external_comment_id: string
  audience_member_id: string
  text: string
  posted_at: string
  like_count: number
  reply_count: number
  /** The stored id of the top-level comment this answers; null for top-level comments. */
  parent_comment_id: string | null
}

/**
 * Columns added by later migrations. Each flips to false the first time the database
 * rejects it as unknown, so a deploy that lands before its migration keeps ingesting
 * (without that column) instead of failing every comment.
 */
const optionalColumns: Record<'like_count' | 'reply_count' | 'parent_comment_id', boolean> = {
  like_count: true,
  reply_count: true,
  parent_comment_id: true,
}

/** Post columns added by migration 20240101000027, dropped until it has been run. */
const optionalPostColumns: Record<'duration_seconds' | 'youtube_category' | 'channel_id', boolean> = {
  duration_seconds: true,
  youtube_category: true,
  channel_id: true,
}

/** The column an "unknown column" error names, if it's one of the optional ones. */
function missingOptionalColumn(error: { code?: string; message?: string } | null): keyof typeof optionalColumns | null {
  if (!error || (error.code !== 'PGRST204' && error.code !== '42703')) return null
  return (Object.keys(optionalColumns) as Array<keyof typeof optionalColumns>).find(c => (error.message ?? '').includes(c)) ?? null
}

/**
 * Upserts one comment. Re-ingesting a video refreshes the like and reply counts of
 * comments already stored, because the upsert overwrites them.
 */
async function upsertComment(supabase: SupabaseService, row: CommentRow) {
  const attempt = () => {
    const values: Record<string, unknown> = { ...row }
    for (const [column, available] of Object.entries(optionalColumns)) {
      if (!available) delete values[column]
    }
    return supabase.from('comments').upsert(values, { onConflict: 'post_id, external_comment_id' }).select('id').single()
  }

  let result = await attempt()
  // One retry per missing column: at most three, and only on a fresh database.
  for (let i = 0; i < 3; i++) {
    const missing = missingOptionalColumn(result.error)
    if (!missing) break
    optionalColumns[missing] = false
    console.warn(`comments.${missing} does not exist yet; ingesting without it`)
    result = await attempt()
  }
  return result
}

/**
 * Whether replies can be stored at all. Without parent_comment_id (migration
 * 20240101000025) a reply would be indistinguishable from a top-level comment, so
 * replies are not fetched until the column exists — no orphan rows, and no wasted
 * YouTube quota.
 */
async function replyStorageAvailable(supabase: SupabaseService): Promise<boolean> {
  if (!optionalColumns.parent_comment_id) return false
  const { error } = await supabase.from('comments').select('parent_comment_id').limit(1)
  if (error && missingOptionalColumn(error) === 'parent_comment_id') {
    optionalColumns.parent_comment_id = false
    console.warn('comments.parent_comment_id does not exist yet (migration 20240101000025); skipping reply ingestion')
    return false
  }
  return true
}

/** Upserts the reply's author like any other commenter, then the reply itself. */
async function storeComment(
  supabase: SupabaseService,
  comment: FetchedComment | FetchedReply,
  args: { postId: string; platformId: string; creatorId: string; parentCommentId?: string | null }
): Promise<string | null> {
  const { data: member, error: memberError } = await supabase
    .from('audience_members')
    .upsert(
      {
        platform_id: args.platformId,
        external_id: comment.authorChannelId,
        display_name: comment.authorDisplayName,
        creator_id: args.creatorId,
      },
      { onConflict: 'platform_id, external_id, creator_id' }
    )
    .select('id')
    .single()

  if (memberError || !member) {
    logError('ingest.upsertMember', memberError, { creator_id: args.creatorId, platform_id: args.platformId, post_id: args.postId })
    return null
  }

  const { data, error } = await upsertComment(supabase, {
    post_id: args.postId,
    external_comment_id: comment.externalCommentId,
    audience_member_id: member.id,
    text: comment.text,
    posted_at: comment.publishedAt,
    like_count: comment.likeCount,
    reply_count: comment.replyCount,
    parent_comment_id: args.parentCommentId ?? null,
  })
  if (error || !data) {
    logError('ingest.upsertComment', error, { post_id: args.postId, creator_id: args.creatorId, audience_member_id: member.id })
    return null
  }
  return data.id as string
}

/**
 * Fetches and stores replies for the given top-level comments, threading each one to
 * its parent's stored id. Replies are ordinary `comments` rows — categorization,
 * embeddings, search, trending and rewards all read those rows and pick replies up
 * with no special-casing.
 *
 * `parentIdsByExternalId` maps YouTube's top-level comment id to the stored uuid.
 * Never throws: a video's top-level comments are worth keeping even if its replies
 * can't be read.
 */
async function ingestReplies(
  supabase: SupabaseService,
  parents: FetchedComment[],
  parentIdsByExternalId: Map<string, string>,
  args: { postId: string; platformId: string; creatorId: string; skipExternalIds?: Set<string> }
): Promise<{ stored: string[]; fetched: number; truncated: boolean }> {
  const fetchable = parents.filter(p => p.replyCount > 0 && parentIdsByExternalId.has(p.externalCommentId))
  if (fetchable.length === 0 || !(await replyStorageAvailable(supabase))) return { stored: [], fetched: 0, truncated: false }

  let fetched
  try {
    fetched = await fetchCommentReplies(fetchable)
  } catch (err) {
    logWarn('ingest.fetchReplies', 'Reply fetch failed; continuing without replies', { post_id: args.postId, creator_id: args.creatorId, fetchable: fetchable.length, reason: err instanceof Error ? err.message : String(err) })
    return { stored: [], fetched: 0, truncated: false }
  }

  const stored: string[] = []
  for (const reply of fetched.replies) {
    if (args.skipExternalIds?.has(reply.externalCommentId)) continue
    const parentCommentId = parentIdsByExternalId.get(reply.parentExternalId)
    if (!parentCommentId) continue
    const id = await storeComment(supabase, reply, { ...args, parentCommentId })
    if (id) stored.push(id)
  }
  logInfo('ingest.fetchReplies', 'Replies ingested', {
    post_id: args.postId,
    creator_id: args.creatorId,
    fetched: fetched.replies.length,
    threads_fetched: fetched.threadsFetched,
    threads_failed: fetched.threadsFailed,
    stored: stored.length,
    truncated: fetched.truncated,
  })
  return { stored, fetched: fetched.replies.length, truncated: fetched.truncated }
}

export async function ingestYouTubeVideo(creator_id: string, youtube_url: string) {
  const videoId = parseYouTubeVideoId(youtube_url)
  if (!videoId) {
    throw new Error('Invalid YouTube URL')
  }

  const [meta, comments] = await Promise.all([
    fetchVideoMeta(videoId),
    fetchVideoComments(videoId),
  ])

  const supabase = createServiceClient()

  const { data: platform, error: platformError } = await supabase
    .from('platforms')
    .select('id')
    .eq('name', 'youtube')
    .single()

  if (platformError || !platform) {
    throw new Error('YouTube platform not found in platforms table')
  }

  const postValues: Record<string, unknown> = {
    platform_id: platform.id,
    creator_id,
    external_post_id: videoId,
    title: meta.title,
    content: meta.description,
    thumbnail_url: meta.thumbnailUrl,
    // The video's real upload time. This was never written before, so every post
    // ingested prior to this had posted_at NULL and nothing could measure how long
    // after publication a comment arrived — see scripts/backfill-post-published-at.ts
    // for the repair of those rows.
    posted_at: meta.publishedAt,
    // Recorded at ingest so ownership gating is a local read. Optional-column
    // handling below drops it on a database without migration 36.
    channel_id: meta.channelId,
    // Refreshed on every re-ingest of the same video, since the upsert conflicts
    // on (platform_id, external_post_id) — so counts track the video over time
    // rather than freezing at whatever they were on first import.
    like_count: meta.likeCount,
    view_count: meta.viewCount,
    duration_seconds: meta.durationSeconds,
    youtube_category: meta.youtubeCategory,
  }

  const upsertPost = () => {
    const values = { ...postValues }
    for (const [column, available] of Object.entries(optionalPostColumns)) {
      if (!available) delete values[column]
    }
    return supabase.from('posts').upsert(values, { onConflict: 'platform_id, external_post_id' }).select('id').single()
  }

  let { data: post, error: postError } = await upsertPost()
  // One retry per missing column, only on a database without migration 27.
  for (let i = 0; i < 2 && postError; i++) {
    const missing = (Object.keys(optionalPostColumns) as Array<keyof typeof optionalPostColumns>).find(
      c => (postError!.code === 'PGRST204' || postError!.code === '42703') && (postError!.message ?? '').includes(c)
    )
    if (!missing) break
    optionalPostColumns[missing] = false
    console.warn(`posts.${missing} does not exist yet (migration 20240101000027); ingesting without it`)
    ;({ data: post, error: postError } = await upsertPost())
  }

  if (postError || !post) {
    throw new Error('Failed to upsert post')
  }

  const postId = post.id

  // Links the lightweight channel_videos entry to the real post. Placed here rather
  // than in the analyze route so EVERY ingestion path is covered — auto-analyze,
  // manual paste and the standalone ingest endpoint all funnel through this
  // function. Awaited but non-throwing: the ingestion has already succeeded.
  await linkChannelVideoToPost(supabase, creator_id, videoId, postId)

  let commentsIngested = 0
  const parentIds = new Map<string, string>()

  for (const comment of comments) {
    const id = await storeComment(supabase, comment, { postId, platformId: platform.id, creatorId: creator_id })
    if (!id) continue
    parentIds.set(comment.externalCommentId, id)
    commentsIngested++
  }

  // Replies are stored as ordinary comments on the same post, so everything
  // downstream treats them exactly like top-level comments.
  const replies = await ingestReplies(supabase, comments, parentIds, { postId, platformId: platform.id, creatorId: creator_id })
  commentsIngested += replies.stored.length

  return { success: true, postId, commentsIngested, repliesIngested: replies.stored.length }
}

// Used by the comment-polling cron: skips fetching video meta (the post already
// exists) and only inserts comments whose external_comment_id isn't already stored,
// so repeated 20-minute polls don't do wasted work re-upserting the entire thread.
export async function ingestNewComments(creator_id: string, post_id: string, videoId: string) {
  const supabase = createServiceClient()

  const { data: platform, error: platformError } = await supabase
    .from('platforms')
    .select('id')
    .eq('name', 'youtube')
    .single()

  if (platformError || !platform) {
    throw new Error('YouTube platform not found in platforms table')
  }

  const { data: existingComments, error: existingError } = await supabase
    .from('comments')
    .select('external_comment_id')
    .eq('post_id', post_id)

  if (existingError) {
    throw new Error('Failed to fetch existing comments')
  }

  const knownIds = new Set((existingComments || []).map(c => c.external_comment_id as string))

  const allComments = await fetchVideoComments(videoId)
  const newComments = allComments.filter(c => !knownIds.has(c.externalCommentId))

  let commentsIngested = 0
  const newCommentIds: string[] = []
  const parentIds = new Map<string, string>()

  for (const comment of newComments) {
    const id = await storeComment(supabase, comment, { postId: post_id, platformId: platform.id, creatorId: creator_id })
    if (!id) continue
    parentIds.set(comment.externalCommentId, id)
    commentsIngested++
    newCommentIds.push(id)
  }

  // New replies can arrive under comments stored long ago, so the parent map also
  // needs the ids of top-level comments already in the database.
  const knownParents = allComments.filter(c => c.replyCount > 0 && !parentIds.has(c.externalCommentId))
  if (knownParents.length > 0) {
    const { data: rows } = await supabase
      .from('comments')
      .select('id, external_comment_id')
      .eq('post_id', post_id)
      .in('external_comment_id', knownParents.map(c => c.externalCommentId))
    for (const row of rows ?? []) parentIds.set(row.external_comment_id as string, row.id as string)
  }

  // Skips replies already stored, so a poll only writes (and later categorizes) new ones.
  const replies = await ingestReplies(supabase, allComments, parentIds, {
    postId: post_id,
    platformId: platform.id,
    creatorId: creator_id,
    skipExternalIds: knownIds,
  })
  commentsIngested += replies.stored.length
  newCommentIds.push(...replies.stored)

  return { success: true, postId: post_id, commentsIngested, newCommentIds, repliesIngested: replies.stored.length }
}

function parseYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url)

    if (
      parsed.hostname === 'www.youtube.com' ||
      parsed.hostname === 'm.youtube.com'
    ) {
      return parsed.searchParams.get('v')
    }

    if (parsed.hostname === 'youtu.be') {
      return parsed.pathname.slice(1).split('/')[0] || null
    }

    return null
  } catch {
    return null
  }
}
