import { NextRequest, NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { loadProfileFacts, reconfirmFact } from '@/lib/profile-fact-status'
import { logError } from '@/lib/logger'

/**
 * "Yes, still accurate" on the Business Profile page: refreshes a field's confirmed
 * timestamp (ending its STALE state) and clears any contradiction flag, without a
 * full re-edit. The creator comes from the session, and only a field this creator
 * actually has filled in can be confirmed.
 */
export async function POST(request: NextRequest) {
  try {
    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response
    const { supabase, creatorId } = authResult.auth

    const body = await request.json().catch(() => ({}))
    const source = body.source === 'fixed' || body.source === 'custom' ? body.source : null
    const fieldKey = typeof body.field_key === 'string' ? body.field_key : ''
    if (!source || !fieldKey) return NextResponse.json({ error: 'source and field_key are required' }, { status: 400 })

    const facts = await loadProfileFacts(supabase, creatorId)
    if (!facts.some(f => f.source === source && f.field_key === fieldKey)) {
      return NextResponse.json({ error: 'No filled-in field by that name' }, { status: 404 })
    }

    const { data, error } = await reconfirmFact(supabase, creatorId, source, fieldKey)
    if (error || !data) {
      logError('api/creator/profile/confirm', error, { creator_id: creatorId, source, field_key: fieldKey })
      return NextResponse.json({ error: 'Could not confirm this field' }, { status: 500 })
    }
    return NextResponse.json({ success: true, confirmed_at: data.confirmed_at })
  } catch (err) {
    logError('api/creator/profile/confirm', err, { stage: 'request' })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
