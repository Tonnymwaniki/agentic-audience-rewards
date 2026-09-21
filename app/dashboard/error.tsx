'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import MascotIcon from '@/components/MascotIcon'

/**
 * Dashboard error boundary.
 *
 * Next renders this in place of the route's page when a Server Component throws
 * during render or a Client Component throws while rendering. It replaces only
 * the page content — the dashboard layout, its nav and the mobile tab bar stay
 * mounted — so a creator who hits an error can still navigate away instead of
 * being stranded on a blank screen.
 *
 * Deliberately NOT showing `error.message`. In production Next already replaces
 * the message with a generic string and a digest, and the raw text is an internal
 * detail — a Postgres constraint name or a file path — that helps an attacker and
 * means nothing to a creator. The digest IS shown, because it is the one token
 * that ties this screen to the server log line that recorded the real cause.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const router = useRouter()

  /**
   * `reset()` ALONE IS NOT ENOUGH, and this was verified rather than assumed: it
   * re-renders the boundary's children from the client's router cache, and when a
   * Server Component threw, the cached entry for that segment is still the error.
   * Clicking "Try again" then made no request at all — recorded in a browser test,
   * where the only traffic was Next's own dev stack-frame calls — so the button
   * looked functional and did nothing.
   *
   * router.refresh() invalidates that cache and refetches the segment from the
   * server; reset() then re-renders the boundary with the fresh result. Both are
   * needed, in this order.
   */
  function handleRetry() {
    router.refresh()
    reset()
  }

  useEffect(() => {
    // Client-side, so this reaches the browser console and any future browser SDK;
    // the structured server logger cannot run here. Server-thrown errors are
    // already logged on the server, where the stack is real.
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        context: 'dashboard.error-boundary',
        message: error.message,
        error: { name: error.name, message: error.message, stack: error.stack },
        metadata: { digest: error.digest ?? null, path: typeof window !== 'undefined' ? window.location.pathname : null },
      })
    )
  }, [error])

  return (
    <div className="mx-auto flex max-w-md flex-col items-center py-10 text-center">
      <MascotIcon type="agent" />

      <h1 className="mt-5 font-display text-2xl font-semibold text-text-primary">
        Something went wrong
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-text-muted">
        Your agent hit a problem loading this page. Your data is safe — nothing was
        lost, and nothing was changed.
      </p>

      <div className="mt-7 w-full space-y-3">
        <button type="button" onClick={handleRetry} className="btn-primary w-full">
          Try again
        </button>
        <Link
          href="/dashboard/agent"
          className="flex min-h-11 w-full items-center justify-center rounded-lg border border-white/10 bg-surface text-sm text-text-muted transition-colors hover:border-purple/40 hover:text-text-primary"
        >
          Back to My Agent
        </Link>
      </div>

      {error.digest && (
        <p className="mt-6 font-mono text-[10px] tracking-widest text-text-muted/70 uppercase">
          Reference {error.digest}
        </p>
      )}
    </div>
  )
}
