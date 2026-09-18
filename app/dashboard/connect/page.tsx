'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useAnalyze } from '@/lib/hooks/useAnalyze'
import { BUSINESS_CATEGORIES } from '@/lib/business-categories'
import { MAX_VIDEOS_PER_SYNC } from '@/lib/channel-sync-limits'
import MascotIcon from '@/components/MascotIcon'

/** Quick picks offered next to the number input, filtered to what the channel has. */
const QUICK_PICKS = [20, 50, 100, 200]

/**
 * Connect is discovery only: find the channel, choose how many recent videos to
 * list, bring them into My Videos. It never analyzes anything — every video lands
 * unanalyzed, and analysis is a separate per-video action in My Videos.
 *
 *   form -> checking -> choose -> syncing -> leaving (redirect to My Videos)
 */
type Phase = 'form' | 'checking' | 'choose' | 'syncing' | 'leaving' | 'sync_error'

export default function ConnectPage() {
  const [channel, setChannel] = useState('')
  const [savedChannel, setSavedChannel] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [creatorId, setCreatorId] = useState<string | null>(null)
  const [category, setCategory] = useState<string | null>(null)
  const [alreadyCategorized, setAlreadyCategorized] = useState(false)
  const router = useRouter()

  const [phase, setPhase] = useState<Phase>('form')
  const [formError, setFormError] = useState<string | null>(null)
  // From the quick count.
  const [videoCount, setVideoCount] = useState(0)
  const [maxSelectable, setMaxSelectable] = useState(0)
  // Kept as the raw input text so a creator can clear the field and type freely.
  const [chosen, setChosen] = useState('')
  // The sync in progress.
  const [target, setTarget] = useState(0)
  const [brought, setBrought] = useState(0)

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

  // Polls the background sync. Stops as soon as it finishes, so a completed sync
  // doesn't leave an interval running for the life of the page.
  useEffect(() => {
    if (phase !== 'syncing') return

    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/creator/channel/sync-status')
        if (!res.ok) return
        const data = await res.json()
        setBrought(data.videosSynced ?? 0)

        if (data.status === 'done') {
          clearInterval(interval)
          setPhase('leaving')
          router.push('/dashboard/inbox')
        } else if (data.status === 'error') {
          clearInterval(interval)
          setPhase('sync_error')
        }
      } catch {
        // transient; the next tick retries
      }
    }, 1500)

    return () => clearInterval(interval)
  }, [phase, router])

  // Step 1: a quick count, nothing saved yet.
  async function handleFindVideos(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = channel.trim()
    if (!trimmed) return

    setFormError(null)
    setPhase('checking')
    try {
      const res = await fetch('/api/creator/channel/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_url: trimmed }),
      })
      const data = await res.json()
      if (!res.ok) {
        setFormError(data.error || 'Something went wrong. Please try again.')
        setPhase('form')
        return
      }
      setVideoCount(data.videoCount)
      setMaxSelectable(data.maxSelectable)
      setChosen(String(data.suggested))
      setPhase('choose')
    } catch {
      setFormError("Couldn't check that channel. Please try again.")
      setPhase('form')
    }
  }

  const chosenNumber = Number(chosen)
  const chosenIsValid = /^\d+$/.test(chosen) && chosenNumber >= 1 && chosenNumber <= maxSelectable

  // Step 2: bring exactly that many in.
  async function handleBringIn() {
    if (!chosenIsValid) return
    setFormError(null)

    // Saved separately so a category failure can't block connecting the channel.
    if (category && !alreadyCategorized) {
      fetch('/api/creator/category', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_category: category }),
      }).catch(err => console.error('Save business category error:', err))
    }

    try {
      const res = await fetch('/api/creator/channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_url: channel.trim(), video_limit: chosenNumber }),
      })
      const data = await res.json()
      if (!res.ok) {
        setFormError(data.error || 'Could not start bringing in your videos.')
        return
      }
      setTarget(chosenNumber)
      setBrought(0)
      setPhase('syncing')
    } catch {
      setFormError('Could not start bringing in your videos. Please try again.')
    }
  }

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
      <div className="flex min-h-[70vh] items-center justify-center">
        <p className="text-text-muted">Loading...</p>
      </div>
    )
  }

  if (phase === 'syncing' || phase === 'leaving' || phase === 'sync_error') {
    const shown = Math.min(brought, target)
    const percent = target > 0 ? Math.round((shown / target) * 100) : 0

    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <div className="w-full max-w-md text-center">
          <div className="flex justify-center">
            <MascotIcon type="agent" />
          </div>

          {phase === 'syncing' && (
            <>
              <h1 className="mt-5 font-display text-2xl font-semibold text-text-primary">
                Bringing your videos into My Videos
              </h1>
              {/* The count is rows already stored, not videos merely found. */}
              <p className="mt-2 text-sm text-text-muted" aria-live="polite">
                {shown === 0
                  ? `Starting on your ${target.toLocaleString()} most recent videos…`
                  : `Bringing video ${shown.toLocaleString()} of ${target.toLocaleString()}…`}
              </p>
              <div
                className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-surface-hover"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={target}
                aria-valuenow={shown}
              >
                <div
                  className="gradient-primary h-full rounded-full transition-all duration-500"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <p className="mt-4 text-xs text-text-muted">
                Just titles and thumbnails — nothing is analyzed yet. You choose what to analyze in My Videos.
              </p>
            </>
          )}

          {phase === 'leaving' && (
            <h1 className="mt-5 font-display text-2xl font-semibold text-text-primary">
              Opening My Videos…
            </h1>
          )}

          {phase === 'sync_error' && (
            <>
              <h1 className="mt-5 font-display text-2xl font-semibold text-text-primary">
                We couldn&apos;t bring in all your videos
              </h1>
              <p className="mt-2 text-sm text-text-muted">
                {shown > 0
                  ? `${shown.toLocaleString()} of ${target.toLocaleString()} made it into My Videos before something went wrong.`
                  : 'Something went wrong before any videos were brought in.'}
              </p>
              <div className="mt-5 space-y-3">
                <button type="button" onClick={handleBringIn} className="btn-primary w-full">
                  Try again
                </button>
                <button
                  type="button"
                  onClick={() => router.push('/dashboard/inbox')}
                  className="w-full text-sm text-text-muted underline hover:text-text-primary"
                >
                  Go to My Videos
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    )
  }

  if (phase === 'choose') {
    const picks = QUICK_PICKS.filter(n => n < maxSelectable)
    const pickClass = (selected: boolean) =>
      `min-h-11 rounded-full border px-4 text-sm transition-colors ${
        selected ? 'border-purple bg-purple text-white' : 'border-white/10 bg-surface text-text-muted hover:text-text-primary'
      }`

    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <div className="w-full max-w-md">
          <h1 className="text-center font-display text-2xl font-semibold text-text-primary md:text-3xl">
            We found {videoCount.toLocaleString()} {videoCount === 1 ? 'video' : 'videos'} in this channel.
          </h1>

          {videoCount === 0 ? (
            <div className="mt-8 space-y-3 text-center">
              <p className="text-sm text-text-muted">There are no public videos to bring in yet.</p>
              <button type="button" onClick={() => setPhase('form')} className="btn-primary w-full">
                Try a different channel
              </button>
            </div>
          ) : (
            <form
              onSubmit={e => {
                e.preventDefault()
                handleBringIn()
              }}
              className="mt-8 space-y-4"
            >
              <div>
                <label htmlFor="video-limit" className="mb-2 block text-sm font-medium text-text-primary">
                  How many would you like to bring into My Videos?
                </label>
                <input
                  id="video-limit"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={maxSelectable}
                  step={1}
                  value={chosen}
                  onChange={e => setChosen(e.target.value)}
                  aria-describedby="video-limit-help"
                  className="flex h-12 w-full rounded-lg border border-white/10 bg-surface px-4 text-base text-text-primary focus:outline-none focus:ring-2 focus:ring-purple focus:ring-offset-2 focus:ring-offset-ink"
                />
                <p id="video-limit-help" className="mt-2 text-xs text-text-muted">
                  Most recent first, 1 to {maxSelectable.toLocaleString()}.
                  {videoCount > MAX_VIDEOS_PER_SYNC &&
                    ` Up to ${MAX_VIDEOS_PER_SYNC} per session — you can bring in more later.`}
                </p>
                {chosen !== '' && !chosenIsValid && (
                  <p className="mt-1 text-xs text-avax-red" role="alert">
                    Enter a whole number from 1 to {maxSelectable.toLocaleString()}.
                  </p>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                {picks.map(n => (
                  <button key={n} type="button" onClick={() => setChosen(String(n))} className={pickClass(chosenNumber === n)}>
                    {n}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setChosen(String(maxSelectable))}
                  className={pickClass(chosenNumber === maxSelectable)}
                >
                  {videoCount <= MAX_VIDEOS_PER_SYNC ? `All ${maxSelectable}` : `Max ${maxSelectable}`}
                </button>
              </div>

              <p className="text-xs text-text-muted">
                We only bring in titles and thumbnails. Nothing is analyzed until you choose a video in My Videos.
              </p>

              {formError && (
                <p className="text-sm text-avax-red" role="alert">
                  {formError}
                </p>
              )}

              <button type="submit" disabled={!chosenIsValid} className="btn-primary w-full disabled:opacity-50">
                {chosenIsValid
                  ? `Bring ${chosenNumber.toLocaleString()} ${chosenNumber === 1 ? 'video' : 'videos'} into My Videos`
                  : 'Bring videos into My Videos'}
              </button>
              <button
                type="button"
                onClick={() => setPhase('form')}
                className="w-full text-sm text-text-muted underline hover:text-text-primary"
              >
                Use a different channel
              </button>
            </form>
          )}
        </div>
      </div>
    )
  }

  const checking = phase === 'checking'

  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <div className="w-full max-w-md">
        <div className="text-center">
          <h1 className="font-display text-3xl font-semibold text-text-primary md:text-4xl">
            Connect your channel
          </h1>
          <p className="mt-3 text-sm text-text-muted">
            Paste your channel link and we&apos;ll find your videos.
          </p>
        </div>

        <form onSubmit={handleFindVideos} className="mt-8 space-y-4">
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
              disabled={checking}
              className="flex h-12 w-full rounded-lg border border-white/10 bg-surface px-4 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-purple focus:ring-offset-2 focus:ring-offset-ink disabled:opacity-50"
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

          {formError && (
            <p className="text-sm text-avax-red" role="alert">
              {formError}
            </p>
          )}

          <button type="submit" disabled={!channel.trim() || checking} className="btn-primary w-full disabled:opacity-50">
            {checking ? 'Checking your channel…' : 'Find My Videos'}
          </button>
        </form>

        {savedChannel && (
          <div className="mt-6 space-y-3">
            <button type="button" onClick={handleUseSaved} className="btn-primary w-full">
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
