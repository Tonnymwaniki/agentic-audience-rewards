'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

/**
 * Root error boundary, for routes outside the dashboard — the landing page, the
 * login screen and the public reward-claim pages.
 *
 * The dashboard has its own boundary (app/dashboard/error.tsx) that keeps the
 * dashboard chrome mounted. This one covers everything else, where there is no
 * chrome to preserve, so it is self-contained and links home rather than to a
 * signed-in route a visitor may have no access to.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const router = useRouter()

  /**
   * See app/dashboard/error.tsx for the full note: reset() on its own re-renders
   * from the client router cache, which still holds the error for a segment whose
   * Server Component threw, so the button issues no request and nothing changes.
   * refresh() invalidates that cache first.
   */
  function handleRetry() {
    router.refresh()
    reset()
  }

  useEffect(() => {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        context: 'root.error-boundary',
        message: error.message,
        error: { name: error.name, message: error.message, stack: error.stack },
        metadata: { digest: error.digest ?? null, path: typeof window !== 'undefined' ? window.location.pathname : null },
      })
    )
  }, [error])

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center">
      <p className="font-mono text-[10px] tracking-widest text-text-muted uppercase">Notice</p>
      <h1 className="mt-3 font-display text-2xl font-semibold text-text-primary">
        Something went wrong
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-text-muted">
        We hit a problem loading this page. Nothing was lost — please try again.
      </p>

      <div className="mt-7 w-full space-y-3">
        <button type="button" onClick={handleRetry} className="btn-primary w-full">
          Try again
        </button>
        <Link
          href="/"
          className="flex min-h-11 w-full items-center justify-center rounded-lg border border-white/10 bg-surface text-sm text-text-muted transition-colors hover:border-purple/40 hover:text-text-primary"
        >
          Go home
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
