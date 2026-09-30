import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import PageHeader from '@/components/PageHeader'
import Avatar from '@/components/Avatar'
import { logError } from '@/lib/logger'

export const dynamic = 'force-dynamic'

type Row = {
  comment_id: string
  final_reply_text: string | null
  draft_reply_approved_at: string
  reply_send_status: string | null
  reply_auto_sent: boolean | null
  comments: {
    id: string
    text: string
    posted_at: string
    post_id: string
    audience_member_id: string
    posts: { title: string | null; creator_id: string } | null
  } | null
}

const STATUS_LABELS: Record<string, string> = {
  sent: 'Sent',
  failed: 'Approved, send failed',
  skipped: 'Approved, not sent',
}

/**
 * One person's full reply history with this creator — every comment they left
 * that got an approved reply, oldest first like a message thread, across every
 * video. Same underlying data as the Messages list, just unfiltered by "most
 * recent only" and ordered chronologically instead.
 */
export default async function MessageThreadPage({ params }: { params: Promise<{ memberId: string }> }) {
  const { memberId } = await params
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
    logError('page.messageThread', creatorError, { user_id: user.id, stage: 'fetch_creator' })
    return (
      <div>
        <p className="text-red-500">Failed to load your account details.</p>
      </div>
    )
  }
  if (!creator) redirect('/login')

  const { data: memberRow } = await supabase.from('audience_members').select('display_name').eq('id', memberId).eq('creator_id', creator.id).maybeSingle()
  if (!memberRow) notFound()

  // reply_auto_sent (migration 52) may not exist yet — same self-healing pattern
  // used on Notifications.
  const baseColumns = 'comment_id, final_reply_text, draft_reply_approved_at, reply_send_status, comments!inner ( id, text, posted_at, post_id, audience_member_id, posts!inner ( title, creator_id ) )'
  let rows: unknown[] | null
  let error: { code?: string; message?: string } | null

  {
    const result = await supabase
      .from('comment_categories')
      .select(`${baseColumns}, reply_auto_sent`)
      .eq('comments.audience_member_id', memberId)
      .eq('comments.posts.creator_id', creator.id)
      .not('draft_reply_approved_at', 'is', null)
      .order('draft_reply_approved_at', { ascending: true })
    rows = result.data
    error = result.error
  }

  if (error && (error.code === 'PGRST204' || error.code === '42703') && (error.message ?? '').includes('reply_auto_sent')) {
    const fallback = await supabase
      .from('comment_categories')
      .select(baseColumns)
      .eq('comments.audience_member_id', memberId)
      .eq('comments.posts.creator_id', creator.id)
      .not('draft_reply_approved_at', 'is', null)
      .order('draft_reply_approved_at', { ascending: true })
    rows = fallback.data
    error = fallback.error
  }

  if (error) {
    logError('page.messageThread', error, { creator_id: creator.id, member_id: memberId, stage: 'fetch_thread' })
    return (
      <div>
        <p className="text-red-500">Failed to load this conversation</p>
      </div>
    )
  }

  const thread = (rows ?? []) as unknown as Row[]
  const name = memberRow.display_name || 'Unknown'

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={name} backHref="/dashboard/messages" backLabel="Messages" />

      {thread.length === 0 ? (
        <p className="text-sm text-text-muted">No approved replies to this person yet.</p>
      ) : (
        <ul className="space-y-4">
          {thread.map(row => {
            const comment = row.comments
            if (!comment) return null
            return (
              <li key={row.comment_id} className="card">
                <div className="flex items-start gap-3">
                  <Avatar name={name} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-relaxed text-text-primary">{comment.text}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-text-muted">
                      <Link href={`/dashboard/inbox/${comment.post_id}`} className="truncate text-purple-text hover:underline">
                        {comment.posts?.title || 'Untitled video'}
                      </Link>
                      <span>·</span>
                      <span>{new Date(comment.posted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
                    </div>
                  </div>
                </div>

                {/* Your reply, indented under their comment like a message thread. */}
                <div className="mt-3 ml-11 rounded-md border border-purple/20 bg-purple/5 p-3">
                  <p className="text-sm leading-relaxed text-text-primary">{row.final_reply_text || '(no text recorded)'}</p>
                  <p className="mt-1.5 text-[11px] text-text-muted">
                    {row.reply_send_status ? STATUS_LABELS[row.reply_send_status] ?? row.reply_send_status : 'Approved'}
                    {row.reply_auto_sent ? ' · sent automatically' : ''}
                    {' · '}
                    {new Date(row.draft_reply_approved_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
