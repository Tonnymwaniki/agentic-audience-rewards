import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import PageHeader from '@/components/PageHeader'
import Avatar from '@/components/Avatar'
import { VOIDED_UNVERIFIED_STATUS } from '@/lib/rewards/status'
import { logError } from '@/lib/logger'
import EnrichButton from './EnrichButton'

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

  // channel_bio/channel_subscriber_count/etc (migration 56) may not exist yet on
  // this database — same self-healing pattern used throughout, and a literal
  // select string per branch to keep Supabase's type inference happy.
  const MEMBER_SELECT_WITH_ENRICHMENT =
    'id, external_id, display_name, segment, level, profile_summary, profile_updated_at, channel_bio, channel_subscriber_count, channel_video_count, channel_created_at, channel_enriched_at'
  const MEMBER_SELECT_BASE = 'id, external_id, display_name, segment, level, profile_summary, profile_updated_at'

  let member: unknown | null = null
  let memberError: { code?: string; message?: string } | null = null
  let enrichmentColumnsAvailable = true

  const withEnrichment = await service
    .from('audience_members')
    .select(MEMBER_SELECT_WITH_ENRICHMENT)
    .eq('id', memberId)
    .eq('creator_id', creator.id)
    .maybeSingle()
  member = withEnrichment.data
  memberError = withEnrichment.error

  if (memberError && (memberError.code === 'PGRST204' || memberError.code === '42703')) {
    enrichmentColumnsAvailable = false
    const base = await service
      .from('audience_members')
      .select(MEMBER_SELECT_BASE)
      .eq('id', memberId)
      .eq('creator_id', creator.id)
      .maybeSingle()
    member = base.data
    memberError = base.error
  }

  const memberRow = member as {
    id: string
    external_id: string | null
    display_name: string | null
    segment: string | null
    level: string | null
    profile_summary: string | null
    profile_updated_at: string | null
    channel_bio?: string | null
    channel_subscriber_count?: number | null
    channel_video_count?: number | null
    channel_created_at?: string | null
    channel_enriched_at?: string | null
  } | null

  if (memberError) {
    logError('page.audienceProfile', memberError, { creator_id: creator.id, member_id: memberId, stage: 'fetch_member' })
    return (
      <div>
        <p className="text-red-500">Failed to load this profile</p>
      </div>
    )
  }
  if (!memberRow) notFound()

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

  const name = memberRow.display_name || 'Unknown'
  const hasChannelInfo = Boolean(memberRow.channel_enriched_at && (memberRow.channel_bio || memberRow.channel_subscriber_count != null || memberRow.channel_video_count != null || memberRow.channel_created_at))

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={name} backHref="/dashboard/audience" backLabel="Audience" />

      <section className="card">
        <div className="flex items-start gap-3">
          <Avatar name={name} size={48} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {memberRow.segment && <span className="badge">{SEGMENT_LABELS[memberRow.segment] ?? memberRow.segment}</span>}
              {memberRow.level && <span className="badge">{LEVEL_LABELS[memberRow.level] ?? memberRow.level}</span>}
            </div>
            {memberRow.profile_summary ? (
              <p className="mt-2 text-sm leading-relaxed text-text-primary">{memberRow.profile_summary}</p>
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

      {enrichmentColumnsAvailable && (
        <section className="card mt-3">
          <h2 className="font-display text-sm font-semibold text-text-primary">Channel info</h2>
          {hasChannelInfo ? (
            <>
              {memberRow.channel_bio && (
                <p className="mt-2 text-sm leading-relaxed text-text-primary">{memberRow.channel_bio}</p>
              )}
              <div className="mt-3 grid grid-cols-3 gap-2">
                <div>
                  <p className="font-display text-base leading-none text-text-primary">
                    {memberRow.channel_subscriber_count != null ? memberRow.channel_subscriber_count.toLocaleString() : '—'}
                  </p>
                  <p className="mt-1 text-[11px] text-text-muted">Subscribers</p>
                </div>
                <div>
                  <p className="font-display text-base leading-none text-text-primary">
                    {memberRow.channel_video_count != null ? memberRow.channel_video_count.toLocaleString() : '—'}
                  </p>
                  <p className="mt-1 text-[11px] text-text-muted">Videos</p>
                </div>
                <div>
                  <p className="font-display text-sm leading-none text-text-primary">
                    {memberRow.channel_created_at
                      ? new Date(memberRow.channel_created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
                      : '—'}
                  </p>
                  <p className="mt-1 text-[11px] text-text-muted">Channel created</p>
                </div>
              </div>
              <p className="mt-3 text-[11px] text-text-muted">
                From their public YouTube channel — refreshed{' '}
                {memberRow.channel_enriched_at ? new Date(memberRow.channel_enriched_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'recently'}.
              </p>
              <div className="mt-2">
                <EnrichButton memberId={memberId} label="Refresh channel info" />
              </div>
            </>
          ) : (
            <>
              <p className="mt-2 text-sm text-text-muted">
                Pull their public channel bio, subscriber count, and video count from YouTube. This never reveals a real
                name, email, or location — YouTube doesn&apos;t expose those.
              </p>
              <div className="mt-2">
                <EnrichButton memberId={memberId} label="Fetch channel info" />
              </div>
            </>
          )}
        </section>
      )}

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
