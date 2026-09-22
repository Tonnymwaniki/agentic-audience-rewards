import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { regenerateDraftsForCreator } from '@/lib/draft-regeneration'
import { saveCustomProfileValues } from '@/lib/custom-profile-fields'
import { logError, logInfo } from '@/lib/logger'

// The save itself returns immediately; this headroom is for the after() work,
// which re-drafts replies across every one of the creator's videos.
export const maxDuration = 300

const PROFILE_FIELDS = [
  // Cleared to NULL like the rest, which is what makes Agent Home's greeting fall
  // back to the email address.
  'display_name',
  'business_phone',
  'business_whatsapp',
  'business_location',
  'business_hours',
  'business_website',
  'delivery_info',
] as const

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response
    const { supabase, creatorId } = authResult.auth

    // Only the known profile columns are writable here — anything else in the
    // body is ignored rather than passed through to the update.
    const updates: Record<string, string | null> = {}

    for (const field of PROFILE_FIELDS) {
      const value = body[field]
      if (typeof value !== 'string') continue
      const trimmed = value.trim()
      // Store a cleared field as NULL, not "", so "has the creator told us this?"
      // stays a simple null check for whatever reads it later.
      updates[field] = trimmed.length > 0 ? trimmed : null
    }

    // Custom field values arrive under their own key. saveCustomProfileValues only
    // writes keys that already exist for this creator, so a crafted body cannot
    // invent a field and inject text into the draft-reply prompt.
    const customFieldValues: Record<string, string> = {}
    if (body.custom_fields && typeof body.custom_fields === 'object') {
      for (const [key, value] of Object.entries(body.custom_fields as Record<string, unknown>)) {
        if (typeof value === 'string') customFieldValues[key] = value
      }
    }

    const customWritten =
      Object.keys(customFieldValues).length > 0
        ? await saveCustomProfileValues(supabase, creatorId, customFieldValues)
        : 0

    if (Object.keys(updates).length === 0) {
      // Custom-only saves are legitimate: a creator may fill in just the
      // personalised section and leave every fixed field blank.
      if (customWritten > 0) return NextResponse.json({ success: true, customFieldsSaved: customWritten })
      return NextResponse.json({ error: 'No profile fields provided' }, { status: 400 })
    }

    const { error: updateError } = await supabase
      .from('creators')
      .update(updates)
      .eq('id', creatorId)

    if (updateError) {
      logError('api/creator/profile', updateError, { creator_id: creatorId, stage: 'update_profile' })
      return NextResponse.json({ error: 'Failed to save your business profile' }, { status: 500 })
    }

    // Newly-saved business facts make every existing draft potentially stale, so
    // re-draft across ALL of this creator's videos — in the background, since it
    // can touch many comments and must not block (or time out) the save response.
    after(async () => {
      try {
        const result = await regenerateDraftsForCreator(creatorId)
        logInfo('api/creator/profile', 'Drafts regenerated after profile save', { creator_id: creatorId, ...result })
      } catch (regenError) {
        logError('api/creator/profile', regenError, { creator_id: creatorId, stage: 'regenerate_drafts' })
      }
    })

    return NextResponse.json({ success: true, customFieldsSaved: customWritten })
  } catch (err) {
    logError('api/creator/profile', err, { stage: 'request' })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
