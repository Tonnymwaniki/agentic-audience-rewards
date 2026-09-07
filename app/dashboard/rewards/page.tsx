import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { fetchInBatches } from '@/lib/supabase-helpers'
import PageHeader from '@/components/PageHeader'
import MascotIcon from '@/components/MascotIcon'
import EvaluateButton from './EvaluateButton'
import CopyLinkButton from './CopyLinkButton'

const glyphProps = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  className: 'h-5 w-5',
} as const

function CrownGlyph() {
  return (
    <svg {...glyphProps}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 17.5 2.5 7l5.25 3.75L12 4.5l4.25 6.25L21.5 7 20 17.5zM5 20h14"
      />
    </svg>
  )
}

function TicketGlyph() {
  return (
    <svg {...glyphProps}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-12v.75m0 3v.75m0 3v.75m0 3V18M3.75 6.75A1.5 1.5 0 0 1 5.25 5.25h13.5a1.5 1.5 0 0 1 1.5 1.5v1.5a2.25 2.25 0 0 0 0 4.5v1.5a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5v-1.5a2.25 2.25 0 0 0 0-4.5z"
      />
    </svg>
  )
}

// The previous pill used Tailwind's default bg-yellow-100 / text-yellow-800 — a
// light-theme pairing that rendered as a bright cream chip on the dark surface.
// These map each real status to the app's own palette.
const STATUS_STYLES: Record<string, string> = {
  pending: 'border-gold/30 bg-gold-dim text-gold-light',
  minted: 'border-teal/30 bg-teal-dim text-teal',
  claimed: 'border-green/30 bg-green-dim text-green',
}

function StatusPill({ status }: { status: string }) {
  const style = STATUS_STYLES[status] || 'border-white/10 bg-surface-hover text-text-muted'
  return (
    <span
      className={`inline-flex flex-shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] tracking-wide uppercase ${style}`}
    >
      {status}
    </span>
  )
}

export default async function RewardsPage({
  searchParams,
}: {
  searchParams: Promise<{ post?: string }>
}) {
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
    console.error('Rewards creator fetch error:', JSON.stringify(creatorError, Object.getOwnPropertyNames(creatorError), 2))
    return (
      <div className="p-6">
        <p className="text-red-500">Failed to load your account details.</p>
      </div>
    )
  }

  if (!creator) {
    redirect('/login')
  }

  const params = await searchParams
  const selectedPostId = params.post || null

  // Paged, not a bare select. Supabase caps a single response at 1000 rows, and
  // this creator already has 1601 audience members — an unpaged fetch silently
  // returned the first 1000, so every reward belonging to the other 601 was
  // invisible on this page. That under-reported the reward list rather than
  // erroring, which is exactly why it went unnoticed.
  const creatorMemberIds: string[] = []
  {
    let offset = 0
    const pageSize = 1000
    let hasMore = true

    while (hasMore) {
      const { data: page, error: audienceError } = await supabase
        .from('audience_members')
        .select('id')
        .eq('creator_id', creator.id)
        .range(offset, offset + pageSize - 1)

      if (audienceError) {
        console.error('Audience members fetch error:', JSON.stringify(audienceError, Object.getOwnPropertyNames(audienceError), 2))
        return (
          <div className="p-6">
            <p className="text-red-500">Failed to load audience members</p>
          </div>
        )
      }

      if (page && page.length > 0) {
        creatorMemberIds.push(...page.map(m => m.id))
        offset += pageSize
      }

      if (!page || page.length < pageSize) {
        hasMore = false
      }
    }
  }

  // Scoped at the database level. `audience_members` is the only table carrying
  // creator_id for a reward, so the creator's member ids are resolved first and
  // every reward_events request is constrained to that set with .in(). No row
  // belonging to another creator is ever selected, so none reaches this process —
  // the previous version fetched the table unscoped and discarded foreign rows in
  // JS, which both loaded them into server memory and let Supabase's 1000-row cap
  // silently drop this creator's own events once the table grew.
  //
  // fetchInBatches chunks the id list (a single .in() with 1601 ids exceeds the
  // URL length limit) and pages each chunk past the 1000-row response cap.
  // throwOnError is set because a partially-fetched reward list would look
  // complete and understate what the creator is owed.
  type RewardEventRow = {
    id: string
    post_id: string | null
    audience_member_id: string
    reason: string
    status: string
    claim_token: string
    tx_hash: string | null
    created_at: string
    audience_members: unknown
  }

  let rewardEvents: RewardEventRow[]

  if (creatorMemberIds.length === 0) {
    // No members means no rewards; skip the round trip entirely.
    rewardEvents = []
  } else {
    try {
      rewardEvents = await fetchInBatches<RewardEventRow>(supabase, {
        table: 'reward_events',
        select:
          'id, post_id, audience_member_id, reason, status, claim_token, tx_hash, created_at, audience_members ( display_name )',
        inColumn: 'audience_member_id',
        inValues: creatorMemberIds,
        // Applied server-side too, so narrowing to one video doesn't over-fetch.
        // A post_id belonging to someone else simply matches nothing, because the
        // .in() above already confines results to this creator's members.
        ...(selectedPostId ? { eq: { post_id: selectedPostId } } : {}),
        throwOnError: true,
      })
    } catch (err) {
      console.error('Reward events fetch error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
      return (
        <div className="p-6">
          <p className="text-red-500">Failed to load reward events</p>
        </div>
      )
    }
  }

  const formattedEvents = rewardEvents
    // Ordering moved out of the query: results arrive per id-chunk, so a per-request
    // .order() would only sort within each chunk. Sorting the assembled list is what
    // actually produces newest-first overall.
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map(event => ({
      id: event.id,
      audienceMemberId: event.audience_member_id,
      displayName: (event.audience_members as unknown as { display_name: string } | null)?.display_name || 'Unknown',
      reason: event.reason,
      status: event.status,
      createdAt: event.created_at,
      claimToken: event.claim_token,
      txHash: event.tx_hash,
    }))

  // Derived from the same array the list below renders, so the numbers always
  // agree with what's on screen — including when ?post= narrows it to one video.
  //
  // "People" is deliberately distinct members, not event count: one person can be
  // recognized on more than one video, and counting events would overstate reach.
  const peopleRecognizedCount = new Set(formattedEvents.map(e => e.audienceMemberId)).size
  const pendingClaimsCount = formattedEvents.filter(e => e.status === 'pending').length

  return (
    <div className="space-y-6">
      <PageHeader title="Rewards" backHref="/dashboard/inbox" backLabel="My Videos" />

      {/* Wording matches what this page actually does: the agent evaluates who
          genuinely engaged and issues them a Proof of Engagement token on-chain. */}
      <div className="flex flex-col items-center text-center">
        <MascotIcon type="rewards" />
        <p className="mt-3 text-sm text-text-muted">
          Recognizing your most engaged audience, on-chain
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="card">
          <span className="icon-badge icon-badge-gold" aria-hidden="true">
            <CrownGlyph />
          </span>
          <p className="mt-3 font-display text-3xl leading-none font-semibold text-gold-light">
            {peopleRecognizedCount.toLocaleString()}
          </p>
          <p className="mt-1.5 text-xs leading-snug text-text-muted">People recognized</p>
        </div>
        <div className="card">
          <span className="icon-badge icon-badge-purple" aria-hidden="true">
            <TicketGlyph />
          </span>
          <p className="mt-3 font-display text-3xl leading-none font-semibold text-purple-text">
            {pendingClaimsCount.toLocaleString()}
          </p>
          <p className="mt-1.5 text-xs leading-snug text-text-muted">Pending claims</p>
        </div>
      </div>

      <EvaluateButton creatorId={creator.id} postId={selectedPostId} />

      {formattedEvents.length === 0 ? (
        <p className="text-text-muted">No reward events yet. Run an evaluation to find eligible audience members.</p>
      ) : (
        <ul className="space-y-3">
          {formattedEvents.map(event => (
            <li key={event.id} className="card">
              {/* Stacked rather than a two-column split: at 320px the old right-hand
                  column squeezed "Copy Claim Link" against the name. Same data, same
                  CopyLinkButton props — layout only. */}
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 flex-1 font-body text-sm font-medium break-words text-text-primary">
                  {event.displayName}
                </p>
                <StatusPill status={event.status} />
              </div>

              <p className="mt-2 text-sm text-text-muted">
                <span className="highlight">{event.reason}</span>
              </p>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-text-muted">
                  {new Date(event.createdAt).toLocaleString()}
                </p>
                <CopyLinkButton claimToken={event.claimToken} status={event.status} txHash={event.txHash} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
