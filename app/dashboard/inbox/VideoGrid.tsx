'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'

export type VideoCardData = {
  id: string
  title: string
  ingestedAt: string | null
  thumbnailUrl: string | null
  total: number
  categorized: number
  isTracked: boolean
}

type SortKey = 'recent' | 'needs_analysis' | 'fully_analyzed'

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'recent', label: 'Most recent' },
  { value: 'needs_analysis', label: 'Needs analysis' },
  { value: 'fully_analyzed', label: 'Fully analyzed' },
]

/** 0 when a video has no comments — nothing to analyze is not the same as done. */
function analyzedRatio(video: VideoCardData): number {
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

export default function VideoGrid({ videos }: { videos: VideoCardData[] }) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('recent')

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
      new Date(b.ingestedAt ?? 0).getTime() - new Date(a.ingestedAt ?? 0).getTime()

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
            onChange={e => setQuery(e.target.value)}
            placeholder="Search videos..."
            aria-label="Search videos by title"
            // h-11 keeps the field itself a comfortable touch target.
            className="h-11 w-full rounded-lg border border-white/10 bg-surface pr-3 pl-9 text-sm text-text-primary placeholder:text-text-muted focus:ring-2 focus:ring-purple focus:ring-offset-2 focus:ring-offset-ink focus:outline-none"
          />
        </div>

        <select
          value={sort}
          onChange={e => setSort(e.target.value as SortKey)}
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
          <p className="text-sm text-text-muted">
            No videos match “{query.trim()}”.
          </p>
        </div>
      ) : (
        // 2-up on phones, widening with the viewport. Desktop keeps the roomier
        // 3-across it already had rather than inheriting the dense phone layout.
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-3 lg:gap-4">
          {visible.map(video => (
            <Link
              key={video.id}
              href={`/dashboard/inbox/${video.id}`}
              className="group block overflow-hidden rounded-xl border border-white/10 bg-surface transition-colors hover:bg-surface-hover"
            >
              <div className="relative aspect-video w-full overflow-hidden bg-surface-hover">
                <VideoThumb video={video} />
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
                <h2 className="truncate font-body text-sm font-medium text-text-primary">
                  {video.title}
                </h2>
                <p className="mt-0.5 text-xs text-text-muted">
                  {video.total > 0 ? `${video.categorized}/${video.total}` : '0 comments'}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
