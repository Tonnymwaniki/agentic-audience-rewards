import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import PageHeader from '@/components/PageHeader'
import Avatar from '@/components/Avatar'
import { VOIDED_UNVERIFIED_STATUS } from '@/lib/rewards/status'
import { logError } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const SEGMENT_LABELS: Record<string, string> = {
  potential_customer: 'Potential customer',
  critic: 'Critic',
  loyal_fan: 'Loyal fan',
  content_requester: 'Content requester',
  casual_viewer: 'Casual viewer',
}
const LEVEL_LABELS: Record<string, string> = {
  new: 'New',
  regular: 'Regular',
  rising_fan: 'Rising fan',
  super_fan: 'Super fan',
}

/** Recent comments shown on the profile — a work queue's worth, not the full history. */
const MAX_COMMENTS = 50

type CommentRow = {
  id: string
  text: string
  posted_at: string
  post_id: string
  posts: { title: string | null } | null
  comment_categories: { category: string | null; sentiment: string | null } | null
}

/**
 * One commenter's profile: what our own rule-based segment/level and LLM summary
 * say about them (lib/segments.ts, lib/levels.ts, lib/audience-memory.ts), plus
 * their actual comment history across every video, and a link into the Messages
 * thread if you've replied to them before.
 */
export default async function AudienceProfilePage({ params }: { params: Promise<{ memberId: string }> }) {
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
    logError('page.audienceProfile', creatorError, { user_id: user.id, stage: 'fetch_creator' })
    return (
      <div>
        <p className="text-red-500">Failed to load your account details.</p>
      </div>
    )
  }
  if (!creator) redirect('/login')

  const service = createServiceClient()

  const { data: member, error: memberError } = await service
    .from('audience_members')
    .select('id, display_name, segment, level, profile_summary, profile_updated_at')
    .eq('id', memberId)
    .eq('creator_id', creator.id)
    .maybeSingle()

  if (memberError) {
    logError('page.audienceProfile', memberError, { creator_id: creator.id, member_id: memberId, stage: 'fetch_member' })
    return (
      <div>
        <p className="text-red-500">Failed to load this profile</p>
      </div>
    )
  }
  if (!member) notFound()

  const { data: commentRows, error: commentsError } = await service
    .from('comments')
    .select('id, text, posted_at, post_id, posts ( title ), comment_categories ( category, sentiment )')
    .eq('audience_member_id', memberId)
    .order('posted_at', { ascending: false })
    .limit(MAX_COMMENTS)

  if (commentsError) {
    logError('page.audienceProfile', commentsError, { creator_id: creator.id, member_id: memberId, stage: 'fetch_comments' })
  }
  const comments = ((commentRows ?? []) as unknown as CommentRow[]).filter(Boolean)

  // Total count and distinct videos, separate from the capped list above.
  const { count: totalComments } = await service
    .from('comments')
    .select('id', { count: 'exact', head: true })
    .eq('audience_member_id', memberId)

  const distinctPosts = new Set(comments.map(c => c.post_id)).size
  const firstSeen = comments.length ? comments[comments.length - 1].posted_at : null

  const { count: rewardCount } = await service
    .from('reward_events')
    .select('id', { count: 'exact', head: true })
    .eq('audience_member_id', memberId)
    .neq('status', VOIDED_UNVERIFIED_STATUS)

  const name = member.display_name || 'Unknown'

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={name} backHref="/dashboard/audience" backLabel="Audience" />

      <section className="card">
        <div className="flex items-start gap-3">
          <Avatar name={name} size={48} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {member.segment && <span className="badge">{SEGMENT_LABELS[member.segment] ?? member.segment}</span>}
              {member.level && <span className="badge">{LEVEL_LABELS[member.level] ?? member.level}</span>}
            </div>
            {member.profile_summary ? (
              <p className="mt-2 text-sm leading-relaxed text-text-primary">{member.profile_summary}</p>
            ) : (
              <p className="mt-2 text-sm italic text-text-muted">
                Not enough comments yet for a summary — needs at least 2.
              </p>
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 border-t border-white/10 pt-3 sm:grid-cols-4">
          <div>
            <p className="font-display text-lg leading-none text-text-primary">{(totalComments ?? comments.length).toLocaleString()}</p>
            <p className="mt-1 text-[11px] text-text-muted">Comments</p>
          </div>
          <div>
            <p className="font-display text-lg leading-none text-text-primary">{distinctPosts.toLocaleString()}</p>
            <p className="mt-1 text-[11px] text-text-muted">Videos (of last {comments.length})</p>
          </div>
          <div>
            <p className="font-display text-lg leading-none text-text-primary">{(rewardCount ?? 0).toLocaleString()}</p>
            <p className="mt-1 text-[11px] text-text-muted">Times recognized</p>
          </div>
          <div>
            <p className="font-display text-sm leading-none text-text-primary">
              {firstSeen ? new Date(firstSeen).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '—'}
            </p>
            <p className="mt-1 text-[11px] text-text-muted">First seen (recent window)</p>
          </div>
        </div>

        <div className="mt-3 border-t border-white/10 pt-3">
          <Link href={`/dashboard/messages/${memberId}`} className="inline-flex min-h-11 items-center text-xs text-purple-text hover:underline">
            View message history →
          </Link>
        </div>
      </section>

      <h2 className="mt-6 mb-2 font-display text-sm font-semibold text-text-primary">Recent comments</h2>
      {comments.length === 0 ? (
        <p className="text-sm text-text-muted">No comments found.</p>
      ) : (
        <ul className="space-y-2">
          {comments.map(c => (
            <li key={c.id} className="card">
              <div className="flex items-center justify-between gap-2">
                {c.comment_categories?.category && <span className="badge">{c.comment_categories.category.replace(/_/g, ' ')}</span>}
                <span className="text-xs text-text-muted">{new Date(c.posted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
              </div>
              <p className="mt-1 text-sm leading-relaxed text-text-primary">{c.text}</p>
              <Link href={`/dashboard/inbox/${c.post_id}`} className="mt-1 block truncate text-xs text-purple-text hover:underline">
                {c.posts?.title || 'Untitled video'}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
