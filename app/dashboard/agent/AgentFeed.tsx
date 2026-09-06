import Link from 'next/link'
import type { Highlight } from '@/lib/highlights'
import AttentionList from './AttentionList'

// Note: no 'use client'. Only the attention cards need interactivity (Approve /
// Copy), and those live in AttentionList — everything else here is server-rendered
// and ships no JS.
type AgentSummaryProps = {
  greeting: string
  creatorDisplayName: string
  lastActivityAt: string | null
  commentsReadCount: number
  draftsWrittenCount: number
  recognizedCount: number
  totalCommentsCount: number
  totalDraftsCount: number
  totalRecognizedCount: number
  pendingHighlightsCount: number
  attentionItems: Highlight[]
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

function IconWrapper({ children, tint }: { children: React.ReactNode; tint: string }) {
  return (
    <span
      className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg"
      style={{ background: tint }}
      aria-hidden="true"
    >
      {children}
    </span>
  )
}

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

// --- Sections ------------------------------------------------------------

function StatCard({
  icon,
  value,
  label,
  accent,
  tint,
}: {
  icon: React.ReactNode
  value: number
  label: string
  accent: string
  tint: string
}) {
  return (
    <div className="card" style={{ borderColor: tint }}>
      <span style={{ color: accent }}>
        <IconWrapper tint={tint}>{icon}</IconWrapper>
      </span>
      <p className="font-display text-3xl font-semibold" style={{ color: accent }}>
        {value.toLocaleString()}
      </p>
      <p className="mt-0.5 text-xs text-text-muted">{label}</p>
    </div>
  )
}

const QUICK_ACTIONS = [
  {
    href: '/dashboard/highlights',
    label: 'Review replies',
    description: 'Approve the drafts waiting on you',
  },
  {
    href: '/dashboard/research',
    label: 'Ask research question',
    description: 'Chat with your audience data',
  },
  {
    href: '/dashboard/brain',
    label: 'View audience insights',
    description: 'Themes, timing and who keeps showing up',
  },
]

export default function AgentSummary({
  greeting,
  creatorDisplayName,
  lastActivityAt,
  commentsReadCount,
  draftsWrittenCount,
  recognizedCount,
  totalCommentsCount,
  totalDraftsCount,
  totalRecognizedCount,
  pendingHighlightsCount,
  attentionItems,
}: AgentSummaryProps) {
  const quietDay = commentsReadCount === 0 && draftsWrittenCount === 0 && recognizedCount === 0

  return (
    <div className="space-y-6">
      {/* --- Greeting + agent status --- */}
      <section className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-semibold text-text-primary">
            {greeting}, {creatorDisplayName}
          </h1>
          <p className="mt-1 text-sm leading-relaxed text-text-muted">
            {quietDay ? (
              <>
                Nothing new in the last 24 hours. Since you started, your agent has read{' '}
                <span className="font-medium text-text-primary">{totalCommentsCount.toLocaleString()}</span>{' '}
                comment{totalCommentsCount === 1 ? '' : 's'}, drafted{' '}
                <span className="font-medium text-text-primary">{totalDraftsCount.toLocaleString()}</span> repl
                {totalDraftsCount === 1 ? 'y' : 'ies'}, and recognized{' '}
                <span className="font-medium text-text-primary">{totalRecognizedCount.toLocaleString()}</span>{' '}
                {totalRecognizedCount === 1 ? 'person' : 'people'}.
              </>
            ) : (
              <>Your agent has been reading comments, drafting replies and spotting people worth recognizing.</>
            )}
          </p>
        </div>

        <div className="card flex-shrink-0 sm:w-56">
          <p className="font-mono text-[10px] uppercase tracking-widest text-text-muted">Your Agent</p>
          <div className="mt-2 flex items-center gap-2">
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-green-400" />
            <span className="font-body text-sm font-medium text-text-primary">Active</span>
          </div>
          <p className="mt-1.5 text-xs text-text-muted">
            {lastActivityAt ? `Last activity ${timeAgo(lastActivityAt)}` : 'No activity recorded yet'}
          </p>
        </div>
      </section>

      {/* --- Stats (rolling 24h) --- */}
      <section>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatCard
            icon={<CommentIcon />}
            value={commentsReadCount}
            label="comments read"
            accent="var(--cobalt)"
            tint="rgba(0, 56, 255, 0.18)"
          />
          <StatCard
            icon={<DraftIcon />}
            value={draftsWrittenCount}
            label="replies drafted"
            accent="var(--pink)"
            tint="var(--pink-dim)"
          />
          <StatCard
            icon={<RecognizedIcon />}
            value={recognizedCount}
            label="people recognized"
            accent="#F59E0B"
            tint="rgba(245, 158, 11, 0.18)"
          />
        </div>
        <p className="mt-2 font-mono text-[10px] uppercase tracking-wide text-text-muted">
          Last 24 hours
        </p>
      </section>

      {/* --- Quick actions --- */}
      <section className="card">
        <h2 className="mb-3 font-display text-base font-semibold text-text-primary">Quick Actions</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {QUICK_ACTIONS.map(action => (
            <Link
              key={action.href}
              href={action.href}
              className="group rounded-lg border border-white/10 bg-surface-hover p-3 transition-colors hover:border-cobalt/50"
            >
              <span className="flex items-center justify-between gap-2 font-body text-sm font-medium text-text-primary">
                {action.label}
                <span aria-hidden="true" className="text-text-muted transition-colors group-hover:text-cobalt">
                  →
                </span>
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-text-muted">
                {action.description}
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* --- Needs your attention (preview of Highlights) --- */}
      <section className="card">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-display text-base font-semibold text-text-primary">
            Needs Your Attention
            {pendingHighlightsCount > 0 && (
              <span className="ml-2 rounded-full bg-cobalt px-2 py-0.5 font-mono text-[10px] text-white">
                {pendingHighlightsCount}
              </span>
            )}
          </h2>
          <Link href="/dashboard/highlights" className="flex-shrink-0 text-xs text-cobalt hover:underline">
            View all →
          </Link>
        </div>
        <AttentionList items={attentionItems} />
      </section>
    </div>
  )
}
