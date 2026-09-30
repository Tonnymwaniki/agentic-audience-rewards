import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import PageHeader from '@/components/PageHeader'
import Avatar from '@/components/Avatar'
import { fetchInBatches } from '@/lib/supabase-helpers'
import { getChannelVerificationSummary, UNKNOWN_CHANNEL_ID } from '@/lib/channel-verification'
import { logError } from '@/lib/logger'
import AudienceFilters from './AudienceFilters'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Audience · Notice' }

/** A directory, not an archive — the most recently active people, capped so the
 *  page stays fast on a channel with a large comment history. */
const MAX_MEMBERS = 200

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

type MemberRow = {
  id: string
  display_name: string | null
  segment: string | null
  level: string | null
}

export default async function AudiencePage({ searchParams }: { searchParams: Promise<{ channel?: string; segment?: string; level?: string }> }) {
  const { channel: channelParam, segment: segmentParam, level: levelParam } = await searchParams

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
    logError('page.audience', creatorError, { user_id: user.id, stage: 'fetch_creator' })
    return (
      <div>
        <p className="text-red-500">Failed to load your account details.</p>
      </div>
    )
  }
  if (!creator) redirect('/login')

  const service = createServiceClient()

  const channelSummary = await getChannelVerificationSummary(service, creator.id)
  const knownChannels = channelSummary.filter(c => c.channelId !== UNKNOWN_CHANNEL_ID)
  const selectedChannelId = channelParam && channelParam !== 'all' ? channelParam : null

  let { data: postRows, error: postsError } = await service.from('posts').select('id, channel_id').eq('creator_id', creator.id)
  if (postsError && (postsError.code === 'PGRST204' || postsError.code === '42703')) {
    const fallback = await service.from('posts').select('id').eq('creator_id', creator.id)
    postRows = (fallback.data ?? []).map(p => ({ ...p, channel_id: null }))
    postsError = fallback.error
  }
  if (postsError) {
    logError('page.audience', postsError, { creator_id: creator.id, stage: 'fetch_posts' })
  }
  const allPosts = (postRows ?? []) as Array<{ id: string; channel_id: string | null }>
  const postList = selectedChannelId ? allPosts.filter(p => p.channel_id === selectedChannelId) : allPosts
  const postIds = postList.map(p => p.id)

  const comments = postIds.length
    ? await fetchInBatches<{ id: string; audience_member_id: string | null; posted_at: string }>(service, {
        table: 'comments',
        select: 'id, audience_member_id, posted_at',
        inColumn: 'post_id',
        inValues: postIds,
      })
    : []

  const activityByMember = new Map<string, { count: number; lastAt: string; firstAt: string }>()
  for (const c of comments) {
    if (!c.audience_member_id) continue
    const existing = activityByMember.get(c.audience_member_id)
    if (!existing) {
      activityByMember.set(c.audience_member_id, { count: 1, lastAt: c.posted_at, firstAt: c.posted_at })
    } else {
      existing.count++
      if (c.posted_at > existing.lastAt) existing.lastAt = c.posted_at
      if (c.posted_at < existing.firstAt) existing.firstAt = c.posted_at
    }
  }

  const memberIds = [...activityByMember.keys()]
  const members = memberIds.length
    ? await fetchInBatches<MemberRow>(service, {
        table: 'audience_members',
        select: 'id, display_name, segment, level',
        inColumn: 'id',
        inValues: memberIds,
      })
    : []
  const memberById = new Map(members.map(m => [m.id, m]))

  let rows = memberIds
    .map(id => {
      const member = memberById.get(id)
      const activity = activityByMember.get(id)!
      return {
        id,
        name: member?.display_name || 'Unknown',
        segment: member?.segment ?? null,
        level: member?.level ?? null,
        commentCount: activity.count,
        lastAt: activity.lastAt,
      }
    })
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))

  if (segmentParam && segmentParam !== 'all') rows = rows.filter(r => r.segment === segmentParam)
  if (levelParam && levelParam !== 'all') rows = rows.filter(r => r.level === levelParam)

  const totalMatching = rows.length
  rows = rows.slice(0, MAX_MEMBERS)

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Audience" backHref="/dashboard/agent" backLabel="Agent Home" />
      <p className="mt-1 mb-4 text-sm text-text-muted">
        {totalMatching.toLocaleString()} {totalMatching === 1 ? 'person has' : 'people have'} commented
        {selectedChannelId ? ' on this channel' : ''}
        {totalMatching > MAX_MEMBERS ? ` — showing the ${MAX_MEMBERS} most recently active` : ''}.
      </p>

      <AudienceFilters channels={knownChannels.map(c => ({ channelId: c.channelId, title: c.title }))} />

      {rows.length === 0 ? (
        <section className="card text-center">
          <p className="font-display text-lg font-semibold text-text-primary">No one matches yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">
            {segmentParam || levelParam ? 'Try a different filter, or ' : ''}Segments and levels fill in as videos are
            (re-)analyzed.
          </p>
        </section>
      ) : (
        <ul className="space-y-2">
          {rows.map(r => (
            <li key={r.id}>
              <Link href={`/dashboard/audience/${r.id}`} className="card flex items-center gap-3 transition-colors hover:bg-surface-hover">
                <Avatar name={r.name} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="truncate font-body text-sm font-medium text-text-primary">{r.name}</p>
                    {r.segment && <span className="badge">{SEGMENT_LABELS[r.segment] ?? r.segment}</span>}
                    {r.level && <span className="badge">{LEVEL_LABELS[r.level] ?? r.level}</span>}
                  </div>
                  <p className="mt-0.5 text-xs text-text-muted">
                    {r.commentCount} {r.commentCount === 1 ? 'comment' : 'comments'} · last{' '}
                    {new Date(r.lastAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
