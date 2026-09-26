import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import PageHeader from '@/components/PageHeader'
import NotificationsList, { type InboxItem } from './NotificationsList'
import { logError } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'
import { resolveVerifiedPostIds } from '@/lib/channel-verification'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Notifications · Notice' }

/** One screenful and then some. The inbox is a work queue, not an archive. */
const PAGE_SIZE = 50

type CategoryInfo = {
  category: string
  draft_reply: string | null
  final_reply_text: string | null
  draft_reply_approved_at: string | null
  draft_confidence: string | null
  escalation_flag: string | null
}

type NotificationRow = {
  id: string
  type: string
  message: string
  read: boolean
  created_at: string
  comments: {
    id: string
    text: string
    posted_at: string
    post_id: string
    audience_members: { display_name: string } | null
    comment_categories: CategoryInfo | null
    posts: { title: string | null } | null
  } | null
}

export default async function NotificationsPage() {
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
    logError('page.notifications', creatorError, { user_id: user.id, stage: 'fetch_creator' })
    return (
      <div>
        <p className="text-red-500">Failed to load your account details.</p>
      </div>
    )
  }

  if (!creator) {
    redirect('/login')
  }

  // The draft text is joined through comment_id rather than copied onto the
  // notification, so an edited or regenerated reply shows its current wording here
  // instead of whatever it said when the notification was created.
  const { data: rows, error } = await supabase
    .from('notifications')
    .select(
      `
      id,
      type,
      message,
      read,
      created_at,
      comments (
        id,
        text,
        posted_at,
        post_id,
        audience_members ( display_name ),
        comment_categories ( category, draft_reply, final_reply_text, draft_reply_approved_at, draft_confidence, escalation_flag ),
        posts ( title )
      )
    `
    )
    .eq('creator_id', creator.id)
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE)

  if (error) {
    logError('page.notifications', error, { creator_id: creator.id, stage: 'fetch_notifications' })
    return (
      <div>
        <p className="text-red-500">Failed to load notifications</p>
      </div>
    )
  }

  const notificationRows = (rows || []) as unknown as NotificationRow[]

  // Drafts are approvable only on channels whose ownership is verified. Service
  // client because the grant table is service-role only; creator.id is from the
  // session. Fails closed: a post that can't be resolved is not actionable.
  const postIds = [...new Set(notificationRows.map(r => r.comments?.post_id).filter((id): id is string => Boolean(id)))]
  const actionablePostIds = await resolveVerifiedPostIds(createServiceClient(), creator.id, postIds)

  const items: InboxItem[] = notificationRows.map(row => {
    const comment = row.comments
    const info = comment?.comment_categories ?? null
    const approved = Boolean(info?.draft_reply_approved_at)
    const pendingDraft = !approved && Boolean(info?.draft_reply)
    const draftLocked = pendingDraft && !actionablePostIds.has(comment?.post_id ?? '')

    return {
      id: row.id,
      type: row.type,
      message: row.message,
      read: row.read,
      createdAt: row.created_at,
      comment: comment
        ? {
            id: comment.id,
            text: comment.text,
            postedAt: comment.posted_at,
            postId: comment.post_id,
            authorName: comment.audience_members?.display_name || 'Unknown',
            videoTitle: comment.posts?.title || 'Untitled video',
            category: info?.category ?? null,
            // A draft that has already been approved is no longer actionable, so the
            // card renders as history rather than offering Approve a second time.
            // Locked drafts are withheld here, so the editor never renders them.
            draftReply: approved || draftLocked ? null : info?.draft_reply ?? null,
            finalReplyText: info?.final_reply_text ?? null,
            draftConfidence: info?.draft_confidence ?? null,
            escalationFlag: info?.escalation_flag ?? null,
            approved,
            draftLocked,
          }
        : null,
    }
  })

  const unreadCount = items.filter(i => !i.read).length

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Notifications" backHref="/dashboard/agent" backLabel="Agent Home" />

      <p className="mt-1 mb-5 text-sm text-text-muted">
        {items.length === 0
          ? 'Comments needing your attention will appear here.'
          : `${unreadCount} unread of ${items.length} recent`}
      </p>

      <NotificationsList items={items} />
    </div>
  )
}
