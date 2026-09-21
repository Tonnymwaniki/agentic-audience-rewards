import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { fetchInBatches } from '@/lib/supabase-helpers'
import MascotIcon from '@/components/MascotIcon'
import LogoutButton from './LogoutButton'
import DataControls from './DataControls'
import { logError } from '@/lib/logger'

export const dynamic = 'force-dynamic'

/** Answered in the product: support goes to the account owner's inbox. */
const SUPPORT_EMAIL = 'mwanikitonny3@gmail.com'

const linkIconProps = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  className: 'h-5 w-5',
} as const

const ACCOUNT_LINKS = [
  {
    href: '/dashboard/connect',
    tone: 'purple',
    label: 'Analyze more videos',
    description: 'Connect a channel or pull in new videos',
    icon: (
      <svg {...linkIconProps}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="m15.75 10.5 4.72-2.36a.75.75 0 0 1 1.08.67v8.38a.75.75 0 0 1-1.08.67l-4.72-2.36M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-7.5A2.25 2.25 0 0 0 13.5 6.75h-9A2.25 2.25 0 0 0 2.25 9v7.5a2.25 2.25 0 0 0 2.25 2.25Z"
        />
      </svg>
    ),
  },
  {
    href: '/dashboard/profile',
    tone: 'pink',
    label: 'Business Profile',
    description: 'Facts your agent uses when drafting replies',
    icon: (
      <svg {...linkIconProps}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M13.5 21v-7.5a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 .75.75V21m-4.5 0H2.36m11.14 0H18m0 0h3.64m-1.39 0V9.349M3.75 21V9.349m0 0a3.001 3.001 0 0 0 3.75-.615A2.993 2.993 0 0 0 9.75 9.75c.896 0 1.7-.393 2.25-1.016a2.993 2.993 0 0 0 2.25 1.016c.896 0 1.7-.393 2.25-1.016a3.001 3.001 0 0 0 3.75.614m-16.5 0a3.004 3.004 0 0 1-.621-4.72l1.189-1.19A1.5 1.5 0 0 1 5.378 3h13.243a1.5 1.5 0 0 1 1.06.44l1.19 1.189a3 3 0 0 1-.621 4.72M6.75 18h3.75a.75.75 0 0 0 .75-.75V13.5a.75.75 0 0 0-.75-.75H6.75a.75.75 0 0 0-.75.75v3.75c0 .414.336.75.75.75Z"
        />
      </svg>
    ),
  },
  {
    href: '/dashboard/rewards',
    tone: 'gold',
    label: 'Rewards',
    description: 'People your agent recognized, and their claim links',
    icon: (
      <svg {...linkIconProps}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 17.5 2.5 7l5.25 3.75L12 4.5l4.25 6.25L21.5 7 20 17.5zM5 20h14"
        />
      </svg>
    ),
  },
  {
    // The only route back to the platform hub. The header wordmark used to carry
    // that link; when it was removed the hub became reachable only by typing the
    // URL, so it lives here — reachable at every width, since this page is the
    // "Me" tab on mobile.
    href: '/dashboard/hub',
    tone: 'teal',
    label: 'Switch platform',
    description: 'Back to the platform hub',
    icon: (
      <svg {...linkIconProps}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6Zm9.75 0A2.25 2.25 0 0 1 15.75 3.75H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6Zm-9.75 9.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25Zm9.75 0A2.25 2.25 0 0 1 15.75 13.5H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z"
        />
      </svg>
    ),
  },
] as const

/**
 * Same treatment as Agent Home's StatCard — icon badge, large display number,
 * muted caption — so a stat means the same thing wherever it appears. These are
 * all-time totals rather than Agent Home's rolling 24h window, which is why the
 * section is labelled as such.
 */
function StatCard({
  icon,
  value,
  label,
  tone,
  valueClass,
}: {
  icon: React.ReactNode
  value: number
  label: string
  tone: string
  valueClass: string
}) {
  return (
    <div className="card">
      <span className={`icon-badge icon-badge-${tone}`} aria-hidden="true">
        {icon}
      </span>
      <p className={`mt-3 font-display text-3xl leading-none font-semibold ${valueClass}`}>
        {value.toLocaleString()}
      </p>
      <p className="mt-1.5 text-xs leading-snug text-text-muted">{label}</p>
    </div>
  )
}

/** Absolute date; "3 days ago" is vaguer than a sync timestamp needs to be. */
function formatSyncedAt(iso: string | null): string {
  if (!iso) return 'Not synced yet'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Not synced yet'
  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function ChevronIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      className="h-4 w-4 flex-shrink-0 text-text-muted"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
    </svg>
  )
}

export default async function MePage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: creator, error: creatorError } = await supabase
    .from('creators')
    .select(
      'id, display_name, channel_url, subscriber_count, channel_video_count, channel_stats_updated_at, channel_videos_synced_count'
    )
    .eq('user_id', user.id)
    .maybeSingle()

  if (creatorError) {
    logError('page.me', creatorError, { user_id: user.id, stage: 'fetch_creator' })
  }

  // --- All-time stats. Same shape as Agent Home's: posts for this creator, the
  // comments on them, then reward events via this creator's audience members.
  // Every read is scoped by creator_id or by ids derived from it. ---
  let totalComments = 0
  let videosAnalyzed = 0
  let peopleRecognized = 0

  if (creator?.id) {
    const { data: posts } = await supabase
      .from('posts')
      .select('id')
      .eq('creator_id', creator.id)

    const postIds = (posts || []).map(p => p.id)
    videosAnalyzed = postIds.length

    if (postIds.length > 0) {
      // head + exact count: the number is all that's wanted here, so the rows
      // themselves never cross the wire and the 1000-row page cap is irrelevant.
      const { count } = await supabase
        .from('comments')
        .select('*', { count: 'exact', head: true })
        .in('post_id', postIds)
      totalComments = count ?? 0
    }

    const { data: members } = await supabase
      .from('audience_members')
      .select('id')
      .eq('creator_id', creator.id)

    const memberIds = (members || []).map(m => m.id)

    if (memberIds.length > 0) {
      // Distinct people, not events: someone recognized three times is one person
      // here, which is what "people recognized" says.
      const events = await fetchInBatches<{ audience_member_id: string }>(supabase, {
        table: 'reward_events',
        select: 'audience_member_id',
        inColumn: 'audience_member_id',
        inValues: memberIds,
      })
      peopleRecognized = new Set(events.map(e => e.audience_member_id)).size
    }
  }

  const displayName = creator?.display_name || user.email || 'Your account'
  // display_name is frequently the signup email, in which case printing both would
  // just repeat the same string twice.
  const showEmailSeparately = Boolean(user.email) && user.email !== displayName

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <section className="flex flex-col items-center pt-2 text-center">
        <MascotIcon type="agent" />
        {/* break-words: displayName is usually an email — one unbreakable token. */}
        <h1 className="mt-4 font-display text-xl leading-tight font-semibold break-words text-text-primary">
          {displayName}
        </h1>
        {showEmailSeparately && (
          <p className="mt-1 text-sm break-words text-text-muted">{user.email}</p>
        )}
        <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-green/30 bg-green-dim px-3 py-1 font-mono text-[10px] tracking-wide text-green uppercase">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-green" />
          Signed in
        </p>
      </section>

      <section aria-labelledby="stats-snapshot">
        <h2
          id="stats-snapshot"
          className="font-mono text-[10px] tracking-widest text-text-muted uppercase"
        >
          All time
        </h2>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <StatCard
            tone="purple"
            valueClass="text-purple-text"
            value={totalComments}
            label="Comments understood"
            icon={
              <svg {...linkIconProps}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12c0 2.104.859 4.023 2.273 5.48.432.447.74 1.04.586 1.641a4.483 4.483 0 0 1-.923 1.785A5.969 5.969 0 0 0 6 21c1.282 0 2.47-.402 3.445-1.087.81.22 1.668.337 2.555.337Z"
                />
              </svg>
            }
          />
          <StatCard
            tone="green"
            valueClass="text-green"
            value={peopleRecognized}
            label="People recognized"
            icon={
              <svg {...linkIconProps}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 17.5 2.5 7l5.25 3.75L12 4.5l4.25 6.25L21.5 7 20 17.5zM5 20h14"
                />
              </svg>
            }
          />
          <StatCard
            tone="pink"
            valueClass="text-pink"
            value={videosAnalyzed}
            label="Videos analyzed"
            icon={
              <svg {...linkIconProps}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="m15.75 10.5 4.72-2.36a.75.75 0 0 1 1.08.67v8.38a.75.75 0 0 1-1.08.67l-4.72-2.36M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-7.5A2.25 2.25 0 0 0 13.5 6.75h-9A2.25 2.25 0 0 0 2.25 9v7.5a2.25 2.25 0 0 0 2.25 2.25Z"
                />
              </svg>
            }
          />
        </div>
      </section>

      <section aria-labelledby="connected-channel">
        <h2
          id="connected-channel"
          className="font-mono text-[10px] tracking-widest text-text-muted uppercase"
        >
          Connected channel
        </h2>

        {creator?.channel_url ? (
          <div className="card mt-3">
            {/* break-all: a channel URL is one unbreakable token and will push the
                card past the viewport on a phone without it. */}
            <a
              href={creator.channel_url}
              target="_blank"
              rel="noopener noreferrer"
              className="block font-body text-sm font-medium break-all text-purple-text hover:underline"
            >
              {creator.channel_url}
            </a>

            <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-4">
              <div>
                <dt className="font-mono text-[10px] tracking-widest text-text-muted uppercase">
                  Subscribers
                </dt>
                <dd className="mt-1 font-display text-lg leading-none font-semibold text-text-primary">
                  {creator.subscriber_count === null || creator.subscriber_count === undefined
                    ? '—'
                    : Number(creator.subscriber_count).toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="font-mono text-[10px] tracking-widest text-text-muted uppercase">
                  Videos brought in
                </dt>
                <dd className="mt-1 font-display text-lg leading-none font-semibold text-text-primary">
                  {(creator.channel_videos_synced_count ?? 0).toLocaleString()}
                  {creator.channel_video_count
                    ? ` / ${Number(creator.channel_video_count).toLocaleString()}`
                    : ''}
                </dd>
              </div>
            </dl>

            <p className="mt-4 border-t border-white/10 pt-3 text-xs text-text-muted">
              Last synced {formatSyncedAt(creator.channel_stats_updated_at)}
            </p>
          </div>
        ) : (
          <Link
            href="/dashboard/connect"
            className="card mt-3 flex items-center gap-3 transition-colors hover:border-purple/40 hover:bg-surface-hover"
          >
            <span className="icon-badge icon-badge-purple" aria-hidden="true">
              <svg {...linkIconProps}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"
                />
              </svg>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-body text-sm font-medium text-text-primary">
                Connect a channel
              </span>
              <span className="mt-0.5 block text-xs leading-snug text-text-muted">
                No channel connected yet — paste your link to get started
              </span>
            </span>
            <ChevronIcon />
          </Link>
        )}
      </section>

      <nav className="space-y-3" aria-label="Account">
        {ACCOUNT_LINKS.map(link => (
          <Link
            key={link.href}
            href={link.href}
            className="flex items-center gap-3 rounded-xl border border-white/10 bg-surface p-4 transition-colors hover:border-purple/40 hover:bg-surface-hover"
          >
            <span className={`icon-badge icon-badge-${link.tone}`} aria-hidden="true">
              {link.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-body text-sm font-medium text-text-primary">
                {link.label}
              </span>
              <span className="mt-0.5 block text-xs leading-snug text-text-muted">
                {link.description}
              </span>
            </span>
            <ChevronIcon />
          </Link>
        ))}
      </nav>

      <DataControls />

      <LogoutButton />

      <p className="pb-2 text-center text-xs text-text-muted">
        Need help?{' '}
        <a
          href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Notice — support request')}`}
          className="text-purple-text underline hover:text-text-primary"
        >
          Contact us
        </a>
      </p>
    </div>
  )
}
