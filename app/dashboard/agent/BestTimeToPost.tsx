'use client'

import { useMemo, useState } from 'react'
import {
  EAT_LABEL,
  summarizeLatency,
  type ActivityWindow,
  type HourActivity,
  type LatencyBucket,
  type WeekdayActivity,
} from '@/lib/timing'

/** Below this there isn't enough signal for "busiest hour" to mean anything. */
const MIN_COMMENTS = 10

// Roughly doubled from the previous 300x96. The curve is the point of this card
// now that it carries three views, so it gets the room.
const CHART_W = 360
const CHART_H = 170
const PAD_X = 14
const PAD_TOP = 24
const PAD_BOTTOM = 14

type View = 'day' | 'hour' | 'since_posted'

type Point = {
  x: number
  y: number
  /** Full name for the readout: "Monday", "12 PM EAT", "1–6h". */
  label: string
  /** Axis tick text, kept short. */
  short: string
  count: number
  percentage: number
}

/**
 * A Catmull-Rom spline through the points, emitted as a cubic bezier path.
 *
 * A straight polyline reads as a jagged sawtooth, which makes small differences
 * look like cliffs. Smoothing states the shape — rises midweek, falls at the
 * weekend; dead overnight, busy after lunch — which is what the creator is being
 * asked to see. The control points keep the curve close to the real values, so a
 * peak never appears higher than the point that produced it.
 */
function smoothPath(points: Point[]): string {
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

function ActivityChart({
  points,
  labelEvery,
  selected,
  onSelect,
}: {
  points: Point[]
  /** Show every Nth x-axis label — 24 hourly labels will not fit side by side. */
  labelEvery: number
  selected: number
  onSelect: (index: number) => void
}) {
  const peakIndex = points.reduce((best, p, i) => (p.count > points[best].count ? i : best), 0)
  const line = smoothPath(points)
  const area = `${line} L ${points[points.length - 1].x} ${CHART_H - PAD_BOTTOM} L ${points[0].x} ${CHART_H - PAD_BOTTOM} Z`
  const active = points[selected] ?? points[peakIndex]
  const step = points.length > 1 ? points[1].x - points[0].x : CHART_W
  const selectionIsPeak = selected === peakIndex

  // Keep the readout inside the chart when the selected point sits near an edge.
  const readoutX = Math.min(Math.max(active.x, PAD_X + 74), CHART_W - PAD_X - 74)

  return (
    <div className="mt-3">
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="h-auto w-full touch-manipulation"
        role="img"
        aria-label={`Comment activity: ${points
          .map(p => `${p.label} ${p.count} comments, ${p.percentage}%`)
          .join('; ')}`}
      >
        <defs>
          <linearGradient id="activity-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--purple)" stopOpacity="0.3" />
            <stop offset="100%" stopColor="var(--purple)" stopOpacity="0" />
          </linearGradient>
        </defs>

        <path d={area} fill="url(#activity-fill)" />
        <path
          d={line}
          fill="none"
          stroke="var(--purple-text)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* The creator's own selection, drawn under the peak so the peak always
            wins when they coincide. Purple against the peak's red, with a dashed
            drop-line and a halo ring, so "what I clicked" and "the busiest point"
            are never confused for one another. */}
        {!selectionIsPeak && (
          <>
            <line
              x1={active.x}
              y1={PAD_TOP - 6}
              x2={active.x}
              y2={CHART_H - PAD_BOTTOM}
              stroke="var(--purple-text)"
              strokeOpacity="0.45"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            <circle cx={active.x} cy={active.y} r="8" fill="var(--purple-text)" fillOpacity="0.2" />
            <circle
              cx={active.x}
              cy={active.y}
              r="5"
              fill="var(--purple-text)"
              stroke="var(--background)"
              strokeWidth="1.5"
            />
          </>
        )}

        {/* The peak, in warning red rather than the brand purple: it is the one
            point the creator is meant to act on, and in purple it disappeared into
            the line it sits on. */}
        <circle
          className="chart-peak-pulse"
          cx={points[peakIndex].x}
          cy={points[peakIndex].y}
          r="5"
          fill="var(--avax-red)"
        />
        <circle
          cx={points[peakIndex].x}
          cy={points[peakIndex].y}
          r="5"
          fill="var(--avax-red)"
          stroke="var(--background)"
          strokeWidth="1.5"
        />

        {/* Name, count AND percentage together. The name matters now that any point
            can be selected — "8 comments (15%)" is meaningless without knowing
            which point it belongs to. */}
        <text
          x={readoutX}
          y={13}
          textAnchor="middle"
          className={selectionIsPeak ? 'fill-text-primary font-mono' : 'fill-purple-text font-mono'}
          style={{ fontSize: '11px' }}
        >
          {active.label}: {active.count} {active.count === 1 ? 'comment' : 'comments'} (
          {active.percentage}%)
        </text>

        {/* Full-height hit areas: on a phone the curve itself is far too thin a
            target, so each point owns its whole column. A real <button> inside
            foreignObject would not scale with the viewBox, so these carry the
            keyboard affordances directly. */}
        {points.map((p, i) => (
          <rect
            key={p.label}
            x={p.x - step / 2}
            y={0}
            width={step}
            height={CHART_H}
            fill="transparent"
            className="chart-hit"
            style={{ cursor: 'pointer' }}
            role="button"
            tabIndex={0}
            aria-label={`${p.label}: ${p.count} comments, ${p.percentage}%`}
            aria-pressed={i === selected}
            onClick={() => onSelect(i)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(i)
              }
            }}
          >
            <title>{`${p.label}: ${p.count} comments (${p.percentage}%)`}</title>
          </rect>
        ))}
      </svg>

      <div className="mt-1 flex justify-between px-[14px]">
        {points.map((p, i) => (
          <span
            key={p.label}
            className={`font-mono text-[10px] ${
              i === peakIndex
                ? 'text-avax-red'
                : i === selected
                  ? 'text-purple-text'
                  : 'text-text-muted/60'
            }`}
          >
            {i % labelEvery === 0 || i === peakIndex || i === selected ? p.short : ' '}
          </span>
        ))}
      </div>
    </div>
  )
}

const VIEW_LABELS: Record<View, string> = {
  day: 'By day',
  hour: 'By hour',
  since_posted: 'Since posted',
}

// The axis caption that used to sit beside the toggle ("Mon–Sun", "0–23h") is gone:
// with a third tab the row wrapped onto two lines at phone width, orphaning one
// tab next to a caption that only repeated what the x-axis labels under the chart
// already spell out.

export default function BestTimeToPost({
  windows,
  weekdays,
  hours,
  latency,
  latencyTotal,
  latencySkipped,
  totalComments,
}: {
  windows: ActivityWindow[]
  weekdays: WeekdayActivity[]
  hours: HourActivity[]
  latency: LatencyBucket[]
  latencyTotal: number
  latencySkipped: number
  totalComments: number
}) {
  const [view, setView] = useState<View>('day')
  const [selected, setSelected] = useState<number | null>(null)

  const points: Point[] = useMemo(() => {
    const usableH = CHART_H - PAD_TOP - PAD_BOTTOM
    const source =
      view === 'day'
        ? weekdays.map(d => ({ label: d.day, short: d.short, count: d.count, percentage: d.percentage }))
        : view === 'hour'
          ? hours.map(h => ({
              label: `${h.label} ${EAT_LABEL}`,
              short: h.label.replace(' ', ''),
              count: h.count,
              percentage: h.percentage,
            }))
          : latency.map(b => ({ label: b.short, short: b.short, count: b.count, percentage: b.percentage }))

    const max = Math.max(...source.map(s => s.count), 1)
    const step = (CHART_W - PAD_X * 2) / Math.max(source.length - 1, 1)

    return source.map((s, i) => ({
      ...s,
      x: Math.round(PAD_X + i * step),
      y: Math.round(PAD_TOP + usableH - (s.count / max) * usableH),
    }))
  }, [view, weekdays, hours, latency])

  const peakIndex = points.reduce((best, p, i) => (p.count > points[best].count ? i : best), 0)

  // A single quiet week would otherwise produce a confident-sounding claim built
  // on three comments. Silence is the honest output until there is a pattern.
  if (windows.length === 0 || totalComments < MIN_COMMENTS) return null

  const top = windows[0]
  const busiestDay =
    weekdays.length > 0
      ? weekdays.reduce((best, d) => (d.count > best.count ? d : best), weekdays[0])
      : null

  const latencySummary = summarizeLatency(latency)
  // The "since posted" view answers a different question from the other two, so it
  // gets its own sentence rather than a reworded version of the day/hour one.
  const showLatencyHeadline = view === 'since_posted' && latencySummary !== null

  const availableViews: View[] =
    latencyTotal > 0 ? ['day', 'hour', 'since_posted'] : ['day', 'hour']

  return (
    <section className="card">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-mono text-[10px] tracking-widest text-text-muted uppercase">
          Best time to post
        </p>
        <p className="flex-shrink-0 text-xs text-text-muted">
          {view === 'since_posted' ? 'After publish' : EAT_LABEL}
        </p>
      </div>

      {showLatencyHeadline ? (
        <>
          <p className="mt-2 text-sm leading-relaxed text-text-primary">
            Most comments{' '}
            <span className="font-medium text-purple-text">({latencySummary!.percentage}%)</span>{' '}
            arrive{' '}
            <span className="font-medium text-purple-text">
              {latency[latencySummary!.throughIndex].throughLabel}
            </span>
            .
          </p>
          <p className="mt-1 text-xs text-text-muted">
            Measured from each video&apos;s publish time across{' '}
            {latencyTotal.toLocaleString()} comments
            {latencySkipped > 0
              ? `; ${latencySkipped.toLocaleString()} skipped for lack of a publish date`
              : ''}
            .
          </p>
        </>
      ) : (
        <>
          {/* Both facts in one sentence, on purpose. The busiest single HOUR and the
              busiest DAY overall are different measurements and often land on different
              days. Stated separately they looked like a contradiction; together they
              read as what they are: when to be at your desk, and when the week is
              busiest. */}
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
        </>
      )}

      {/* Full width, equal thirds: three labels cannot share a row with anything
          else at 320px, and equal segments keep the control from reflowing as the
          active label changes. */}
      <div
        className="mt-4 flex w-full rounded-lg border border-white/10 bg-surface p-0.5"
        role="tablist"
      >
        {availableViews.map(key => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            onClick={() => {
              setView(key)
              // Reset the readout so it lands on the new view's peak rather than
              // an index that meant something else in the previous one.
              setSelected(null)
            }}
            className={`flex-1 rounded-md px-1 py-1.5 text-center text-xs font-medium whitespace-nowrap transition-colors ${
              view === key
                ? 'bg-surface-hover text-text-primary'
                : 'text-text-muted hover:text-text-primary'
            }`}
          >
            {VIEW_LABELS[key]}
          </button>
        ))}
      </div>

      <ActivityChart
        points={points}
        labelEvery={view === 'hour' ? 3 : 1}
        selected={selected ?? peakIndex}
        onSelect={setSelected}
      />

      {selected !== null && selected !== peakIndex && (
        <button
          type="button"
          onClick={() => setSelected(null)}
          className="mt-2 font-mono text-[10px] tracking-widest text-text-muted uppercase underline hover:text-text-primary"
        >
          Back to peak
        </button>
      )}
    </section>
  )
}
