import Link from 'next/link'
import { InterestBars, TrendingList } from './AudienceInsights'

export type SidebarTrendingTopic = {
  text: string
  count: number
  unique_people: number
  percentage: number
}

export type SidebarInterest = {
  category: string
  label: string
  count: number
  percentage: number
}

export type SidebarInsight = {
  kind: 'notification' | 'pending_draft' | 'reward'
  text: string
  at: string | null
}

export type SidebarOverview = {
  totalPeople: number
  totalComments: number
  activeThisWeek: number
  isPlaceholder: boolean
}

export type SidebarSentiment = {
  positive: number
  neutral: number
  negative: number
  isPlaceholder: boolean
}

export type ResearchSidebarData = {
  overview: SidebarOverview
  trending: SidebarTrendingTopic[]
  interests: SidebarInterest[]
  sentiment: SidebarSentiment
  insights: SidebarInsight[]
}

// One accent per rank, reused by the sidebar and the mobile insights card so a
// given row is the same colour in both places.
export const INTEREST_COLORS = [
  'var(--purple)',
  'var(--pink)',
  'var(--teal)',
  'var(--green)',
  '#F59E0B',
] as const

function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (isNaN(then)) return ''

  const minutes = Math.round((Date.now() - then) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`

  return `${Math.round(days / 30)}mo ago`
}

function truncate(text: string, max: number): string {
  const clean = text.trim().replace(/\s+/g, ' ')
  return clean.length > max ? `${clean.slice(0, max).trim()}…` : clean
}

function SidebarCard({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="card">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="font-mono text-[10px] uppercase tracking-widest text-text-muted">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

// Marks a card whose numbers aren't wired to real data yet, so nobody mistakes a
// placeholder for a measurement.
function PlaceholderTag() {
  return (
    <span className="rounded-full border border-white/10 bg-surface-hover px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-text-muted">
      Sample
    </span>
  )
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p className="text-xs leading-relaxed text-text-muted">{children}</p>
}

function OverviewCard({ overview }: { overview: SidebarOverview }) {
  const stats = [
    { label: 'People', value: overview.totalPeople },
    { label: 'Comments', value: overview.totalComments },
    { label: 'Active 7d', value: overview.activeThisWeek },
  ]

  return (
    <SidebarCard
      title="Audience overview"
      action={overview.isPlaceholder ? <PlaceholderTag /> : undefined}
    >
      <div className="grid grid-cols-3 gap-3">
        {stats.map(stat => (
          <div key={stat.label}>
            <p className="font-display text-xl font-semibold text-purple-text">
              {stat.value.toLocaleString()}
            </p>
            <p className="mt-0.5 font-mono text-[10px] leading-tight text-text-muted">{stat.label}</p>
          </div>
        ))}
      </div>
    </SidebarCard>
  )
}

function TrendingCard({ topics }: { topics: SidebarTrendingTopic[] }) {
  return (
    <SidebarCard title="Trending topics">
      <TrendingList topics={topics} />
    </SidebarCard>
  )
}

function InterestsCard({ interests }: { interests: SidebarInterest[] }) {
  return (
    <SidebarCard title="Audience insights">
      <InterestBars interests={interests} />
    </SidebarCard>
  )
}

// Pure-CSS donut: a conic-gradient ring with the surface colour punched out of the
// middle. Avoids pulling a charting library in for one small graphic.
function SentimentCard({ sentiment }: { sentiment: SidebarSentiment }) {
  const segments = [
    { label: 'Positive', value: sentiment.positive, color: 'var(--purple)' },
    { label: 'Neutral', value: sentiment.neutral, color: 'var(--text-muted)' },
    { label: 'Negative', value: sentiment.negative, color: 'var(--avax-red)' },
  ]

  const total = segments.reduce((sum, s) => sum + s.value, 0) || 1

  let cursor = 0
  const stops = segments
    .map(segment => {
      const start = (cursor / total) * 100
      cursor += segment.value
      const end = (cursor / total) * 100
      return `${segment.color} ${start}% ${end}%`
    })
    .join(', ')

  return (
    <SidebarCard
      title="Audience sentiment"
      action={sentiment.isPlaceholder ? <PlaceholderTag /> : undefined}
    >
      <div className="flex items-center gap-4">
        <div
          className="relative h-20 w-20 flex-shrink-0 rounded-full"
          style={{ background: `conic-gradient(${stops})` }}
          role="img"
          aria-label={segments.map(s => `${s.label} ${s.value}%`).join(', ')}
        >
          <div className="absolute inset-[26%] rounded-full bg-surface" />
        </div>
        <ul className="min-w-0 flex-1 space-y-1.5">
          {segments.map(segment => (
            <li key={segment.label} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="h-2 w-2 flex-shrink-0 rounded-full"
                style={{ background: segment.color }}
              />
              <span className="flex-1 truncate text-xs text-text-primary">{segment.label}</span>
              <span className="font-mono text-[10px] text-text-muted">{segment.value}%</span>
            </li>
          ))}
        </ul>
      </div>
    </SidebarCard>
  )
}

const INSIGHT_ACCENT: Record<SidebarInsight['kind'], string> = {
  notification: 'border-pink',
  pending_draft: 'border-purple',
  reward: 'border-avax-red',
}

function InsightsCard({ insights }: { insights: SidebarInsight[] }) {
  return (
    <SidebarCard
      title="Recent insights"
      action={
        <Link href="/dashboard/highlights" className="text-[10px] text-purple-text hover:underline">
          Highlights
        </Link>
      }
    >
      {insights.length === 0 ? (
        <EmptyLine>
          Nothing new yet. Alerts, drafted replies waiting on you, and rewards you’ve issued
          will collect here.
        </EmptyLine>
      ) : (
        <ul className="space-y-2.5">
          {insights.map((insight, i) => (
            <li key={i} className={`border-l-2 pl-2.5 ${INSIGHT_ACCENT[insight.kind]}`}>
              <p className="text-xs leading-relaxed text-text-primary">{truncate(insight.text, 110)}</p>
              {insight.at && (
                <p className="mt-0.5 font-mono text-[10px] text-text-muted">{relativeTime(insight.at)}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </SidebarCard>
  )
}

/**
 * The persistent context panel beside the Research chat. Purely presentational —
 * every number is fetched server-side in page.tsx and passed in.
 */
export default function ResearchSidebar({ data }: { data: ResearchSidebarData }) {
  return (
    <aside className="space-y-4" aria-label="Audience context">
      <OverviewCard overview={data.overview} />
      <InterestsCard interests={data.interests} />
      <TrendingCard topics={data.trending} />
      <SentimentCard sentiment={data.sentiment} />
      <InsightsCard insights={data.insights} />
    </aside>
  )
}
