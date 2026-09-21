import Link from 'next/link'
import type { ActivityItem } from '@/lib/activity'
import MascotIcon from '@/components/MascotIcon'
import NotificationBell from '@/components/NotificationBell'
import CategoryBreakdown, { type CategoryCounts, type VideoBreakdown } from './CategoryBreakdown'
import RecognizedPeople, { type RecognizedPerson } from './RecognizedPeople'
import BestTimeToPost from './BestTimeToPost'
import type { ActivityWindow, WeekdayActivity, HourActivity, LatencyBucket } from '@/lib/timing'

// Laid out mobile-first: the base classes ARE the phone design (single column,
// 2-up stat grid, full-bleed cards), and the `sm:`/`lg:` overrides widen it for
// desktop. Nothing here is a shrunken desktop layout.
//
// Note: no 'use client'. The actionable draft cards moved to the notification
// inbox, so nothing on this page needs interactivity and it ships no JS.
type AgentSummaryProps = {
  greeting: string
  creatorDisplayName: string
  lastActivityAt: string | null
  commentsReadCount: number
  draftsWrittenCount: number
  recognizedCount: number
  totalCommentsCount: number
  categoryCounts: CategoryCounts
  videoBreakdowns: VideoBreakdown[]
  recognizedPeople: RecognizedPerson[]
  activityWindows: ActivityWindow[]
  datedCommentCount: number
  weekdayActivity: WeekdayActivity[]
  hourlyActivity: HourActivity[]
  latencyBuckets: LatencyBucket[]
  latencyTotal: number
  latencySkipped: number
  totalDraftsCount: number
  totalRecognizedCount: number
  repliesReadyCount: number
  purchaseIntentReadyCount: number
  activity: ActivityItem[]
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

// --- Icons ---------------------------------------------------------------

const iconProps = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  className: 'h-5 w-5',
} as const

function CommentIcon() {
  return (
    <svg {...iconProps}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm3.75 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm3.75 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z"
      />
    </svg>
  )
}

function DraftIcon() {
  return (
    <svg {...iconProps}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10"
      />
    </svg>
  )
}

function InboxIcon() {
  return (
    <svg {...iconProps}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H6.911a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661Z"
      />
    </svg>
  )
}

function RecognizedIcon() {
  return (
    <svg {...iconProps}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.5 18.75h-9m9 0a3 3 0 0 1 3 3h-15a3 3 0 0 1 3-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 0 1-.982-3.172M9.497 14.25a7.454 7.454 0 0 0 .981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 0 0 7.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M7.73 9.728a6.726 6.726 0 0 0 2.748 1.35m8.272-6.842V4.5c0 2.108-.966 3.99-2.48 5.228m2.48-5.492a46.32 46.32 0 0 1 2.916.52 6.003 6.003 0 0 1-5.395 4.972m0 0a6.726 6.726 0 0 1-2.749 1.35m0 0a6.772 6.772 0 0 1-3.044 0"
      />
    </svg>
  )
}

// A little face-in-a-screen: reads as "agent" without needing an emoji glyph,
// which renders inconsistently across Android/iOS/desktop.
function RobotIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      className="h-6 w-6"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 2.75v2.5" />
      <circle cx="12" cy="2" r="1" fill="currentColor" stroke="none" />
      <rect x="3.25" y="5.25" width="17.5" height="13" rx="3.25" />
      <circle cx="8.75" cy="11.25" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="15.25" cy="11.25" r="1.35" fill="currentColor" stroke="none" />
      <path strokeLinecap="round" d="M9.5 14.75h5" />
      <path strokeLinecap="round" d="M1.75 10v3.5M22.25 10v3.5" />
    </svg>
  )
}

function ArrowIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
    </svg>
  )
}

// --- Pieces ---------------------------------------------------------------

type Tone = 'purple' | 'pink' | 'teal' | 'green' | 'gold'

// Every tone here must have a matching .icon-badge-<tone> rule in globals.css.
const TONE_TEXT: Record<Tone, string> = {
  purple: 'text-purple-text',
  pink: 'text-pink',
  teal: 'text-teal',
  green: 'text-green',
  gold: 'text-gold-light',
}

function StatCard({
  icon,
  value,
  label,
  tone,
}: {
  icon: React.ReactNode
  value: number
  label: string
  tone: Tone
}) {
  return (
    <div className="card">
      <span className={`icon-badge icon-badge-${tone}`} aria-hidden="true">
        {icon}
      </span>
      <p className={`mt-3 font-display text-3xl leading-none font-semibold ${TONE_TEXT[tone]}`}>
        {value.toLocaleString()}
      </p>
      <p className="mt-1.5 text-xs leading-snug text-text-muted">{label}</p>
    </div>
  )
}

const QUICK_ACTIONS: Array<{ href: string; label: string; description: string; tone: Tone }> = [
  {
    href: '/dashboard/notifications',
    label: 'Review replies',
    description: 'Approve the drafts waiting on you',
    tone: 'purple',
  },
  {
    href: '/dashboard/research',
    label: 'Ask research question',
    description: 'Chat with your audience data',
    tone: 'pink',
  },
  {
    // The connect flow is otherwise only reachable from the Me page, which is a
    // detour for the common case of pulling in new uploads. Agent Home is where a
    // returning creator lands, so the route back to Connect belongs here too.
    href: '/dashboard/connect',
    label: 'Analyze more videos',
    description: 'Pull in new uploads or another channel',
    tone: 'gold',
  },
]

const ACTIVITY_TONE: Record<ActivityItem['kind'], { dot: string; label: string }> = {
  notification: { dot: 'bg-pink', label: 'Alert' },
  pending_draft: { dot: 'bg-purple', label: 'Draft' },
  reward: { dot: 'bg-teal', label: 'Reward' },
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const tone = ACTIVITY_TONE[item.kind]
  return (
    <li className="flex items-start gap-3 py-3">
      <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-relaxed text-text-primary">{item.text}</p>
        <p className="mt-0.5 font-mono text-[10px] tracking-wide text-text-muted uppercase">
          {tone.label}
          {item.at ? ` · ${timeAgo(item.at)}` : ''}
        </p>
      </div>
    </li>
  )
}

// --- Page -----------------------------------------------------------------

export default function AgentSummary({
  greeting,
  creatorDisplayName,
  lastActivityAt,
  commentsReadCount,
  draftsWrittenCount,
  recognizedCount,
  totalCommentsCount,
  categoryCounts,
  videoBreakdowns,
  recognizedPeople,
  activityWindows,
  datedCommentCount,
  weekdayActivity,
  hourlyActivity,
  latencyBuckets,
  latencyTotal,
  latencySkipped,
  totalDraftsCount,
  totalRecognizedCount,
  repliesReadyCount,
  purchaseIntentReadyCount,
  activity,
}: AgentSummaryProps) {
  const quietDay = commentsReadCount === 0 && draftsWrittenCount === 0 && recognizedCount === 0

  return (
    <div className="space-y-5">
      {/* Page title and the bell on ONE row. The bell used to live in the shared
          nav, which put it on a separate line above the title and left both lines
          mostly empty. Moving it here also lets that nav disappear entirely on this
          route, so the page starts higher than before. */}
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold text-text-primary">My Agent</h1>
        <NotificationBell />
      </div>

      {/* --- Mobile hero. Desktop already leads with the "Your Agent" card beside
              the greeting, so the mascot would be a third robot up there. --- */}
      <div className="flex flex-col items-center pt-2 text-center md:hidden">
        {/* 132px = 1.5x the component's 88px default. It is the first thing on the
            page, so it carries the "your agent is alive" idea before any text. */}
        <MascotIcon type="agent" size={132} />
        <p className="mt-3 text-sm text-text-muted">Your AI agent is working for you</p>
      </div>

      {/* --- Greeting --- */}
      <header>
        {/* break-words matters here because creatorDisplayName falls back to the
            signup email when display_name is unset, and an address like
            "someone@example.com" is a single unbreakable token — at this font size
            it overran a 320px viewport and forced the page to scroll sideways. */}
        <h1 className="font-display text-2xl leading-tight font-semibold break-words text-text-primary sm:text-3xl">
          {greeting}, {creatorDisplayName}{' '}
          <span aria-hidden="true" className="inline-block">
            👋
          </span>
        </h1>
        <p className="mt-1.5 text-sm leading-relaxed text-text-muted">
          {quietDay ? (
            <>
              Nothing new in the last 24 hours. All time:{' '}
              <span className="font-medium text-text-primary">{totalCommentsCount.toLocaleString()}</span>{' '}
              comment{totalCommentsCount === 1 ? '' : 's'} read,{' '}
              <span className="font-medium text-text-primary">{totalDraftsCount.toLocaleString()}</span> repl
              {totalDraftsCount === 1 ? 'y' : 'ies'} drafted,{' '}
              <span className="font-medium text-text-primary">{totalRecognizedCount.toLocaleString()}</span>{' '}
              {totalRecognizedCount === 1 ? 'person' : 'people'} recognized.
            </>
          ) : (
            <>Here&apos;s what your agent has been doing while you were away.</>
          )}
        </p>
      </header>

      {/* --- Agent status: full width and prominent on mobile --- */}
      <section className="card glow-card-strong flex items-center gap-4 py-5">
        {/* Hidden below md: the mascot hero above already shows the agent there,
            and two robot faces on one phone screen reads as a duplicate. */}
        <span
          className="gradient-primary hidden h-14 w-14 flex-shrink-0 items-center justify-center rounded-xl text-white md:flex"
          aria-hidden="true"
        >
          <RobotIcon />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] tracking-widest text-text-muted uppercase">Your Agent</p>
          <div className="mt-1.5 flex items-center gap-2.5">
            {/* text-green rather than bg-green: .status-dot's expanding ring is
                painted with currentColor, so the colour has to come from the text
                colour for the ring to match the dot. */}
            <span
              aria-hidden="true"
              className="status-dot h-2.5 w-2.5 flex-shrink-0 rounded-full bg-current text-green"
            />
            <span className="font-display text-xl leading-none font-semibold text-text-primary sm:text-2xl">
              Active
            </span>
          </div>
          <p className="mt-1.5 truncate text-sm text-text-muted">
            {lastActivityAt ? `Last activity ${timeAgo(lastActivityAt)}` : 'No activity recorded yet'}
          </p>
        </div>
      </section>

      {/* --- Stats: 2-up on phones, 4-up once there's room --- */}
      <section>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
          <StatCard icon={<CommentIcon />} value={commentsReadCount} label="Comments read" tone="purple" />
          <StatCard icon={<DraftIcon />} value={draftsWrittenCount} label="Replies drafted" tone="pink" />
          <StatCard icon={<InboxIcon />} value={repliesReadyCount} label="Replies ready" tone="teal" />
          <StatCard icon={<RecognizedIcon />} value={recognizedCount} label="People recognized" tone="green" />
        </div>
        <p className="mt-2 text-xs text-text-muted">
          Last 24 hours — except <span className="text-text-primary">Replies ready</span>, which is
          everything still awaiting your approval.
        </p>
      </section>

      {/* --- Category mix. Sits directly under the stats because it answers the
              obvious follow-up to "N comments read": read of what? Renders nothing
              until something has been categorized. --- */}
      <CategoryBreakdown counts={categoryCounts} videos={videoBreakdowns} />

      {/* --- Best time to post. Same shared computation the Research chat's
              get_timing_insights tool uses, so the two always agree. --- */}
      <BestTimeToPost
        windows={activityWindows}
        weekdays={weekdayActivity}
        hours={hourlyActivity}
        latency={latencyBuckets}
        latencyTotal={latencyTotal}
        latencySkipped={latencySkipped}
        totalComments={datedCommentCount}
      />

      {/* --- Opportunities banner. Hidden entirely when there's nothing to act on,
              rather than showing an encouraging-but-empty prompt. --- */}
      {purchaseIntentReadyCount > 0 && (
        <section className="gradient-primary relative overflow-hidden rounded-xl p-5">
          <div className="relative">
            <p className="font-display text-lg leading-tight font-semibold text-white">
              {purchaseIntentReadyCount} quick{' '}
              {purchaseIntentReadyCount === 1 ? 'opportunity' : 'opportunities'}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-white/85">
              {purchaseIntentReadyCount === 1
                ? 'Someone asked about buying and a reply is already drafted.'
                : `${purchaseIntentReadyCount} people asked about buying and replies are already drafted.`}
            </p>
            <Link
              href="/dashboard/notifications"
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-[#151530] transition-colors hover:bg-white/90"
            >
              Check them out
              <ArrowIcon />
            </Link>
          </div>
        </section>
      )}

      {/* --- Quick actions --- */}
      <section className="card">
        <h2 className="mb-3 font-display text-base font-semibold text-text-primary">Quick Actions</h2>
        {/* 2x2 rather than 4-across: at max-w-5xl a four-column row leaves ~185px
            of text per card, which wraps "Analyze more videos" onto three lines.
            Three columns would strand the fourth action alone on a second row. */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {QUICK_ACTIONS.map(action => (
            <Link
              key={action.href}
              href={action.href}
              className="group flex items-center gap-3 rounded-lg border border-white/10 bg-surface-hover p-3 transition-colors hover:border-purple/50"
            >
              <span className={`icon-badge icon-badge-${action.tone}`} aria-hidden="true">
                <ArrowIcon />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-body text-sm font-medium text-text-primary">{action.label}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-text-muted">
                  {action.description}
                </span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* Both "Needs Your Attention" sections that used to sit here — the drafted
          replies and the escalated comments — now live in the notification inbox,
          which renders the same cards with the same Approve/Copy actions. Keeping a
          second copy on Agent Home meant approving in one place left the other
          showing stale work. The Quick Action above is the way in. */}

      {/* --- Recent activity --- */}
      <section className="card">
        <h2 className="mb-3 font-display text-base font-semibold text-text-primary">Recent Activity</h2>

        {/* People first, then the text stream. Recognitions are the part of this
            feed a creator actually wants to look at, and a person with a level is
            worth a card; the rest stays one line each. Reward lines are no longer
            passed into the text feed, so nothing is said twice. */}
        <RecognizedPeople people={recognizedPeople} />

        {activity.length === 0 && recognizedPeople.length === 0 ? (
          <p className="py-3 text-sm text-text-muted">
            Nothing yet. Alerts, drafted replies and rewards will show up here as your agent works.
          </p>
        ) : activity.length === 0 ? null : (
          <ul className="divide-y divide-white/5">
            {activity.map((item, i) => (
              <ActivityRow key={i} item={item} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
