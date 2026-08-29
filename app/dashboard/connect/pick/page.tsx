'use client'

import { useState, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { useAnalyze } from '@/lib/hooks/useAnalyze'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'

type ChannelVideo = {
  videoId: string
  title: string
  thumbnailUrl: string
  publishedAt: string
}

function PickPageInner() {
  const searchParams = useSearchParams()
  const channelParam = searchParams.get('channel')

  const [videos, setVideos] = useState<ChannelVideo[]>([])
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [creatorId, setCreatorId] = useState<string | null>(null)
  const [creatorLoading, setCreatorLoading] = useState(true)
  const [analyzingVideoId, setAnalyzingVideoId] = useState<string | null>(null)

  const supabase = createClient()

  const { start, status, progressText, progressPercent, error: analyzeError, result } = useAnalyze(creatorId || '')

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
                    <Link
                      href={`/dashboard/inbox/${result.postId}`}
                      className="btn-primary w-full"
                    >
                      View Results
                    </Link>
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
