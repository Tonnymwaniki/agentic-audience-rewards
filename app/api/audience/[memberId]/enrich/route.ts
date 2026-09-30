import { NextRequest, NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { enrichAudienceMember } from '@/lib/audience-enrichment'
import { logError } from '@/lib/logger'

/**
 * Phase 5 of the Audience Profiles concept: on-demand YouTube channel enrichment
 * for one commenter, triggered from their profile page (never in bulk, never
 * during ingestion — see lib/audience-enrichment.ts for why).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ memberId: string }> }) {
  try {
    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response

    const { memberId } = await params

    const result = await enrichAudienceMember(authResult.auth.supabase, memberId, authResult.auth.creatorId)

    if (!result.success && result.reason === 'not_found') {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
    }
    if (!result.success && result.reason === 'no_channel_id') {
      return NextResponse.json({ error: 'This commenter has no linked YouTube channel to look up' }, { status: 422 })
    }
    if (!result.success) {
      return NextResponse.json({ error: 'Could not fetch this channel right now' }, { status: 502 })
    }

    return NextResponse.json({ success: true, fetched: result.fetched })
  } catch (err) {
    logError('api/audience/enrich', err, { stage: 'request' })
    return NextResponse.json({ error: 'Failed to enrich profile' }, { status: 500 })
  }
}
