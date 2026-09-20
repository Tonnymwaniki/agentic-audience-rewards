import { CATEGORY_ORDER, CATEGORY_STYLES } from '@/lib/comment-categories'

// No 'use client': pure markup, so this ships no JavaScript.

export type CategoryCounts = Record<string, number>

/**
 * A one-glance answer to "what is in my comments?" — a single stacked bar plus a
 * legend of counts.
 *
 * Deliberately NOT a report. Agent Home is a scan-in-two-seconds page, so this
 * stays one bar and one wrapped row of numbers; the full breakdowns live on the
 * video detail page and in Research.
 */
export default function CategoryBreakdown({ counts }: { counts: CategoryCounts }) {
  // Only categories that actually occur, in the same order the video detail page
  // lists them — an empty "Spam 0" chip is noise on a page built for scanning.
  const present = CATEGORY_ORDER.filter(key => (counts[key] ?? 0) > 0).map(key => ({
    key,
    count: counts[key],
    ...CATEGORY_STYLES[key],
  }))

  const total = present.reduce((sum, item) => sum + item.count, 0)

  // Nothing categorized yet: the stat cards above already say the agent has read
  // nothing, so a second empty state here would just repeat them.
  if (total === 0) return null

  return (
    <section className="card">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-mono text-[10px] tracking-widest text-text-muted uppercase">
          What your audience says
        </p>
        {/* The stat cards above this are a 24-hour window; this is every comment
            ever categorized. Saying so prevents reading the two as one number. */}
        <p className="flex-shrink-0 text-xs text-text-muted">
          All time · <span className="font-medium text-text-primary tabular-nums">{total.toLocaleString()}</span>
        </p>
      </div>

      {/* The bar is decorative — every number it encodes is in the legend below,
          so a screen reader gets the data without parsing widths. */}
      <div
        aria-hidden="true"
        className="mt-3 flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-white/5"
      >
        {present.map(item => (
          <span
            key={item.key}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{
              // minWidth keeps a single-comment category from rounding away to
              // nothing against a few thousand others — it stays a visible sliver.
              width: `${(item.count / total) * 100}%`,
              minWidth: '3px',
              backgroundColor: item.accent,
            }}
          />
        ))}
      </div>

      <ul className="mt-3 flex flex-wrap gap-x-3.5 gap-y-2">
        {present.map(item => (
          <li key={item.key} className="flex items-center gap-1.5 text-xs">
            <span
              aria-hidden="true"
              className="h-2 w-2 flex-shrink-0 rounded-full"
              style={{ backgroundColor: item.accent }}
            />
            <span className="text-text-muted">{item.label}</span>
            <span className="font-medium text-text-primary tabular-nums">
              {item.count.toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
