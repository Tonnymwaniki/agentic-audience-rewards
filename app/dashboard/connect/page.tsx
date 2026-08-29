'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useAnalyze } from '@/lib/hooks/useAnalyze'

export default function ConnectPage() {
  const [channel, setChannel] = useState('')
  const [savedChannel, setSavedChannel] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [creatorId, setCreatorId] = useState<string | null>(null)
  const router = useRouter()

  const {
    start: startAnalysis,
    status,
    progressText,
    progressPercent,
    error: analyzeError,
    result,
  } = useAnalyze(creatorId || '')

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
        .select('id, channel_url')
        .eq('user_id', user.id)
        .single()

      if (creator) {
        setCreatorId(creator.id)
        if (creator.channel_url) {
          setSavedChannel(creator.channel_url)
          setChannel(creator.channel_url)
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
      }
    } catch (err) {
      console.error('Save channel error:', err)
    }

    router.push(`/dashboard/connect/pick?channel=${encodeURIComponent(trimmed)}`)
  }

  function handleUseSaved() {
    if (savedChannel) {
      router.push(`/dashboard/connect/pick?channel=${encodeURIComponent(savedChannel)}`)
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
              className="flex h-12 w-full rounded-lg border border-white/10 bg-surface px-4 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-cobalt focus:ring-offset-2 focus:ring-offset-ink"
            />
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
        className="flex h-12 w-full rounded-lg border border-white/10 bg-surface px-4 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-cobalt focus:ring-offset-2 focus:ring-offset-ink disabled:opacity-50"
      />

      {status === 'running' && (
        <div className="space-y-2">
          <div className="h-2 overflow-hidden rounded-full bg-surface-hover">
            <div
              className="h-full rounded-full bg-cobalt transition-all duration-500"
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
