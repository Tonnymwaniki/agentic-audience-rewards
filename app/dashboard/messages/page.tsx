import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import PageHeader from '@/components/PageHeader'
import Avatar from '@/components/Avatar'
import { logError } from '@/lib/logger'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Messages · Notice' }

/** How far back to look for building the conversation list — a work queue of
 *  recent activity, not a full archive, same reasoning as Notifications' PAGE_SIZE. */
const RECENT_LIMIT = 500

type Row = {
  comment_id: string
  final_reply_text: string | null
  draft_reply_approved_at: string
  reply_send_status: string | null
  comments: {
    audience_member_id: string
    audience_members: { display_name: string } | null
  } | null
}

type Conversation = {
  memberId: string
  name: string
  lastMessage: string
  lastAt: string
  lastStatus: string | null
  messageCount: number
}

/**
 * "Sent" view of the reply pipeline — every approved reply regrouped by WHO you
 * sent it to instead of which video it was on, like a messaging app's chat list.
 * Built entirely from data already stored by lib/reply-approval.ts (final_reply_text,
 * draft_reply_approved_at, reply_send_status) — no new ingestion or columns needed.
 */
export default async function MessagesPage() {
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
    logError('page.messages', creatorError, { user_id: user.id, stage: 'fetch_creator' })
    return (
      <div>
        <p className="text-red-500">Failed to load your account details.</p>
      </div>
    )
  }
  if (!creator) redirect('/login')

  // Scoped to this creator through the join chain, same pattern as
  // lib/categorize.ts's loadStyleExamples — `!inner` means Postgres filters at the
  // join rather than this app fetching every creator's approved replies.
  const { data: rows, error } = await supabase
    .from('comment_categories')
    .select(
      'comment_id, final_reply_text, draft_reply_approved_at, reply_send_status, comments!inner ( audience_member_id, audience_members ( display_name ), posts!inner ( creator_id ) )'
    )
    .eq('comments.posts.creator_id', creator.id)
    .not('draft_reply_approved_at', 'is', null)
    .order('draft_reply_approved_at', { ascending: false })
    .limit(RECENT_LIMIT)

  if (error) {
    logError('page.messages', error, { creator_id: creator.id, stage: 'fetch_replies' })
    return (
      <div>
        <p className="text-red-500">Failed to load messages</p>
      </div>
    )
  }

  const byMember = new Map<string, Conversation>()
  for (const row of (rows ?? []) as unknown as Row[]) {
    const memberId = row.comments?.audience_member_id
    if (!memberId) continue
    const existing = byMember.get(memberId)
    if (existing) {
      existing.messageCount++
      continue
    }
    byMember.set(memberId, {
      memberId,
      name: row.comments?.audience_members?.display_name || 'Unknown',
      lastMessage: row.final_reply_text || '',
      lastAt: row.draft_reply_approved_at,
      lastStatus: row.reply_send_status,
      messageCount: 1,
    })
  }

  // Rows already arrived newest-first, and each member's FIRST row encountered is
  // therefore their most recent — Map insertion order preserves that.
  const conversations = [...byMember.values()]

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Messages" backHref="/dashboard/notifications" backLabel="Notifications" />
      <p className="mt-1 mb-5 text-sm text-text-muted">
        {conversations.length === 0
          ? 'Replies you approve or send will show up here, grouped by who you sent them to.'
          : `${conversations.length} ${conversations.length === 1 ? 'conversation' : 'conversations'}`}
      </p>

      {conversations.length === 0 ? (
        <section className="card text-center">
          <p className="font-display text-lg font-semibold text-text-primary">No messages sent yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">
            Approve a drafted reply from Notifications and it&apos;ll appear here.
          </p>
          <Link href="/dashboard/notifications" className="mt-4 inline-flex min-h-11 items-center text-sm text-purple-text underline hover:text-purple-hover">
            Go to Notifications
          </Link>
        </section>
      ) : (
        <ul className="space-y-2">
          {conversations.map(c => (
            <li key={c.memberId}>
              <Link
                href={`/dashboard/messages/${c.memberId}`}
                className="card flex items-center gap-3 transition-colors hover:bg-surface-hover"
              >
                <Avatar name={c.name} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate font-body text-sm font-medium text-text-primary">{c.name}</p>
                    <span className="flex-shrink-0 text-xs text-text-muted">{timeAgo(c.lastAt)}</span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-text-muted">{c.lastMessage || '(no reply text)'}</p>
                </div>
                {c.messageCount > 1 && (
                  <span className="flex-shrink-0 rounded-full bg-surface-hover px-2 py-0.5 font-mono text-[10px] text-text-muted">
                    {c.messageCount}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function timeAgo(dateString: string): string {
  const diffMs = Date.now() - new Date(dateString).getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHour < 24) return `${diffHour}h ago`
  if (diffDay < 30) return `${diffDay}d ago`
  return `${Math.floor(diffDay / 30)}mo ago`
}
