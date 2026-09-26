import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { refreshAudienceInsights } from '@/lib/audience-insights'
import { runInsightAgent } from '@/lib/insight-agent'
import { isCronAuthorized } from '@/lib/cron-auth'
import { logError } from '@/lib/logger'

// One pass over every creator with videos. Measured at ~3-5s per creator on
// ~650 comments; raise the plan's limit before this approaches it.
export const maxDuration = 300

/**
 * Daily recompute of audience_insights for every creator, scheduled in
 * vercel.json after the comment poll so each day's insights include that
 * morning's new comments.
 *
 * Creators are processed independently: one failing (bad data, a timeout) is
 * reported and the rest still refresh, and its previous insights stay in place.
 */
export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET) {
    logError('api/cron/compute-insights', new Error('CRON_SECRET is not configured'), { stage: 'auth_precondition' })
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
  }

  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  const { data: posts, error } = await supabase.from('posts').select('creator_id')
  if (error) {
    logError('api/cron/compute-insights', error, { stage: 'list_creators' })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  const creatorIds = [...new Set((posts ?? []).map(p => p.creator_id as string))]
  const now = new Date()
  const results: Array<{ creator_id: string; stored?: number; insightAgent?: unknown; error?: string }> = []

  for (const creatorId of creatorIds) {
    try {
      // The Insight Agent runs right after each creator's insights are stored, and
      // turns genuinely notable swings into inbox notifications (lib/insight-agent).
      const { stored, insightAgent } = await refreshAudienceInsights(supabase, creatorId, now, { insightAgent: runInsightAgent })
      results.push({ creator_id: creatorId, stored, insightAgent })
    } catch (err) {
      logError('api/cron/compute-insights', err, { creator_id: creatorId, stage: 'compute_for_creator' })
      results.push({ creator_id: creatorId, error: err instanceof Error ? err.message : 'Unknown error' })
    }
  }

  return NextResponse.json({ success: true, creators: results.length, results })
}
