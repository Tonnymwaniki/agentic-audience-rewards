/**
 * Engagement rate for a single video: (comments + likes) / views, as a percentage.
 *
 * One implementation, shared by the My Videos card, the video detail page and the
 * Research agent, so the three can never quote different numbers for one video.
 *
 * What it is NOT: "unique engagers". Likes are not individually identifiable
 * through the API, so a viewer who both likes and comments counts twice, and a
 * viewer who comments five times counts five times. It is the standard public
 * ratio, and it is labelled as such rather than as a count of people.
 *
 * Inputs are YouTube's own public totals where we have them — commentCount from
 * statistics, not the rows we ingested — because our ingest includes replies and
 * is capped, and a rate built on our copy would silently diverge from the number
 * a creator sees in YouTube Studio.
 */

export type EngagementInput = {
  viewCount: number | null | undefined
  likeCount: number | null | undefined
  /** YouTube's statistics.commentCount — preferred. */
  youtubeCommentCount?: number | null
  /** Comments we ingested — fallback only, and flagged when used. */
  ingestedCommentCount?: number | null
}

export type Engagement = {
  /** Percentage, e.g. 0.16 for 0.16%. Null when it cannot be computed honestly. */
  rate: number | null
  comments: number
  likes: number | null
  views: number | null
  /** Likes are hidden on this video, so the rate counts comments only. */
  likesHidden: boolean
  /** The comment figure is our ingested count, not YouTube's public one. */
  commentsFromIngest: boolean
  /** Why rate is null, when it is. */
  unavailableReason: 'no_views' | null
}

export function computeEngagement(input: EngagementInput): Engagement {
  const views = typeof input.viewCount === 'number' ? input.viewCount : null
  const likes = typeof input.likeCount === 'number' ? input.likeCount : null

  const useYoutube = typeof input.youtubeCommentCount === 'number'
  const comments = useYoutube
    ? (input.youtubeCommentCount as number)
    : typeof input.ingestedCommentCount === 'number'
      ? input.ingestedCommentCount
      : 0

  const base = {
    comments,
    likes,
    views,
    likesHidden: likes === null,
    commentsFromIngest: !useYoutube,
  }

  // No views (or views not published): a ratio over zero is undefined, and quietly
  // returning 0% would read as "nobody engaged", which is a different claim.
  if (!views || views <= 0) {
    return { ...base, rate: null, unavailableReason: 'no_views' }
  }

  const numerator = comments + (likes ?? 0)
  return { ...base, rate: (numerator / views) * 100, unavailableReason: null }
}

/**
 * "0.16%", "2.4%", "<0.01%". Two decimals below 1% because that is where YouTube
 * rates live and "0.2%" vs "0.16%" is a real difference; one decimal above.
 */
export function formatEngagementRate(rate: number | null): string | null {
  if (rate === null || !Number.isFinite(rate)) return null
  if (rate > 0 && rate < 0.01) return '<0.01%'
  if (rate < 1) return `${rate.toFixed(2)}%`
  return `${rate.toFixed(1)}%`
}

/** The one-line label shown on a card: "0.16% engagement" plus any caveat. */
export function engagementLabel(e: Engagement): string | null {
  const formatted = formatEngagementRate(e.rate)
  if (!formatted) return null
  return e.likesHidden ? `${formatted} engagement (comments only — likes hidden)` : `${formatted} engagement`
}

/**
 * A plain-language sentence for the Research agent, so it cites the metric with
 * its definition attached instead of inventing a gloss.
 */
export function engagementFact(e: Engagement, title?: string | null): string {
  const subject = title ? `"${title}"` : 'This video'
  if (e.rate === null) {
    return `${subject}: engagement rate unavailable — YouTube does not report a view count for it.`
  }
  const parts = [
    `${subject} has a ${formatEngagementRate(e.rate)} engagement rate`,
    `(${e.comments.toLocaleString()} comments${e.likes !== null ? ` + ${e.likes.toLocaleString()} likes` : ''} over ${e.views!.toLocaleString()} views)`,
  ]
  const caveats: string[] = []
  if (e.likesHidden) caveats.push('likes are hidden on this video, so only comments are counted')
  if (e.commentsFromIngest) caveats.push("the comment figure is what was ingested, not YouTube's public total")
  return `${parts.join(' ')}.${caveats.length ? ` Note: ${caveats.join('; ')}.` : ''} This is (comments + likes) ÷ views, not a count of unique people.`
}

type PostStatsRow = {
  id: string
  view_count: number | null
  like_count: number | null
  comments_total: number | null
  youtube_comment_count?: number | null
}

/** Set false once the database rejects posts.youtube_comment_count (migration 37). */
let youtubeCommentColumnAvailable = true

/**
 * Loads the stats engagement needs for a set of posts, keyed by post id.
 *
 * Degrades rather than fails when posts.youtube_comment_count does not exist yet:
 * the rate then falls back to the ingested comment count and says so via
 * `commentsFromIngest`, instead of every caller breaking on a missing column.
 */
export async function loadPostEngagement(
  supabase: { from: (table: string) => any },
  postIds: string[]
): Promise<Map<string, Engagement>> {
  const out = new Map<string, Engagement>()
  if (postIds.length === 0) return out

  const run = (cols: string) =>
    supabase.from('posts').select(cols).in('id', postIds) as Promise<{
      data: PostStatsRow[] | null
      error: { code?: string } | null
    }>

  let { data, error } = await run(
    youtubeCommentColumnAvailable
      ? 'id, view_count, like_count, comments_total, youtube_comment_count'
      : 'id, view_count, like_count, comments_total'
  )
  if (error && (error.code === 'PGRST204' || error.code === '42703')) {
    youtubeCommentColumnAvailable = false
    ;({ data, error } = await run('id, view_count, like_count, comments_total'))
  }
  if (error || !data) return out

  for (const row of data) {
    out.set(
      row.id,
      computeEngagement({
        viewCount: row.view_count,
        likeCount: row.like_count,
        youtubeCommentCount: row.youtube_comment_count ?? null,
        ingestedCommentCount: row.comments_total,
      })
    )
  }
  return out
}
