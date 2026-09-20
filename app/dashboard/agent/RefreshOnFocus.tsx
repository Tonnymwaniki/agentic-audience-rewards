'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

/** Ignore a tab-away shorter than this — flicking to another tab and back is not a visit. */
const MIN_AWAY_MS = 30_000
/** Never re-fetch more often than this, however much the tab is focused and blurred. */
const MIN_BETWEEN_REFRESH_MS = 15_000

/**
 * Re-runs Agent Home's server render when the creator comes back to an already-open
 * tab.
 *
 * The page is `dynamic = 'force-dynamic'`, so *navigating* to it always renders
 * fresh — there is nothing to fix there. What it could not do is notice that an
 * hour passed while the tab sat in the background: the stats, the category mix and
 * the recognized-people cards all stayed frozen at whatever they were when the tab
 * was opened. router.refresh() re-runs the server component and patches the tree in
 * place, keeping scroll position and any client state.
 *
 * Renders nothing. Two guards keep it from becoming a polling loop: the tab must
 * have been genuinely away (MIN_AWAY_MS), and refreshes are rate-limited
 * (MIN_BETWEEN_REFRESH_MS) so alt-tabbing repeatedly can't hammer the server.
 */
export default function RefreshOnFocus() {
  const router = useRouter()
  const hiddenAt = useRef<number | null>(null)
  const lastRefresh = useRef<number>(Date.now())

  useEffect(() => {
    function maybeRefresh() {
      const now = Date.now()
      const awayFor = hiddenAt.current === null ? Infinity : now - hiddenAt.current
      hiddenAt.current = null

      if (awayFor < MIN_AWAY_MS) return
      if (now - lastRefresh.current < MIN_BETWEEN_REFRESH_MS) return

      lastRefresh.current = now
      router.refresh()
    }

    function onVisibility() {
      if (document.visibilityState === 'hidden') {
        hiddenAt.current = Date.now()
        return
      }
      maybeRefresh()
    }

    function onBlur() {
      hiddenAt.current = Date.now()
    }

    document.addEventListener('visibilitychange', onVisibility)
    // focus as well as visibilitychange: moving between two windows on a desktop
    // fires focus/blur without the document ever becoming hidden.
    window.addEventListener('focus', maybeRefresh)
    window.addEventListener('blur', onBlur)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', maybeRefresh)
      window.removeEventListener('blur', onBlur)
    }
  }, [router])

  return null
}
