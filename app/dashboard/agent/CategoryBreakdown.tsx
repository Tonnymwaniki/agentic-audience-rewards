'use client'

import { useEffect, useRef, useState } from 'react'
import { CATEGORY_ORDER, CATEGORY_STYLES } from '@/lib/comment-categories'

export type CategoryCounts = Record<string, number>

export type VideoBreakdown = {
  postId: string
  title: string
  counts: CategoryCounts
  total: number
}

/** Long enough to read a four-category legend without feeling hurried. */
const CYCLE_MS = 7000
/** Roughly the transition length; the bars are swapped at the midpoint of it. */
const FADE_MS = 420

function present(counts: CategoryCounts) {
  return CATEGORY_ORDER.filter(key => (counts[key] ?? 0) > 0).map(key => ({
    key,
    count: counts[key],
    ...CATEGORY_STYLES[key],
  }))
}

/**
 * "What is in my comments?" — one video at a time.
 *
 * Cycles through the creator's analyzed videos so the widget answers a sharper
 * question than an all-time total could: a channel whose complaints are confined
 * to one video is a different situation from one where they are spread evenly, and
 * a single merged bar hides that completely.
 *
 * Stays still for a creator with one video, and for anyone who has asked for
 * reduced motion — in that case the data still cycles, just without the glow and
 * lift, and more slowly so the change is not startling.
 */
export default function CategoryBreakdown({
  counts,
  videos,
}: {
  /** All-time totals, used as the fallback when per-video data is unavailable. */
  counts: CategoryCounts
  videos: VideoBreakdown[]
}) {
  const [index, setIndex] = useState(0)
  const [animating, setAnimating] = useState(false)
  const [reduced, setReduced] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setReduced(
      typeof window !== 'undefined' &&
        Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
    )
  }, [])

  const cycling = videos.length > 1

  useEffect(() => {
    if (!cycling) return

    // Reduced motion gets a slower, plain swap rather than no cycle at all: the
    // information is the point, the movement is decoration.
    const interval = reduced ? CYCLE_MS * 1.6 : CYCLE_MS

    const tick = () => {
      if (reduced) {
        setIndex(i => (i + 1) % videos.length)
      } else {
        setAnimating(true)
        // Swap the data at the midpoint, while the card is faded out, so the bars
        // never visibly rearrange.
        window.setTimeout(() => setIndex(i => (i + 1) % videos.length), FADE_MS / 2)
        window.setTimeout(() => setAnimating(false), FADE_MS)
      }
      timer.current = setTimeout(tick, interval)
    }

    timer.current = setTimeout(tick, interval)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [cycling, reduced, videos.length])

  const active = videos[index] ?? null
  const shown = active ? active.counts : counts
  const items = present(shown)
  const total = items.reduce((sum, item) => sum + item.count, 0)

  // Nothing categorized yet: the stat cards above already say the agent has read
  // nothing, so a second empty state here would just repeat them.
  if (total === 0) return null

  return (
    <section
      className={`card transition-all ${
        animating ? 'scale-[0.985] opacity-50' : 'scale-100 opacity-100'
      }`}
      style={{
        transitionDuration: `${FADE_MS / 2}ms`,
        // The glow rises as the card settles, so the change reads as the widget
        // turning over rather than as a flicker.
        boxShadow: animating ? '0 0 26px -6px rgba(139, 92, 246, 0.55)' : undefined,
      }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-mono text-[10px] tracking-widest text-text-muted uppercase">
          What your audience says
        </p>
        <p className="flex-shrink-0 text-xs text-text-muted">
          {active ? (
            <span className="tabular-nums">{total.toLocaleString()}</span>
          ) : (
            <>
              All time ·{' '}
              <span className="font-medium text-text-primary tabular-nums">
                {total.toLocaleString()}
              </span>
            </>
          )}
        </p>
      </div>

      {/* Which video is on screen. Without it the numbers change every few seconds
          with no explanation, which reads as a glitch. */}
      {active && (
        <p className="mt-1 truncate text-xs text-text-muted" title={active.title}>
          {active.title}
        </p>
      )}

      <div
        aria-hidden="true"
        className="mt-3 flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-white/5"
      >
        {items.map(item => (
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
        {items.map(item => (
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

      {/* Progress dots double as a hint that more videos are coming round. */}
      {cycling && (
        <div className="mt-3 flex items-center gap-1.5">
          {videos.map((video, i) => (
            <span
              key={video.postId}
              aria-hidden="true"
              className={`h-1 rounded-full transition-all duration-300 ${
                i === index ? 'w-4 bg-purple-text' : 'w-1 bg-white/15'
              }`}
            />
          ))}
          <span className="sr-only">
            Showing video {index + 1} of {videos.length}
          </span>
        </div>
      )}
    </section>
  )
}
