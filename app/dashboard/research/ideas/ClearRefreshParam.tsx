'use client'

import { useEffect } from 'react'

/**
 * Drops ?refresh=1 from the address bar once a regeneration has started, so a
 * later reload or share of the URL reads the cache instead of paying for another
 * model call.
 */
export function ClearRefreshParam() {
  useEffect(() => {
    window.history.replaceState(null, '', '/dashboard/research/ideas')
  }, [])
  return null
}
