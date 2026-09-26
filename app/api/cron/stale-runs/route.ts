import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { isCronAuthorized } from '@/lib/cron-auth'
import { reconcileStaleRuns } from '@/lib/analysis-staleness'
import { logError, logInfo } from '@/lib/logger'

// Backstop for stale-run detection. The status endpoint already resolves a dead
// run the next time anyone polls it; this catches posts nobody opens again, so no
// row is left 'running' indefinitely in exports, counts or future features.
export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET) {
    logError('api/cron/stale-runs', new Error('CRON_SECRET is not configured'), { stage: 'auth_precondition' })
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
  }

  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const reconciled = await reconcileStaleRuns(createServiceClient())
  logInfo('api/cron/stale-runs', 'Stale-run sweep finished', { reconciled: reconciled.length })

  return NextResponse.json({
    reconciled: reconciled.map(r => ({ post_id: r.postId, status: r.outcome.status, stage: r.outcome.stage })),
  })
}
