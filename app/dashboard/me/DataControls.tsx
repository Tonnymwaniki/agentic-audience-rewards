'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

/** Typed verbatim before the delete button does anything. */
const CONFIRMATION = 'DELETE'

function DownloadIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      className="h-5 w-5"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"
      />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      className="h-5 w-5"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
      />
    </svg>
  )
}

function DownloadMyData() {
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function handleDownload() {
    if (state === 'working') return
    setState('working')
    setError(null)

    try {
      const res = await fetch('/api/creator/export')
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Could not build your export.')
      }

      // Read as a blob and save it from memory rather than navigating to the URL:
      // a navigation would leave the dashboard, and a failed export would render
      // raw JSON in place of the page.
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `notice-data-export-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(link)
      link.click()
      link.remove()
      // Revoking immediately can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 10000)

      setState('idle')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build your export.')
      setState('error')
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleDownload}
        disabled={state === 'working'}
        className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-surface p-4 text-left transition-colors hover:border-purple/40 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="icon-badge icon-badge-teal" aria-hidden="true">
          <DownloadIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-body text-sm font-medium text-text-primary">
            {state === 'working' ? 'Preparing your file…' : 'Download my data'}
          </span>
          <span className="mt-0.5 block text-xs leading-snug text-text-muted">
            Your profile, videos, comments and categorizations as JSON
          </span>
        </span>
      </button>
      {error && (
        <p className="mt-2 text-xs text-avax-red" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function DeleteMyAccount() {
  const [armed, setArmed] = useState(false)
  const [typed, setTyped] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  const confirmed = typed.trim() === CONFIRMATION

  function cancel() {
    setArmed(false)
    setTyped('')
    setError(null)
  }

  async function handleDelete() {
    if (!confirmed || deleting) return
    setDeleting(true)
    setError(null)

    try {
      const res = await fetch('/api/creator/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: CONFIRMATION }),
      })
      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        throw new Error(data.error || 'Could not delete your account.')
      }

      // The auth user is already gone server-side; this clears the local session
      // cookie so the app doesn't briefly render with a token for a dead user.
      await createClient().auth.signOut().catch(() => {})
      router.replace('/login')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete your account.')
      setDeleting(false)
    }
  }

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        className="flex w-full items-center gap-3 rounded-xl border border-avax-red/25 bg-surface p-4 text-left transition-colors hover:border-avax-red/50 hover:bg-surface-hover"
      >
        <span
          className="icon-badge flex-shrink-0 text-avax-red"
          style={{ background: 'rgba(232, 65, 66, 0.15)' }}
          aria-hidden="true"
        >
          <TrashIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-body text-sm font-medium text-avax-red">
            Delete my account
          </span>
          <span className="mt-0.5 block text-xs leading-snug text-text-muted">
            Permanently remove your account and all its data
          </span>
        </span>
      </button>
    )
  }

  return (
    <div
      className="rounded-xl border border-avax-red/40 bg-surface p-4"
      role="alertdialog"
      aria-labelledby="delete-warning"
    >
      <p id="delete-warning" className="text-sm leading-relaxed font-medium text-avax-red">
        This permanently deletes your account and all associated data — this cannot be undone.
      </p>
      <p className="mt-2 text-xs leading-relaxed text-text-muted">
        Your videos, comments, categorizations, drafted replies, recognized people and reward
        history will all be removed. Consider downloading your data first.
      </p>

      <label htmlFor="delete-confirm" className="mt-4 block text-xs text-text-muted">
        Type <span className="font-mono font-medium text-text-primary">{CONFIRMATION}</span> to
        confirm
      </label>
      <input
        id="delete-confirm"
        type="text"
        value={typed}
        onChange={e => setTyped(e.target.value)}
        autoComplete="off"
        disabled={deleting}
        aria-describedby="delete-warning"
        className="mt-1.5 flex h-12 w-full rounded-lg border border-white/10 bg-ink px-4 font-mono text-base text-text-primary focus:border-avax-red focus:ring-2 focus:ring-avax-red focus:outline-none disabled:opacity-50"
      />

      {error && (
        <p className="mt-2 text-xs text-avax-red" role="alert">
          {error}
        </p>
      )}

      <div className="mt-4 space-y-2">
        <button
          type="button"
          onClick={handleDelete}
          disabled={!confirmed || deleting}
          className="min-h-11 w-full rounded-lg bg-avax-red px-4 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {deleting ? 'Deleting your account…' : 'Permanently delete my account'}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={deleting}
          className="min-h-11 w-full text-sm text-text-muted underline hover:text-text-primary disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

export default function DataControls() {
  return (
    <section aria-labelledby="data-controls" className="space-y-3">
      <h2
        id="data-controls"
        className="font-mono text-[10px] tracking-widest text-text-muted uppercase"
      >
        Your data
      </h2>
      <DownloadMyData />
      <DeleteMyAccount />
    </section>
  )
}
