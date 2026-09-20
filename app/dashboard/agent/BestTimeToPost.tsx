import { EAT_LABEL, type ActivityWindow } from '@/lib/timing'

// No 'use client': pure markup, so this ships no JavaScript.

/** Below this there isn't enough signal for "busiest hour" to mean anything. */
const MIN_COMMENTS = 10

export default function BestTimeToPost({
  windows,
  totalComments,
}: {
  windows: ActivityWindow[]
  totalComments: number
}) {
  // A single quiet week would otherwise produce a confident-sounding claim built
  // on three comments. Silence is the honest output until there is a pattern.
  if (windows.length === 0 || totalComments < MIN_COMMENTS) return null

  const [top, ...rest] = windows

  return (
    <section className="card">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-mono text-[10px] tracking-widest text-text-muted uppercase">
          Best time to post
        </p>
        <p className="flex-shrink-0 text-xs text-text-muted">{EAT_LABEL}</p>
      </div>

      <p className="mt-2 text-sm leading-relaxed text-text-primary">
        Your audience is most active{' '}
        <span className="font-medium text-purple-text">{top.day}s</span> around{' '}
        <span className="font-medium text-purple-text">
          {top.hourLabel} {EAT_LABEL}
        </span>
        .
      </p>
      <p className="mt-1 text-xs text-text-muted">
        {top.percentage}% of {totalComments.toLocaleString()} comments landed in that hour.
      </p>

      {rest.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t border-white/5 pt-3">
          {rest.map(w => (
            <li key={`${w.dayIndex}-${w.hour}`} className="flex items-baseline justify-between gap-3 text-xs">
              <span className="text-text-muted">
                {w.day}, {w.hourLabel}
              </span>
              <span className="flex-shrink-0 tabular-nums text-text-muted">
                {w.count.toLocaleString()} · {w.percentage}%
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
