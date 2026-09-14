'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useAnalyze } from '@/lib/hooks/useAnalyze'
import { runAnalysis } from '@/lib/analyze-run'
import { BUSINESS_CATEGORIES } from '@/lib/business-categories'
import MascotIcon from '@/components/MascotIcon'

/** How many of the newest un-analyzed videos auto-analyze picks up after a sync. */
const AUTO_ANALYZE_COUNT = 5

export default function ConnectPage() {
  const [channel, setChannel] = useState('')
  const [savedChannel, setSavedChannel] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [creatorId, setCreatorId] = useState<string | null>(null)
  const [autoAnalyze, setAutoAnalyze] = useState(false)
  const [category, setCategory] = useState<string | null>(null)
  const [alreadyCategorized, setAlreadyCategorized] = useState(false)
  const router = useRouter()
  // The connect flow is a small state machine now: form -> syncing -> (analyzing)
  // -> My Videos. Kept explicit rather than derived from a pile of booleans,
  // because the transitions matter (auto-analyze must not start until the sync has
  // finished, or "5 most recent" would come from the first page only).
  const [phase, setPhase] = useState<'form' | 'syncing' | 'analyzing' | 'leaving'>('form')
  const [syncCount, setSyncCount] = useState(0)
  const [syncHitCap, setSyncHitCap] = useState(false)
  const [analyzeTotal, setAnalyzeTotal] = useState(0)
  const [analyzeIndex, setAnalyzeIndex] = useState(0)
  const [progressText, setProgressText] = useState('')
  const [progressPercent, setProgressPercent] = useState(0)
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)


  /**
   * Runs once the background sync reports done (or failed).
   *
   * Auto-analyze is triggered HERE rather than at submit time, which is the whole
   * point of the ordering: only now is the full upload history stored, so
   * "5 most recent" is the 5 most recent overall rather than the 5 most recent on
   * the first page of the API response.
   *
   * The videos are analyzed one at a time in a plain loop — runAnalysis resolves
   * on actual completion, so no queue state or status-watching effect is needed.
   */
  async function handleSyncFinished(succeeded: boolean) {
    const leave = () => {
      setPhase('leaving')
      router.push('/dashboard/inbox')
    }

    if (!autoAnalyze || !succeeded || !creatorId) {
      leave()
      return
    }

    try {
      const supabase = createClient()
      const { data: recent } = await supabase
        .from('channel_videos')
        .select('video_id, published_at')
        .eq('creator_id', creatorId)
        .is('post_id', null)
        .order('published_at', { ascending: false })
        .limit(AUTO_ANALYZE_COUNT)

      const urls = (recent || []).map(v => `https://www.youtube.com/watch?v=${v.video_id}`)

      if (urls.length === 0) {
        leave()
        return
      }

      setAnalyzeTotal(urls.length)
      setAnalyzeIndex(0)
      setAnalyzeError(null)
      setPhase('analyzing')

      for (let i = 0; i < urls.length; i++) {
        setAnalyzeIndex(i)
        setProgressText('')
        setProgressPercent(0)

        const outcome = await runAnalysis(creatorId, urls[i], progress => {
          setProgressText(progress.text)
          setProgressPercent(progress.percent)
        })

        // One bad video shouldn't strand the creator on this screen; the rest of
        // the queue still runs and the failure is visible in My Videos as an
        // un-analyzed card they can retry.
        if (outcome.status === 'error') {
          setAnalyzeError(outcome.error)
        }
      }

      leave()
    } catch (err) {
      console.error('Auto-analyze error:', err)
      leave()
    }
  }

  // Polls the background channel sync. Stops as soon as it finishes, so a completed
  // sync doesn't leave an interval running for the life of the page.
  useEffect(() => {
    if (phase !== 'syncing') return

    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/creator/channel/sync-status')
        if (!res.ok) return
        const data = await res.json()
        setSyncCount(data.videosSynced ?? 0)
        setSyncHitCap(Boolean(data.hitCap))

        if (data.status === 'done' || data.status === 'error') {
          clearInterval(interval)
          // Even a failed sync moves on: the channel is connected, and My Videos
          // still shows whatever was stored plus the paste-a-link option.
          await handleSyncFinished(data.status === 'done')
        }
      } catch {
        // transient; the next tick retries
      }
    }, 1500)

    return () => clearInterval(interval)
    // handleSyncFinished is stable for the life of a phase transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])


  useEffect(() => {
    async function loadCreator() {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()

      if (!user) {
        setLoading(false)
        return
      }

      const { data: creator } = await supabase
        .from('creators')
        .select('id, channel_url, business_category')
        .eq('user_id', user.id)
        .single()

      if (creator) {
        setCreatorId(creator.id)
        if (creator.channel_url) {
          setSavedChannel(creator.channel_url)
          setChannel(creator.channel_url)
        }
        if (creator.business_category) {
          setCategory(creator.business_category)
          setAlreadyCategorized(true)
        }
      }

      setLoading(false)
    }

    loadCreator()
  }, [])

  async function handleChannelSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = channel.trim()
    if (!trimmed) return

    try {
      const response = await fetch('/api/creator/channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_url: trimmed }),
      })

      if (!response.ok) {
        const data = await response.json()
        console.error('Failed to save channel:', data.error)
      } else {
        // The full-history sync runs in the background, so start watching it.
        setPhase('syncing')
        setSyncCount(0)
      }
    } catch (err) {
      console.error('Save channel error:', err)
    }

    // Saved separately so a category failure can't block the channel connect flow.
    if (category) {
      try {
        const response = await fetch('/api/creator/category', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ business_category: category }),
        })

        if (!response.ok) {
          const data = await response.json()
          console.error('Failed to save business category:', data.error)
        }
      } catch (err) {
        console.error('Save business category error:', err)
      }
    }

    // Deliberately NOT navigateToPick any more. The picker still exists at
    // /dashboard/connect/pick and nothing was deleted, but the default flow now
    // syncs the whole channel and lands on My Videos, where every video is listed.
  }

  // The picker at /dashboard/connect/pick still exists and still works if opened
  // directly — nothing was deleted — but no default path routes here any more.
  // A returning creator whose channel is already synced goes straight to the full
  // list in My Videos, where every video is shown and un-analyzed ones can be
  // analyzed in place.
  function handleUseSaved() {
    if (savedChannel) {
      router.push('/dashboard/inbox')
    }
  }

  function handleClear() {
    setSavedChannel(null)
    setChannel('')
  }

  if (loading) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center px-6">
        <p className="text-text-muted">Loading...</p>
      </div>
    )
  }

  // Everything after submit happens on this screen: the channel sync, then the
  // optional auto-analyze queue, then the redirect. The form is not rendered
  // underneath it, so there is nothing to click twice by accident.
  if (phase !== 'form') {
    const analyzingNumber = Math.min(analyzeIndex + 1, analyzeTotal)

    return (
      <div className="flex min-h-[70vh] items-center justify-center px-6">
        <div className="w-full max-w-md text-center">
          <div className="flex justify-center">
            <MascotIcon type="agent" />
          </div>

          {phase === 'syncing' && (
            <>
              <h1 className="mt-5 font-display text-2xl font-semibold text-text-primary">
                Syncing your channel…
              </h1>
              <p className="mt-2 text-sm text-text-muted">
                {syncCount > 0
                  ? `${syncCount.toLocaleString()} videos found so far`
                  : 'Looking through your uploads'}
              </p>
              <span aria-hidden="true" className="mt-4 inline-flex gap-1.5">
                {[0, 1, 2].map(i => (
                  <span
                    key={i}
                    className="typing-dot h-2 w-2 rounded-full bg-purple-text"
                    style={{ animationDelay: `${i * 0.18}s` }}
                  />
                ))}
              </span>
            </>
          )}

          {phase === 'analyzing' && (
            <>
              <h1 className="mt-5 font-display text-2xl font-semibold text-text-primary">
                Analyzing your {analyzeTotal} most recent videos
              </h1>
              <p className="mt-2 text-sm text-text-muted">
                Video {analyzingNumber} of {analyzeTotal}
                {progressText ? ` — ${progressText}` : ''}
              </p>
              {progressPercent > 0 && (
                <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-surface-hover">
                  <div
                    className="gradient-primary h-full rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(100, progressPercent)}%` }}
                  />
                </div>
              )}
              {analyzeError && <p className="mt-3 text-sm text-avax-red">{analyzeError}</p>}
              {/* The work continues server-side, so leaving early costs nothing. */}
              <button
                type="button"
                onClick={() => router.push('/dashboard/inbox')}
                className="mt-5 text-xs text-text-muted underline hover:text-text-primary"
              >
                Skip and go to My Videos
              </button>
            </>
          )}

          {phase === 'leaving' && (
            <h1 className="mt-5 font-display text-2xl font-semibold text-text-primary">
              Opening My Videos…
            </h1>
          )}

          {syncHitCap && phase !== 'syncing' && (
            <p className="mt-4 text-xs text-gold-light">
              This channel has more history than we sync in one pass — the most recent{' '}
              {syncCount.toLocaleString()} are tracked.
            </p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="text-center">
          <h1 className="font-display text-3xl font-semibold text-text-primary md:text-4xl">
            Connect your channel
          </h1>
          <p className="mt-3 text-sm text-text-muted">
            Paste your channel link and we&apos;ll find your recent videos.
          </p>
        </div>

        <form onSubmit={handleChannelSubmit} className="mt-8 space-y-4">
          <div>
            <label htmlFor="channel-url" className="mb-2 block text-sm font-medium text-text-muted">
              Paste your channel link
            </label>
            <input
              id="channel-url"
              type="url"
              value={channel}
              onChange={e => setChannel(e.target.value)}
              placeholder="https://www.youtube.com/@yourchannel"
              className="flex h-12 w-full rounded-lg border border-white/10 bg-surface px-4 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-purple focus:ring-offset-2 focus:ring-offset-ink"
            />
          </div>

          {!alreadyCategorized && (
            <div>
              <p className="mb-2 block text-sm font-medium text-text-muted">
                What best describes your channel? <span className="text-xs">(optional)</span>
              </p>
              <div className="flex flex-wrap gap-2">
                {BUSINESS_CATEGORIES.map(option => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setCategory(category === option ? null : option)}
                    className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                      category === option
                        ? 'border-purple bg-purple text-white'
                        : 'border-white/10 bg-surface text-text-muted hover:text-text-primary'
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <input
              id="auto-analyze"
              type="checkbox"
              checked={autoAnalyze}
              onChange={e => setAutoAnalyze(e.target.checked)}
              className="h-4 w-4 rounded border-white/10 bg-surface text-purple-text focus:outline-none focus:ring-2 focus:ring-purple focus:ring-offset-2 focus:ring-offset-ink"
            />
            <label htmlFor="auto-analyze" className="text-sm text-text-muted">
              Automatically analyze my 5 most recent videos
            </label>
          </div>

          <button
            type="submit"
            disabled={!channel.trim()}
            className="btn-primary w-full"
          >
            Find My Videos
          </button>
        </form>

        {savedChannel && (
          <div className="mt-6 space-y-3">
            <button
              type="button"
              onClick={handleUseSaved}
              className="btn-primary w-full"
            >
              Use my channel
            </button>
            <button
              type="button"
              onClick={handleClear}
              className="w-full text-sm text-text-muted underline hover:text-text-primary"
            >
              Use a different channel
            </button>
          </div>
        )}

        <div className="mt-10 border-t border-white/10 pt-6">
          <p className="mb-4 text-center text-sm text-text-muted">
            Or paste a single video link instead
          </p>

          <SingleVideoAnalyze
            creatorId={creatorId}
            onResult={(postId) => router.push(`/dashboard/inbox/${postId}`)}
          />
        </div>
      </div>
    </div>
  )
}

function SingleVideoAnalyze({
  creatorId,
  onResult,
}: {
  creatorId: string | null
  onResult: (postId: string) => void
}) {
  const [url, setUrl] = useState('')
  const {
    start,
    status,
    progressText,
    progressPercent,
    error: analyzeError,
    result,
  } = useAnalyze(creatorId || '')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!url.trim() || status === 'running' || !creatorId) return
    await start(url.trim())
  }

  if (result && status === 'done') {
    return (
      <div className="card space-y-3">
        <p className="text-sm text-text-primary">
          Analysis complete — <span className="font-medium">{result.commentsIngested}</span> comments found.
        </p>
        <button
          onClick={() => onResult(result.postId)}
          className="btn-primary w-full"
        >
          View Results
        </button>
        <button
          type="button"
          onClick={() => {
            setUrl('')
          }}
          className="w-full text-sm text-text-muted underline hover:text-text-primary"
        >
          Analyze another
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <input
        type="url"
        value={url}
        onChange={e => setUrl(e.target.value)}
        placeholder="https://www.youtube.com/watch?v=..."
        disabled={status === 'running'}
        className="flex h-12 w-full rounded-lg border border-white/10 bg-surface px-4 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-purple focus:ring-offset-2 focus:ring-offset-ink disabled:opacity-50"
      />

      {status === 'running' && (
        <div className="space-y-2">
          <div className="h-2 overflow-hidden rounded-full bg-surface-hover">
            <div
              className="h-full rounded-full bg-purple transition-all duration-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <p className="text-xs text-text-muted">{progressText}</p>
        </div>
      )}

      {analyzeError && status === 'error' && (
        <p className="text-xs text-avax-red">{analyzeError}</p>
      )}

      <button
        type="submit"
        disabled={!url.trim() || status === 'running' || !creatorId}
        className="btn-primary w-full disabled:opacity-50"
      >
        {status === 'running' ? 'Analyzing...' : 'Analyze Video'}
      </button>
    </form>
  )
}
