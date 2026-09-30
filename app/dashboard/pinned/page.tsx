import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import PageHeader from '@/components/PageHeader'
import { logError } from '@/lib/logger'
import { resolveVerifiedPostIds } from '@/lib/channel-verification'
import PinnedCommentsList, { type PinnedItem } from './PinnedCommentsList'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Pinned Comments · Notice' }

type PostRow = {
  id: string
  title: string | null
  channel_id: string | null
  pinned_comment_id: string
  pinned_comment_confirmed: boolean
}

type CommentRow = {
  id: string
  text: string
  posted_at: string
  post_id: string
  owner_replied_at: string | null
  owner_reply_comment_id: string | null
  audience_members: { display_name: string; external_id: string | null } | null
}

type CategoryInfo = {
  comment_id: string
  category: string | null
  draft_reply: string | null
  final_reply_text: string | null
  draft_reply_approved_at: string | null
  draft_confidence: string | null
  escalation_flag: string | null
  reply_send_status: string | null
  reply_auto_sent: boolean | null
}

/**
 * Quick-access page for pinned comments — the one comment on each video that
 * gets outsized visibility, surfaced with its reply directly underneath so a
 * creator doesn't have to hunt for it in the normal per-video comment list.
 *
 * YouTube's API has no "is this pinned" field (see migration 55's header), so
 * every entry here is either a best-effort guess made at ingest time, or one the
 * creator has explicitly confirmed/corrected. The distinction is always shown —
 * never silently treated as certain.
 */
export default async function PinnedCommentsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const { data: creator, error: creatorError } = await supabase
    .from('creators')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (creatorError) {
    logError('page.pinned', creatorError, { user_id: user.id, stage: 'fetch_creator' })
    return (
      <div>
        <p className="text-red-500">Failed to load your account details.</p>
      </div>
    )
  }
  if (!creator) redirect('/login')

  const service = createServiceClient()

  const { data: postRows, error: postsError } = await service
    .from('posts')
    .select('id, title, channel_id, pinned_comment_id, pinned_comment_confirmed')
    .eq('creator_id', creator.id)
    .not('pinned_comment_id', 'is', null)

  // Migration 55 hasn't run yet on this database.
  if (postsError && (postsError.code === 'PGRST204' || postsError.code === '42703')) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Pinned Comments" backHref="/dashboard/notifications" backLabel="Notifications" />
        <p className="mt-4 text-sm text-text-muted">This feature needs a database migration that hasn&apos;t run yet.</p>
      </div>
    )
  }
  if (postsError) {
    logError('page.pinned', postsError, { creator_id: creator.id, stage: 'fetch_posts' })
    return (
      <div>
        <p className="text-red-500">Failed to load pinned comments</p>
      </div>
    )
  }

  const posts = (postRows ?? []) as PostRow[]

  if (posts.length === 0) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Pinned Comments" backHref="/dashboard/notifications" backLabel="Notifications" />
        <section className="card mt-4 text-center">
          <p className="font-display text-lg font-semibold text-text-primary">No pinned comments found yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">
            When a video is (re-)analyzed, Notice makes a best-effort guess at which comment is pinned. Since YouTube
            doesn&apos;t expose pinned status directly, this can take a fresh analysis to appear.
          </p>
        </section>
      </div>
    )
  }

  const pinnedCommentIds = posts.map(p => p.pinned_comment_id)

  const { data: commentRows, error: commentsError } = await service
    .from('comments')
    .select('id, text, posted_at, post_id, owner_replied_at, owner_reply_comment_id, audience_members ( display_name, external_id )')
    .in('id', pinnedCommentIds)

  if (commentsError) {
    logError('page.pinned', commentsError, { creator_id: creator.id, stage: 'fetch_comments' })
    return (
      <div>
        <p className="text-red-500">Failed to load pinned comments</p>
      </div>
    )
  }

  const comments = (commentRows ?? []) as unknown as CommentRow[]
  const commentById = new Map(comments.map(c => [c.id, c]))

  // The owner's own reply text, when one exists, fetched in one extra pass rather
  // than a per-row query.
  const ownerReplyIds = comments.map(c => c.owner_reply_comment_id).filter((id): id is string => Boolean(id))
  const ownerReplyTextById = new Map<string, string>()
  if (ownerReplyIds.length > 0) {
    const { data: ownerReplyRows } = await service.from('comments').select('id, text').in('id', ownerReplyIds)
    for (const row of ownerReplyRows ?? []) ownerReplyTextById.set(row.id as string, row.text as string)
  }

  // comment_categories.reply_auto_sent (migration 52) may not exist yet — same
  // self-healing pattern used on the Notifications page.
  let categoryColumns =
    'comment_id, category, draft_reply, final_reply_text, draft_reply_approved_at, draft_confidence, escalation_flag, reply_send_status, reply_auto_sent'
  let categoryRows: unknown[] | null = null
  for (;;) {
    const result = await service.from('comment_categories').select(categoryColumns).in('comment_id', pinnedCommentIds)
    categoryRows = result.data
    if (!result.error || !((result.error.code === 'PGRST204' || result.error.code === '42703') && (result.error.message ?? '').includes('reply_auto_sent'))) break
    categoryColumns = categoryColumns.replace(', reply_auto_sent', '')
  }
  const categoryById = new Map(((categoryRows ?? []) as unknown as CategoryInfo[]).map(c => [c.comment_id, c]))

  const postIds = posts.map(p => p.id)
  const actionablePostIds = await resolveVerifiedPostIds(service, creator.id, postIds)

  const items: PinnedItem[] = posts
    .map(post => {
      const comment = commentById.get(post.pinned_comment_id)
      if (!comment) return null
      const info = categoryById.get(comment.id) ?? null
      const approved = Boolean(info?.draft_reply_approved_at)
      const pendingDraft = !approved && Boolean(info?.draft_reply)
      const draftLocked = pendingDraft && !actionablePostIds.has(post.id)
      const isSelfPin = Boolean(comment.audience_members?.external_id && post.channel_id && comment.audience_members.external_id === post.channel_id)
      const ownerReplyText = comment.owner_reply_comment_id ? ownerReplyTextById.get(comment.owner_reply_comment_id) ?? null : null

      return {
        postId: post.id,
        videoTitle: post.title || 'Untitled video',
        pinnedConfirmed: post.pinned_comment_confirmed,
        comment: {
          id: comment.id,
          text: comment.text,
          postedAt: comment.posted_at,
          authorName: comment.audience_members?.display_name || 'Unknown',
          isSelfPin,
          category: info?.category ?? null,
          draftReply: approved || draftLocked ? null : info?.draft_reply ?? null,
          finalReplyText: info?.final_reply_text ?? null,
          approved,
          draftLocked,
          replySendStatus: info?.reply_send_status ?? null,
          replyAutoSent: info?.reply_auto_sent ?? false,
          ownerAlreadyReplied: Boolean(comment.owner_replied_at),
          ownerReplyText,
        },
      } satisfies PinnedItem
    })
    .filter((item): item is PinnedItem => item !== null)
    // Unanswered, non-self-pinned comments first — those are the ones actually
    // waiting on the creator; a self-pinned announcement or an already-answered
    // comment is reference, not a to-do.
    .sort((a, b) => {
      const score = (i: PinnedItem) => (i.comment.isSelfPin || i.comment.approved || i.comment.ownerAlreadyReplied ? 1 : 0)
      return score(a) - score(b)
    })

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Pinned Comments" backHref="/dashboard/notifications" backLabel="Notifications" />
      <p className="mt-1 mb-5 text-sm text-text-muted">
        The one comment YouTube gives the most visibility on each video, with its reply right below it. YouTube
        doesn&apos;t tell us which comment is pinned, so unconfirmed guesses are marked — confirm or clear them below.
      </p>
      <PinnedCommentsList items={items} />
    </div>
  )
}
