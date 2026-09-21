import { EAT_LABEL, type ActivityWindow, type WeekdayActivity } from '@/lib/timing'

// No 'use client': the curve is plain SVG, so this still ships no JavaScript.

/** Below this there isn't enough signal for "busiest hour" to mean anything. */
const MIN_COMMENTS = 10

const CHART_W = 300
const CHART_H = 96
const PAD_X = 10
const PAD_TOP = 10
const PAD_BOTTOM = 8

/**
 * A Catmull-Rom spline through the seven points, emitted as a cubic bezier path.
 *
 * A straight polyline reads as a jagged sawtooth on seven weekly points, which
 * makes small differences look like cliffs. Smoothing states the shape — rises
 * midweek, falls at the weekend — which is what the creator is being asked to see.
 * Tension 0.5 keeps the curve close to the real values rather than overshooting
 * them, so a peak never appears higher than the day that produced it.
 */
function smoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length < 2) return ''
  let d = `M ${points[0].x} ${points[0].y}`

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] ?? p2

    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6

    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x} ${p2.y}`
  }
  return d
}

function WeeklyCurve({ days }: { days: WeekdayActivity[] }) {
  const max = Math.max(...days.map(d => d.count), 1)
  const step = (CHART_W - PAD_X * 2) / (days.length - 1)
  const usableH = CHART_H - PAD_TOP - PAD_BOTTOM

  const points = days.map((d, i) => ({
    x: Math.round(PAD_X + i * step),
    y: Math.round(PAD_TOP + usableH - (d.count / max) * usableH),
    day: d,
  }))

  const line = smoothPath(points)
  // Same curve, closed along the baseline, for the fill underneath.
  const area = `${line} L ${points[points.length - 1].x} ${CHART_H - PAD_BOTTOM} L ${points[0].x} ${CHART_H - PAD_BOTTOM} Z`
  const peak = points.reduce((best, p) => (p.day.count > best.day.count ? p : best), points[0])

  return (
    <div className="mt-3">
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Comment activity by day of week: ${days
          .map(d => `${d.day} ${d.count}`)
          .join(', ')}`}
      >
        <defs>
          <linearGradient id="weekly-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--purple)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--purple)" stopOpacity="0" />
          </linearGradient>
        </defs>

        <path d={area} fill="url(#weekly-fill)" />
        <path
          d={line}
          fill="none"
          stroke="var(--purple-text)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Only the peak gets a dot. Seven markers turn a curve into a dot plot and
            bury the one day the creator is meant to act on. */}
        <circle cx={peak.x} cy={peak.y} r="4.5" fill="var(--purple-text)" />
        <circle cx={peak.x} cy={peak.y} r="8" fill="var(--purple-text)" fillOpacity="0.22" />
      </svg>

      {/* Names what the curve measures. Without it the chart and the headline above
          look like they disagree: the headline reports the busiest single HOUR
          (day + hour bucket), the curve reports total volume per DAY, and the two
          can land on different days — here, a Wednesday lunchtime peak inside a week
          whose busiest day overall is Tuesday. Both are true; only one is labelled. */}
      <p className="mt-1 font-mono text-[10px] tracking-widest text-text-muted/70 uppercase">
        Comments by day
      </p>

      <div className="mt-1 flex justify-between px-[10px]">
        {days.map(d => (
          <span
            key={d.dayIndex}
            className={`font-mono text-[10px] ${
              d.dayIndex === peak.day.dayIndex ? 'text-purple-text' : 'text-text-muted/70'
            }`}
          >
            {d.short}
          </span>
        ))}
      </div>
    </div>
  )
}

export default function BestTimeToPost({
  windows,
  weekdays,
  totalComments,
}: {
  windows: ActivityWindow[]
  weekdays: WeekdayActivity[]
  totalComments: number
}) {
  // A single quiet week would otherwise produce a confident-sounding claim built
  // on three comments. Silence is the honest output until there is a pattern.
  if (windows.length === 0 || totalComments < MIN_COMMENTS) return null

  const top = windows[0]
  // The day with the most comments overall — the curve's peak, which is a different
  // question from the busiest hour above and may well be a different day.
  const busiestDay =
    weekdays.length > 0
      ? weekdays.reduce((best, d) => (d.count > best.count ? d : best), weekdays[0])
      : null

  return (
    <section className="card">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-mono text-[10px] tracking-widest text-text-muted uppercase">
          Best time to post
        </p>
        <p className="flex-shrink-0 text-xs text-text-muted">{EAT_LABEL}</p>
      </div>

      {/* Both facts in one sentence, on purpose.
          The busiest single HOUR and the busiest DAY overall are different
          measurements and often land on different days — a Wednesday lunchtime spike
          inside a week whose total volume peaks on Tuesday. Stated separately, the
          headline and the curve looked like they contradicted each other and left the
          reader to work out which to believe. Stated together they read as what they
          are: when to be at your desk, and when the week is busiest. */}
      <p className="mt-2 text-sm leading-relaxed text-text-primary">
        Your busiest single hour is{' '}
        <span className="font-medium text-purple-text">{top.day}s</span> around{' '}
        <span className="font-medium text-purple-text">
          {top.hourLabel} {EAT_LABEL}
        </span>
        {busiestDay && busiestDay.dayIndex !== top.dayIndex ? (
          <>
            {' '}— but <span className="font-medium text-purple-text">{busiestDay.day}</span> is your
            busiest day overall.
          </>
        ) : busiestDay ? (
          // Same day: "but" would invent a contrast that isn't there.
          <>
            , and <span className="font-medium text-purple-text">{busiestDay.day}</span> is your
            busiest day overall.
          </>
        ) : (
          '.'
        )}
      </p>
      <p className="mt-1 text-xs text-text-muted">
        {top.percentage}% of {totalComments.toLocaleString()} comments landed in that hour
        {busiestDay ? `; ${busiestDay.percentage}% landed on ${busiestDay.day}s` : ''}.
      </p>

      <WeeklyCurve days={weekdays} />
    </section>
  )
}
