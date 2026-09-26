'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useAnalyze } from '@/lib/hooks/useAnalyze'
import { BUSINESS_CATEGORIES } from '@/lib/business-categories'
import { MAX_VIDEOS_PER_SYNC } from '@/lib/channel-sync-limits'
import MascotIcon from '@/components/MascotIcon'
import { logError } from '@/lib/logger'

/** Quick picks offered next to the number input, filtered to what the channel has. */
const QUICK_PICKS = [20, 50, 100, 200]

const stepIconProps = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  className: 'h-5 w-5',
} as const

/**
 * The same three beats the product walkthrough uses, kept in the app's own card /
 * icon-badge language rather than imported as deck art. They double as a progress
 * indicator: the form highlights step 1, the count screen highlights step 2.
 */
const HOW_IT_WORKS = [
  {
    num: '01',
    tone: 'purple',
    label: 'Paste your channel',
    desc: 'We find it and count the public videos — nothing is saved yet.',
    icon: (
      <svg {...stepIconProps}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"
        />
      </svg>
    ),
  },
  {
    num: '02',
    tone: 'teal',
    label: 'Choose how many videos',
    desc: 'You see the real count first, then pick the number to bring in.',
    icon: (
      <svg {...stepIconProps}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75"
        />
      </svg>
    ),
  },
  {
    num: '03',
    tone: 'pink',
    label: 'Your agent gets to work',
    desc: 'Titles land in My Videos. You choose which ones it reads.',
    icon: (
      <svg {...stepIconProps}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z"
        />
      </svg>
    ),
  },
] as const

/**
 * Stacks as readable rows on a phone and spreads to three columns once there is
 * width for it. `activeStep` dims the steps the creator isn't on, so the strip
 * says where they are rather than just what the product does.
 */
function HowItWorks({ activeStep }: { activeStep: '01' | '02' }) {
  return (
    <section aria-labelledby="how-it-works">
      <h2
        id="how-it-works"
        className="font-mono text-[10px] tracking-widest text-text-muted uppercase"
      >
        How this works
      </h2>
      <ol className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {HOW_IT_WORKS.map(step => {
          const isActive = step.num === activeStep
          return (
            <li
              key={step.num}
              aria-current={isActive ? 'step' : undefined}
              className={`card flex items-start gap-3 transition-opacity sm:flex-col ${
                isActive ? '' : 'opacity-60'
              }`}
            >
              <span className={`icon-badge icon-badge-${step.tone}`} aria-hidden="true">
                {step.icon}
              </span>
              <div className="min-w-0">
                <span className="font-mono text-[10px] tracking-widest text-text-muted">
                  {step.num}
                </span>
                <h3 className="mt-0.5 font-display text-sm leading-snug font-semibold text-text-primary">
                  {step.label}
                </h3>
                <p className="mt-1 text-xs leading-snug text-text-muted">{step.desc}</p>
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

/**
 * One line on what this does that other comment tools don't. Deliberately short —
 * the creator is here to connect a channel, not to read a pitch.
 */
function TrustNote() {
  return (
    <p className="flex items-start gap-2.5 border-t border-white/10 pt-5 text-xs leading-relaxed text-text-muted">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        className="mt-px h-4 w-4 flex-shrink-0 text-teal"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 12.75 11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 0 1-1.043 3.296 3.745 3.745 0 0 1-3.296 1.043A3.745 3.745 0 0 1 12 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 0 1-3.296-1.043 3.745 3.745 0 0 1-1.043-3.296A3.745 3.745 0 0 1 3 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 0 1 1.043-3.296 3.746 3.746 0 0 1 3.296-1.043A3.746 3.746 0 0 1 12 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 0 1 3.296 1.043 3.746 3.746 0 0 1 1.043 3.296A3.745 3.745 0 0 1 21 12Z"
        />
      </svg>
      <span>
        Understands Sheng and Swahili code-switching most tools miss, and recognizes loyal
        customers with verifiable on-chain rewards.
      </span>
    </p>
  )
}

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

  // --- Verified ownership (Google OAuth) ---
  type OwnedChannel = { id: string; title: string; customUrl: string | null; thumbnailUrl: string | null; channelUrl: string }
  const [ownedChannels, setOwnedChannels] = useState<OwnedChannel[] | null>(null)
  const [loadingChannels, setLoadingChannels] = useState(false)
  const [oauthNotice, setOauthNotice] = useState<string | null>(null)

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

  // Read the result of the OAuth round trip, then load the channels Google says
  // this account owns. Runs on every mount, not only after a redirect: a creator
  // who connected last week should still see their verified channel offered
  // first rather than being sent back through consent.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const error = params.get('yt_error')
    if (error) {
      setOauthNotice(
        error === 'declined'
          ? 'You cancelled the Google sign-in. You can try again, or use the link option below.'
          : error === 'no_channels'
            ? 'That Google account signed in successfully, but it does not own a YouTube channel.'
            : error === 'channels_failed'
              ? "We connected to Google but couldn't read your channels. Please try again shortly."
              : error === 'expired'
                ? 'That Google sign-in link had expired — links are valid for 10 minutes. Please click Connect again.'
                : error === 'bad_state'
                  ? // The signed state didn't verify against this browser's session: most
                    // often a newer attempt in another tab replaced it, or the sign-in
                    // began in a different browser or account.
                    "That Google sign-in didn't match this browser session — usually because it was started in another tab, browser or account. Please click Connect again from this page."
                  : 'We could not complete the Google connection. Please try again.'
      )
    }

    // Clean the query string so a refresh doesn't replay the banner.
    if (error || params.get('yt_connected')) {
      window.history.replaceState({}, '', window.location.pathname)
    }

    let cancelled = false
    setLoadingChannels(true)
    fetch('/api/creator/youtube-channels')
      .then(res => res.json())
      .then(data => {
        if (cancelled) return
        setOwnedChannels(data.connected ? (data.channels ?? []) : [])
        if (data.revoked) {
          setOauthNotice('Your Google connection was revoked. Reconnect to enable replies and rewards.')
        }
      })
      .catch(() => { if (!cancelled) setOwnedChannels([]) })
      .finally(() => { if (!cancelled) setLoadingChannels(false) })

    return () => { cancelled = true }
  }, [])

  /**
   * Selecting a verified channel feeds the EXISTING flow. The OAuth step changes
   * only how the channel is identified — everything after this point (count
   * discovery, choose-how-many, live progress) is the same code path the pasted
   * link has always used, which is why this hands over a channel URL rather than
   * introducing a parallel sync.
   */
  async function handleSelectOwnedChannel(selected: OwnedChannel) {
    setChannel(selected.channelUrl)
    setFormError(null)
    setPhase('checking')
    try {
      const res = await fetch('/api/creator/channel/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_url: selected.channelUrl }),
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
      }).catch(err => logError('page.connect', err, { stage: 'save_business_category' }))
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
      <div className="mx-auto max-w-2xl space-y-8">
        <header>
          <p className="font-mono text-[10px] tracking-widest text-text-muted uppercase">
            Step 2 · Choose
          </p>
          <h1 className="mt-2 font-display text-2xl font-semibold text-text-primary md:text-3xl">
            We found {videoCount.toLocaleString()} {videoCount === 1 ? 'video' : 'videos'} in this channel.
          </h1>
        </header>

          {videoCount === 0 ? (
            <div className="card space-y-3">
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
              className="card space-y-4"
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

        <HowItWorks activeStep="02" />
        <TrustNote />
      </div>
    )
  }

  const checking = phase === 'checking'

  return (
    // Top-down flow, not a box centred in a tall empty viewport. The heading and
    // the input sit near the top where they're reachable without scrolling, and
    // the explanatory sections carry the rest of the page.
    <div className="mx-auto max-w-2xl space-y-8">
      <header>
        <p className="font-mono text-[10px] tracking-widest text-text-muted uppercase">
          Step 1 · Connect
        </p>
        <h1 className="mt-2 font-display text-3xl font-semibold text-text-primary md:text-4xl">
          Connect your channel
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-text-muted">
          We&apos;ll scan your channel, show you what we find, and let you decide how many
          videos to bring in — no automatic bulk processing without your say.
        </p>
      </header>

      {oauthNotice && (
        <p className="rounded-lg border border-white/10 bg-surface px-4 py-3 text-sm text-text-primary" role="status">
          {oauthNotice}
        </p>
      )}

      {/* PRIMARY PATH. Google answers "which channels does this account own?" —
          an answer the person filling in the form cannot influence, which is what
          unlocks drafted replies and rewards. */}
      <section aria-labelledby="verified-connect" className="card">
        <h2 id="verified-connect" className="font-mono text-[10px] tracking-widest text-text-muted uppercase">
          Recommended
        </h2>

        {loadingChannels ? (
          <p className="mt-3 text-sm text-text-muted">Checking your Google connection…</p>
        ) : ownedChannels && ownedChannels.length > 0 ? (
          <>
            <p className="mt-2 text-sm leading-relaxed text-text-primary">
              {ownedChannels.length === 1
                ? 'Google confirmed you own this channel.'
                : `Google confirmed you own ${ownedChannels.length} channels. Pick the one to connect.`}
            </p>
            <ul className="mt-3 space-y-2">
              {ownedChannels.map(owned => (
                <li key={owned.id}>
                  <button
                    type="button"
                    onClick={() => handleSelectOwnedChannel(owned)}
                    disabled={checking}
                    className="flex w-full items-center gap-3 rounded-xl border border-green/30 bg-surface p-3 text-left transition-colors hover:border-green/60 hover:bg-surface-hover disabled:opacity-60"
                  >
                    {owned.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={owned.thumbnailUrl} alt="" className="h-10 w-10 flex-shrink-0 rounded-full" />
                    ) : (
                      <span className="icon-badge icon-badge-green" aria-hidden="true" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block font-body text-sm font-medium text-text-primary">{owned.title}</span>
                      <span className="mt-0.5 block text-xs text-text-muted">
                        {owned.customUrl ?? owned.id}
                      </span>
                    </span>
                    <span className="flex-shrink-0 font-mono text-[10px] tracking-widest text-green uppercase">
                      Verified
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs leading-relaxed text-text-muted">
              Drafted replies and rewards are enabled for verified channels.
            </p>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm leading-relaxed text-text-primary">
              Sign in with Google to confirm which channel is yours. This unlocks drafted
              replies and audience rewards, which need proof of ownership.
            </p>
            {/* A plain link, not fetch(): the OAuth start route answers with a
                redirect to Google, and a full navigation is what has to happen. */}
            <a href="/api/auth/youtube/start" className="btn-primary mt-4 flex w-full items-center justify-center gap-2">
              <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                <path fill="#fff" d="M21.35 11.1H12v2.9h5.35c-.25 1.35-1.9 3.95-5.35 3.95A5.95 5.95 0 0 1 12 6.05c1.7 0 2.85.72 3.5 1.35l2.4-2.3A9.5 9.5 0 0 0 12 2.5a9.5 9.5 0 1 0 0 19c5.5 0 9.1-3.85 9.1-9.3 0-.62-.05-1.1-.15-1.6Z" />
              </svg>
              Connect with Google
            </a>
            <p className="mt-2 text-xs leading-relaxed text-text-muted">
              We ask only to read which channels you own and their audience analytics — never to post, edit or delete.
            </p>
          </>
        )}
      </section>

      {/* SECONDARY PATH, deliberately quieter. Analyzing a channel you don't own
          is legitimate research, so it stays available — with its limits stated up
          front rather than discovered later when drafts don't appear. */}
      <form onSubmit={handleFindVideos} className="card space-y-4">
          <div>
            <p className="font-mono text-[10px] tracking-widest text-text-muted uppercase">
              Or analyze any channel, for research
            </p>
            <p className="mt-2 mb-3 text-xs leading-relaxed text-text-muted">
              Paste any channel link to read and analyze its comments — categories, sentiment,
              topics and Research chat all work. Drafted replies and rewards stay unavailable
              until ownership is verified above.
            </p>
            <label htmlFor="channel-url" className="mb-2 block text-sm font-medium text-text-muted">
              Channel link
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
            {checking ? 'Checking that channel…' : 'Find videos'}
          </button>

        {savedChannel && (
          <div className="space-y-3 border-t border-white/10 pt-4">
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
      </form>

      <HowItWorks activeStep="01" />

      <section aria-labelledby="single-video">
        <h2
          id="single-video"
          className="font-mono text-[10px] tracking-widest text-text-muted uppercase"
        >
          Just one video?
        </h2>
        <p className="mt-2 mb-3 text-sm text-text-muted">
          Paste a single video link and your agent reads it straight away.
        </p>

        <SingleVideoAnalyze
          creatorId={creatorId}
          onResult={(postId) => router.push(`/dashboard/inbox/${postId}`)}
        />
      </section>

      <TrustNote />
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
