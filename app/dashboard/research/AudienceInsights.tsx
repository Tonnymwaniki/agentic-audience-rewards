import { INTEREST_COLORS, type SidebarInterest, type SidebarTrendingTopic } from './ResearchSidebar'

// Horizontal bars for the category mix, and a numbered list for trending topics.
// Shared between the desktop sidebar and the mobile Research landing view so the
// two can't drift apart.

function truncate(text: string, max: number): string {
  const clean = text.trim().replace(/\s+/g, ' ')
  return clean.length > max ? `${clean.slice(0, max).trim()}…` : clean
}

export function InterestBars({ interests }: { interests: SidebarInterest[] }) {
  if (interests.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-text-muted">
        Once your comments are analyzed, the mix of what people talk about shows up here.
      </p>
    )
  }

  return (
    <ul className="space-y-3">
      {interests.map((interest, i) => {
        const color = INTEREST_COLORS[i % INTEREST_COLORS.length]
        return (
          <li key={interest.category}>
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <span className="truncate text-sm text-text-primary">{interest.label}</span>
              <span className="flex-shrink-0 font-mono text-xs" style={{ color }}>
                {interest.percentage}%
              </span>
            </div>
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-surface-hover"
              role="img"
              aria-label={`${interest.label}: ${interest.percentage} percent, ${interest.count} comments`}
            >
              <div
                className="h-full rounded-full"
                // A zero-width bar would vanish; 2% keeps a visible sliver so a
                // small-but-real category still reads as present.
                style={{ width: `${Math.max(interest.percentage, 2)}%`, background: color }}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export function TrendingList({ topics }: { topics: SidebarTrendingTopic[] }) {
  if (topics.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-text-muted">
        Nothing repeated yet — a topic lands here once two or more different people say the same
        thing.
      </p>
    )
  }

  return (
    <ol className="space-y-3">
      {topics.map((topic, i) => {
        const color = INTEREST_COLORS[i % INTEREST_COLORS.length]
        return (
          <li key={i} className="flex items-start gap-3">
            <span
              className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg font-mono text-[11px] font-medium"
              style={{ background: 'var(--surface-hover)', color }}
              aria-hidden="true"
            >
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm leading-snug text-text-primary">{truncate(topic.text, 80)}</p>
              <p className="mt-0.5 font-mono text-[10px] text-text-muted">
                {topic.percentage}% of repeats · {topic.unique_people}{' '}
                {topic.unique_people === 1 ? 'person' : 'people'}
              </p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
