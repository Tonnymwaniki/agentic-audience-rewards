import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { refreshAudienceInsights } from '@/lib/audience-insights'
import { isCronAuthorized } from '@/lib/cron-auth'

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
    console.error('Compute insights: CRON_SECRET is not configured')
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
  }

  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  const { data: posts, error } = await supabase.from('posts').select('creator_id')
  if (error) {
    console.error('Compute insights: could not list creators', error.message)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  const creatorIds = [...new Set((posts ?? []).map(p => p.creator_id as string))]
  const now = new Date()
  const results: Array<{ creator_id: string; stored?: number; error?: string }> = []

  for (const creatorId of creatorIds) {
    try {
      const { stored } = await refreshAudienceInsights(supabase, creatorId, now)
      results.push({ creator_id: creatorId, stored })
    } catch (err) {
      console.error('Compute insights: creator failed', creatorId, err instanceof Error ? err.message : err)
      results.push({ creator_id: creatorId, error: err instanceof Error ? err.message : 'Unknown error' })
    }
  }

  return NextResponse.json({ success: true, creators: results.length, results })
}
