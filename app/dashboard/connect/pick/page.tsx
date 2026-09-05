'use client'

import { useState, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { useAnalyze } from '@/lib/hooks/useAnalyze'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'
import TrackVideoToggle from '@/components/TrackVideoToggle'

type ChannelVideo = {
  videoId: string
  title: string
  thumbnailUrl: string
  publishedAt: string
}

const AUTO_ANALYZE_LIMIT = 5

function PickPageInner() {
  const searchParams = useSearchParams()
  const channelParam = searchParams.get('channel')
  const autoAnalyze = searchParams.get('autoAnalyze') === 'true'

  const [videos, setVideos] = useState<ChannelVideo[]>([])
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [creatorId, setCreatorId] = useState<string | null>(null)
  const [creatorLoading, setCreatorLoading] = useState(true)
  const [analyzingVideoId, setAnalyzingVideoId] = useState<string | null>(null)

  // --- Auto-analyze batch state (only used when ?autoAnalyze=true) ---
  const [analyzedVideoIds, setAnalyzedVideoIds] = useState<Set<string> | null>(null)
  const [autoQueue, setAutoQueue] = useState<ChannelVideo[]>([])
  const [autoStarted, setAutoStarted] = useState(false)
  const [autoIndex, setAutoIndex] = useState(0)
  const [autoDone, setAutoDone] = useState(false)
  const [autoSummary, setAutoSummary] = useState({ commentsIngested: 0, qualified: 0, completed: 0 })

  const supabase = createClient()

  const { start, status, progressText, progressPercent, error: analyzeError, result, setResult } = useAnalyze(creatorId || '')

  useEffect(() => {
    async function loadCreator() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        setCreatorLoading(false)
        return
      }
      const { data: creator } = await supabase
        .from('creators')
        .select('id')
        .eq('user_id', user.id)
        .single()

      if (creator) setCreatorId(creator.id)
      setCreatorLoading(false)
    }

    loadCreator()
  }, [supabase])

  useEffect(() => {
    if (!channelParam) return

    setLoading(true)
    setFetchError(null)

    fetch(`/api/channel/videos?channel=${encodeURIComponent(channelParam)}`)
      .then(res => res.json())
      .then(data => {
        if (data.error) throw new Error(data.error)
        setVideos(data.videos || [])
      })
      .catch(err => setFetchError(err.message))
      .finally(() => setLoading(false))
  }, [channelParam])

  // Fetch which of this creator's videos are already analyzed, so the auto batch
  // can skip them instead of re-triggering analysis on videos we already have.
  useEffect(() => {
    if (!autoAnalyze || !creatorId) return

    fetch('/api/creator/analyzed-videos')
      .then(res => res.json())
      .then(data => setAnalyzedVideoIds(new Set<string>(data.videoIds || [])))
      .catch(() => setAnalyzedVideoIds(new Set<string>()))
  }, [autoAnalyze, creatorId])

  // Build the batch queue once videos + the analyzed-set are both ready, then kick
  // off the first one. Runs once (guarded by autoStarted).
  useEffect(() => {
    if (!autoAnalyze || autoStarted) return
    if (loading || videos.length === 0) return
    if (analyzedVideoIds === null) return

    const queue = videos.slice(0, AUTO_ANALYZE_LIMIT).filter(v => !analyzedVideoIds.has(v.videoId))
    setAutoQueue(queue)
    setAutoStarted(true)

    if (queue.length === 0) {
      setAutoDone(true)
      return
    }

    setAutoIndex(0)
    setAnalyzingVideoId(queue[0].videoId)
    start(`https://www.youtube.com/watch?v=${queue[0].videoId}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAnalyze, autoStarted, loading, videos, analyzedVideoIds])

  // Advance the batch sequentially — one video at a time, never in parallel — each
  // time the current video's analysis finishes (or fails).
  useEffect(() => {
    if (!autoStarted || autoDone) return
    if (status !== 'done' && status !== 'error') return

    if (status === 'done' && result) {
      setAutoSummary(prev => ({
        commentsIngested: prev.commentsIngested + result.commentsIngested,
        qualified: prev.qualified + result.qualified,
        completed: prev.completed + 1,
      }))
    } else if (status === 'error') {
      setAutoSummary(prev => ({ ...prev, completed: prev.completed + 1 }))
    } else {
      return
    }

    const nextIndex = autoIndex + 1

    if (nextIndex < autoQueue.length) {
      // Only reset result when actually moving to another video — nulling it
      // unconditionally would wipe out the final video's result before its card
      // gets a chance to render "View Results".
      setResult(null)
      setAutoIndex(nextIndex)
      const nextVideo = autoQueue[nextIndex]
      setAnalyzingVideoId(nextVideo.videoId)
      start(`https://www.youtube.com/watch?v=${nextVideo.videoId}`)
    } else {
      setAutoDone(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, result])

  function handleAnalyze(video: ChannelVideo) {
    if (!creatorId || status === 'running') return
    setAnalyzingVideoId(video.videoId)
    start(`https://www.youtube.com/watch?v=${video.videoId}`)
  }

  if (creatorLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <p className="text-text-muted">Loading...</p>
      </div>
    )
  }

  if (!creatorId) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <p className="text-text-muted">Please log in to continue.</p>
      </div>
    )
  }

  if (!channelParam) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="card p-6 text-center">
          <p className="text-sm text-text-muted">No channel specified.</p>
          <Link href="/dashboard/connect" className="btn-primary mt-4 inline-flex">
            Connect a channel
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6">
        <h1 className="font-display text-2xl font-semibold text-text-primary">
          Pick a video to analyze
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          Select one of your recent videos to see what your audience is saying.
        </p>
      </div>

      {autoAnalyze && autoStarted && !autoDone && (
        <div className="card mb-6">
          <p className="text-sm font-medium text-text-primary">
            Analyzing video {Math.min(autoIndex + 1, autoQueue.length)} of {autoQueue.length}...
          </p>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-hover">
            <div
              className="h-full rounded-full bg-cobalt transition-all duration-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-text-muted">{progressText}</p>
        </div>
      )}

      {autoAnalyze && autoDone && (
        <div className="card mb-6">
          {autoQueue.length === 0 ? (
            <p className="text-sm text-text-primary">
              Your {Math.min(videos.length, AUTO_ANALYZE_LIMIT)} most recent video
              {Math.min(videos.length, AUTO_ANALYZE_LIMIT) === 1 ? ' was' : 's were'} already analyzed.
            </p>
          ) : (
            <p className="text-sm text-text-primary">
              Analyzed {autoQueue.length} video{autoQueue.length === 1 ? '' : 's'} —{' '}
              <span className="font-body font-semibold text-cobalt">{autoSummary.commentsIngested}</span>{' '}
              comment{autoSummary.commentsIngested === 1 ? '' : 's'} understood,{' '}
              <span className="font-body font-semibold text-pink">{autoSummary.qualified}</span>{' '}
              {autoSummary.qualified === 1 ? 'person' : 'people'} recognized.
            </p>
          )}
          <Link href="/dashboard/agent" className="btn-primary mt-4 inline-flex">
            Go to Agent Home
          </Link>
        </div>
      )}

      {fetchError && (
        <div className="card mb-6 p-6 text-center">
          <p className="text-sm text-avax-red">{fetchError}</p>
          <Link href="/dashboard/connect" className="btn-primary mt-4 inline-flex">
            Try a different channel
          </Link>
        </div>
      )}

      {loading && (
        <div className="flex min-h-[40vh] items-center justify-center">
          <p className="text-text-muted">Loading videos...</p>
        </div>
      )}

      {!loading && !fetchError && videos.length === 0 && (
        <div className="card p-6 text-center">
          <p className="text-sm text-text-muted">No videos found for this channel.</p>
          <Link href="/dashboard/connect" className="btn-primary mt-4 inline-flex">
            Try a different channel
          </Link>
        </div>
      )}

      {!loading && videos.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {videos.map(video => {
            const isAnalyzing = analyzingVideoId === video.videoId
            const isDone = result && analyzingVideoId === video.videoId && status === 'done'
            const isError = analyzeError && analyzingVideoId === video.videoId && status === 'error'
            const isRunning = status === 'running'

            return (
              <div
                key={video.videoId}
                className={`card relative overflow-hidden transition-all duration-300 ${
                  isRunning && !isAnalyzing ? 'opacity-40 blur-[1px]' : ''
                } ${isAnalyzing ? 'ring-2 ring-cobalt' : ''}`}
              >
                <div className="aspect-video w-full overflow-hidden rounded-t-lg bg-surface">
                  <img
                    src={video.thumbnailUrl}
                    alt={video.title}
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="p-4">
                  <h3 className="font-body font-medium text-text-primary">{video.title}</h3>
                  <p className="mt-1 text-xs text-text-muted">
                    {new Date(video.publishedAt).toLocaleDateString()}
                  </p>
                </div>

                <div className="px-4 pb-4">
                  {isDone && result ? (
                    <div className="space-y-2">
                      <Link
                        href={`/dashboard/inbox/${result.postId}`}
                        className="btn-primary w-full"
                      >
                        View Results
                      </Link>
                      <TrackVideoToggle postId={result.postId} />
                    </div>
                  ) : isError ? (
                    <div>
                      <p className="mb-2 text-sm text-avax-red">{analyzeError}</p>
                      <button
                        onClick={() => handleAnalyze(video)}
                        disabled={isRunning}
                        className="btn-primary w-full disabled:opacity-50"
                      >
                        Try Again
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => handleAnalyze(video)}
                      disabled={isRunning}
                      className="btn-primary w-full disabled:opacity-50"
                    >
                      {isRunning && isAnalyzing ? 'Analyzing...' : 'Notice This Video'}
                    </button>
                  )}
                </div>

                {isAnalyzing && isRunning && (
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-lg bg-background/80 p-6 backdrop-blur-sm">
                    <div className="w-full space-y-3">
                      <div className="h-2 overflow-hidden rounded-full bg-surface-hover">
                        <div
                          className="h-full rounded-full bg-cobalt transition-all duration-500"
                          style={{ width: `${progressPercent}%` }}
                        />
                      </div>
                      <p className="text-center text-sm text-text-primary">{progressText}</p>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function PickPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-[60vh] items-center justify-center">
        <p className="text-text-muted">Loading...</p>
      </div>
    }>
      <PickPageInner />
    </Suspense>
  )
}
