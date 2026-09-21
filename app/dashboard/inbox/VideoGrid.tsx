'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAnalyze } from '@/lib/hooks/useAnalyze'

export type VideoCardData = {
  /** Post id for analyzed videos, `yt:<videoId>` for ones that only exist in the channel index. */
  id: string
  postId: string | null
  videoId: string | null
  title: string
  sortedAt: string | null
  thumbnailUrl: string | null
  total: number
  categorized: number
  isTracked: boolean
  analyzed: boolean
  /** Both null for videos that exist only in the channel index — nothing is fetched for them. */
  durationSeconds: number | null
  viewCount: number | null
}

type SortKey = 'analyzed_first' | 'recent' | 'needs_analysis' | 'fully_analyzed'

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'analyzed_first', label: 'Analyzed first' },
  { value: 'recent', label: 'Most recent' },
  { value: 'needs_analysis', label: 'Needs analysis' },
  { value: 'fully_analyzed', label: 'Fully analyzed' },
]

/**
 * A whole upload history can run to thousands of videos, so the grid renders a
 * window of them and grows on demand. Search and sort still run over the full
 * list, so nothing is hidden — only deferred.
 */
const PAGE_SIZE = 24

/** 0 when a video has no comments — nothing to analyze is not the same as done. */
function analyzedRatio(video: VideoCardData): number {
  if (!video.analyzed) return 0
  if (video.total === 0) return 0
  return video.categorized / video.total
}

function VideoThumb({ video }: { video: VideoCardData }) {
  if (video.thumbnailUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={video.thumbnailUrl} alt="" className="h-full w-full object-cover" />
    )
  }
  return (
    <div className="flex h-full w-full items-center justify-center">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        className="h-8 w-8 text-text-muted"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M15.75 10.5l4.72-2.36a.75.75 0 0 1 1.08.67v8.38a.75.75 0 0 1-1.08.67l-4.72-2.36M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-7.5A2.25 2.25 0 0 0 13.5 6.75h-9A2.25 2.25 0 0 0 2.25 9v7.5a2.25 2.25 0 0 0 2.25 2.25Z"
        />
      </svg>
    </div>
  )
}

/** 754 -> "12:34", 3725 -> "1:02:05". Null when the duration was never captured. */
function formatDuration(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const sec = seconds % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`
}

/** 51600 -> "51.6K views". Compact because the badge sits under a 165px card. */
function formatViews(views: number | null): string | null {
  if (views === null || views === undefined || views < 0) return null
  if (views >= 1_000_000) return `${(views / 1_000_000).toFixed(1).replace(/\.0$/, '')}M views`
  if (views >= 1_000) return `${(views / 1_000).toFixed(1).replace(/\.0$/, '')}K views`
  return `${views} ${views === 1 ? 'view' : 'views'}`
}

/**
 * Duration over the thumbnail, bottom-right, the way every video platform places
 * it. Renders nothing when the value is missing rather than showing "0:00" —
 * channel-index videos have no duration until they are analyzed.
 */
function DurationBadge({ seconds }: { seconds: number | null }) {
  const label = formatDuration(seconds)
  if (!label) return null
  return (
    <span className="absolute right-1.5 bottom-1.5 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] text-white tabular-nums backdrop-blur-sm">
      {label}
    </span>
  )
}

const CARD_SHELL =
  'group block overflow-hidden rounded-xl border border-white/10 bg-surface transition-colors'

function AnalyzedCard({
  video,
  popping,
  onPress,
}: {
  video: VideoCardData
  popping: boolean
  onPress: () => void
}) {
  return (
    <Link
      href={`/dashboard/inbox/${video.postId}`}
      onClick={onPress}
      className={`${CARD_SHELL} hover:bg-surface-hover ${popping ? 'card-pop' : ''}`}
    >
      <div className="relative aspect-video w-full overflow-hidden bg-surface-hover">
        <VideoThumb video={video} />
        <DurationBadge seconds={video.durationSeconds} />
        {video.isTracked && (
          // Moved onto the thumbnail: at half width there isn't room for a
          // badge beside the counts without pushing them onto a second line.
          <span className="absolute top-1.5 right-1.5 rounded-full bg-black/70 px-1.5 py-0.5 font-mono text-[9px] tracking-wide text-purple-text uppercase backdrop-blur-sm">
            Tracked
          </span>
        )}
      </div>
      {/* min-h + py give the tappable area past 44px even though the card
          itself is visually compact. */}
      <div className="min-h-[3.25rem] px-2.5 py-2">
        <h2 className="truncate font-body text-sm font-medium text-text-primary">{video.title}</h2>
        <p className="mt-0.5 truncate text-xs text-text-muted">
          {video.total > 0 ? `${video.categorized}/${video.total}` : '0 comments'}
          {formatViews(video.viewCount) ? ` · ${formatViews(video.viewCount)}` : ''}
        </p>
      </div>
    </Link>
  )
}

function UnanalyzedCard({
  video,
  state,
  progressText,
  progressPercent,
  error,
  onAnalyze,
  popping,
}: {
  video: VideoCardData
  state: 'idle' | 'running' | 'error'
  progressText: string
  progressPercent: number
  error: string | null
  onAnalyze: () => void
  popping: boolean
}) {
  const running = state === 'running'

  return (
    // A div, not a Link: there is no post to open yet, so the whole card is the
    // analyze affordance rather than dead navigation.
    <div className={`${CARD_SHELL} ${popping ? 'card-pop' : ''}`}>
      <div className="relative aspect-video w-full overflow-hidden bg-surface-hover">
        {/* Dimmed and blurred to read as "not processed yet" at a glance, next to
            the clear cards of videos that have been. */}
        <div className={running ? 'h-full w-full opacity-60 blur-[1px]' : 'h-full w-full opacity-50 blur-[2px]'}>
          <VideoThumb video={video} />
        </div>
        <DurationBadge seconds={video.durationSeconds} />

        <div className="absolute inset-0 flex items-center justify-center bg-black/40 p-2">
          {running ? (
            <div className="w-full text-center">
              <p className="truncate text-[10px] text-white/90">{progressText || 'Analyzing…'}</p>
              <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/20">
                <div
                  className="gradient-primary h-full rounded-full transition-all duration-500"
                  style={{ width: `${Math.max(4, Math.min(100, progressPercent))}%` }}
                />
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={onAnalyze}
              // min-h-11 keeps this a 44px touch target. Without it the pill is 28px
              // tall at 375px — it only reached 44 at 320px because the label wrapped.
              className="inline-flex min-h-11 items-center rounded-full bg-white/95 px-3 text-xs font-medium text-ink transition-colors hover:bg-white"
            >
              Analyze this video
            </button>
          )}
        </div>
      </div>

      <div className="min-h-[3.25rem] px-2.5 py-2">
        <h2 className="truncate font-body text-sm font-medium text-text-primary opacity-70">
          {video.title}
        </h2>
        <p className="mt-0.5 truncate text-xs text-text-muted">
          {state === 'error' ? <span className="text-avax-red">{error || 'Failed'}</span> : 'Not analyzed yet'}
        </p>
      </div>
    </div>
  )
}

export default function VideoGrid({
  videos,
  creatorId,
}: {
  videos: VideoCardData[]
  creatorId: string
}) {
  const [query, setQuery] = useState('')
  // Analyzed first by default: the clear cards are the ones with something to read,
  // and interleaving them with blurred placeholders by date alone buried them.
  const [sort, setSort] = useState<SortKey>('analyzed_first')
  const [limit, setLimit] = useState(PAGE_SIZE)
  const router = useRouter()

  // One analysis at a time. Kicking off several at once would put the same
  // creator through concurrent Anthropic batches for no benefit, and the card
  // that is running is the one the creator is watching.
  const [activeId, setActiveId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  // A bulk run: analyse the next N unanalyzed videos one at a time.
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null)
  // A ref, not state: the loop reads it between videos and must see the value set
  // by the Stop click that happened DURING the previous await, which a state
  // snapshot captured when the loop started would not.
  const stopRequested = useRef(false)

  // Which card was just tapped, so the pop animation can play once and reset.
  const [popId, setPopId] = useState<string | null>(null)
  function pop(id: string) {
    setPopId(id)
    // Matches the 200ms animation; clearing lets the same card pop again later.
    window.setTimeout(() => setPopId(current => (current === id ? null : current)), 260)
  }
  const { start, status, progressText, progressPercent, error } = useAnalyze(creatorId)

  /**
   * start() resolves only once the analysis has actually finished, so the refresh
   * afterwards re-runs the server component and the card comes back clear with
   * real comment counts — no navigation, no reload.
   */
  async function handleAnalyze(video: VideoCardData) {
    if (running || bulk || !video.videoId) return

    pop(video.id)
    setActiveId(video.id)
    setRunning(true)
    await start(`https://www.youtube.com/watch?v=${video.videoId}`)
    setRunning(false)
    router.refresh()
  }

  /**
   * Analyses the next `count` unanalyzed videos, newest first, strictly one at a
   * time — the same sequential shape the connect flow uses. Running several at
   * once would put one creator through concurrent Anthropic batches for no gain.
   *
   * Stop is checked BEFORE each video starts, never mid-analysis: whatever is
   * already running finishes and is saved, and nothing new begins after that.
   * Videos completed before the stop stay analyzed; the rest stay blurred.
   */
  async function runBulk(count: number) {
    if (running || bulk) return

    const queue = visible.filter(v => !v.analyzed && v.videoId).slice(0, count)
    if (queue.length === 0) return

    stopRequested.current = false
    setBulk({ done: 0, total: queue.length })

    for (let i = 0; i < queue.length; i++) {
      if (stopRequested.current) break

      const video = queue[i]
      setBulk({ done: i, total: queue.length })
      setActiveId(video.id)
      setRunning(true)
      await start(`https://www.youtube.com/watch?v=${video.videoId}`)
      setRunning(false)
      // Refresh per video rather than once at the end, so each card turns clear as
      // it finishes instead of the whole grid changing at once.
      router.refresh()
    }

    setBulk(null)
    setActiveId(null)
    stopRequested.current = false
  }

  // Read from hook state at render time rather than from `status` captured after
  // the await, which would be the value from the render that started the run.
  function cardState(video: VideoCardData): 'idle' | 'running' | 'error' {
    if (activeId !== video.id) return 'idle'
    if (running) return 'running'
    return status === 'error' ? 'error' : 'idle'
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = needle
      ? videos.filter(v => v.title.toLowerCase().includes(needle))
      : videos

    // Copy before sorting — Array.prototype.sort mutates, and `videos` is the prop.
    const sorted = [...filtered]

    // Every comparator falls back to recency, so videos that tie on the primary key
    // (all the 0% ones, say) still come back in a stable, meaningful order rather
    // than whatever the filter happened to produce.
    const byRecency = (a: VideoCardData, b: VideoCardData) =>
      new Date(b.sortedAt ?? 0).getTime() - new Date(a.sortedAt ?? 0).getTime()

    if (sort === 'analyzed_first') {
      return sorted.sort((a, b) => {
        if (a.analyzed !== b.analyzed) return a.analyzed ? -1 : 1
        return byRecency(a, b)
      })
    }

    if (sort === 'recent') return sorted.sort(byRecency)

    if (sort === 'needs_analysis') {
      return sorted.sort((a, b) => {
        const diff = analyzedRatio(a) - analyzedRatio(b)
        return diff !== 0 ? diff : byRecency(a, b)
      })
    }

    return sorted.sort((a, b) => {
      const diff = analyzedRatio(b) - analyzedRatio(a)
      return diff !== 0 ? diff : byRecency(a, b)
    })
  }, [videos, query, sort])

  const shown = visible.slice(0, limit)
  // Counted over the whole filtered set, not the rendered window: "next 10" should
  // mean ten real videos even when only the first 24 are on screen.
  const pendingCount = visible.filter(v => !v.analyzed && v.videoId).length

  return (
    <div>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-text-muted">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
              />
            </svg>
          </span>
          <input
            type="search"
            value={query}
            onChange={e => {
              setQuery(e.target.value)
              setLimit(PAGE_SIZE)
            }}
            placeholder="Search videos..."
            aria-label="Search videos by title"
            // h-11 keeps the field itself a comfortable touch target.
            className="h-11 w-full rounded-lg border border-white/10 bg-surface pr-3 pl-9 text-sm text-text-primary placeholder:text-text-muted focus:ring-2 focus:ring-purple focus:ring-offset-2 focus:ring-offset-ink focus:outline-none"
          />
        </div>

        <select
          value={sort}
          onChange={e => {
            setSort(e.target.value as SortKey)
            setLimit(PAGE_SIZE)
          }}
          aria-label="Sort videos"
          className="h-11 rounded-lg border border-white/10 bg-surface px-3 text-sm text-text-primary focus:ring-2 focus:ring-purple focus:ring-offset-2 focus:ring-offset-ink focus:outline-none"
        >
          {SORT_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {visible.length === 0 ? (
        <div className="card p-6 text-center">
          <p className="text-sm text-text-muted">No videos match “{query.trim()}”.</p>
        </div>
      ) : (
        <>
          {/* 2-up on phones, widening with the viewport. Desktop keeps the roomier
              3-across it already had rather than inheriting the dense phone layout. */}
          {/* -mx-2 on phones only: the shared layout supplies a 24px gutter, which
              is right for text but leaves thumbnails narrower than they need to be.
              Bleeding 8px per side and tightening the gap gives each card ~13px more
              width at 390px without the page ever scrolling sideways. */}
          {/* Bulk controls. Hidden when there is nothing left to analyze, and
              swapped for a single Stop while a run is going — two live triggers
              plus a stop would invite starting a second run mid-run. */}
          {pendingCount > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {bulk ? (
                <>
                  <span className="text-xs text-text-muted" role="status" aria-live="polite">
                    Analyzing {Math.min(bulk.done + 1, bulk.total)} of {bulk.total}
                    {stopRequested.current ? ' — finishing this one, then stopping' : '…'}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      stopRequested.current = true
                      // Re-render so the label above switches immediately; the ref
                      // itself does not trigger one.
                      setBulk(b => (b ? { ...b } : b))
                    }}
                    className="inline-flex min-h-11 items-center rounded-lg border border-avax-red/40 bg-avax-red/10 px-3 text-xs font-medium text-avax-red transition-colors hover:bg-avax-red/20"
                  >
                    Stop
                  </button>
                </>
              ) : (
                <>
                  <span className="text-xs text-text-muted">
                    {pendingCount} not analyzed yet
                  </span>
                  <button
                    type="button"
                    onClick={() => void runBulk(5)}
                    disabled={running}
                    className="inline-flex min-h-11 items-center rounded-lg border border-white/10 bg-surface px-3 text-xs font-medium text-text-primary transition-colors hover:bg-surface-hover disabled:opacity-40"
                  >
                    Analyze next 5
                  </button>
                  <button
                    type="button"
                    onClick={() => void runBulk(10)}
                    disabled={running}
                    className="inline-flex min-h-11 items-center rounded-lg border border-white/10 bg-surface px-3 text-xs font-medium text-text-primary transition-colors hover:bg-surface-hover disabled:opacity-40"
                  >
                    Analyze next 10
                  </button>
                </>
              )}
            </div>
          )}

          <div className="-mx-2 grid grid-cols-2 gap-2.5 sm:mx-0 sm:grid-cols-2 sm:gap-3 lg:grid-cols-3 lg:gap-4">
            {shown.map(video =>
              video.analyzed ? (
                <AnalyzedCard
                  key={video.id}
                  video={video}
                  popping={popId === video.id}
                  onPress={() => pop(video.id)}
                />
              ) : (
                <UnanalyzedCard
                  key={video.id}
                  video={video}
                  state={cardState(video)}
                  progressText={progressText}
                  progressPercent={progressPercent}
                  error={error}
                  onAnalyze={() => void handleAnalyze(video)}
                  popping={popId === video.id}
                />
              )
            )}
          </div>

          {visible.length > shown.length && (
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                onClick={() => setLimit(l => l + PAGE_SIZE)}
                className="rounded-lg border border-white/10 bg-surface px-4 py-2 text-sm text-text-primary hover:bg-surface-hover"
              >
                Show more ({visible.length - shown.length} left)
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
