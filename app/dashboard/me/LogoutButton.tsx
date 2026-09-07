'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function LogoutButton() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  async function handleLogout() {
    if (loading) return
    setLoading(true)
    setError(null)

    try {
      const supabase = createClient()
      const { error: signOutError } = await supabase.auth.signOut()
      if (signOutError) throw signOutError

      // replace, not push: after signing out the dashboard is gone, so leaving it
      // in history would let the back button return to a page that immediately
      // bounces to /login anyway.
      router.replace('/login')
      // Server Components cache per-route; without this the next authenticated
      // navigation could render from a cache built with the old session.
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not log out')
      setLoading(false)
    }
  }

  return (
    <div>
      <button
        onClick={handleLogout}
        disabled={loading}
        className="flex w-full items-center gap-3 rounded-xl border border-avax-red/25 bg-surface p-4 text-left transition-colors hover:border-avax-red/50 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span
          className="icon-badge flex-shrink-0 text-avax-red"
          style={{ background: 'rgba(232, 65, 66, 0.15)' }}
          aria-hidden="true"
        >
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
              d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9"
            />
          </svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-body text-sm font-medium text-avax-red">
            {loading ? 'Logging out…' : 'Log out'}
          </span>
          <span className="mt-0.5 block text-xs leading-snug text-text-muted">
            End this session on this device
          </span>
        </span>
      </button>
      {error && <p className="mt-2 text-xs text-avax-red">{error}</p>}
    </div>
  )
}
