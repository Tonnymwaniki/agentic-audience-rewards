import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { regenerateDraftsForCreator } from '@/lib/draft-regeneration'

// The save itself returns immediately; this headroom is for the after() work,
// which re-drafts replies across every one of the creator's videos.
export const maxDuration = 300

const PROFILE_FIELDS = [
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

    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll() {},
        },
      }
    )

    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { data: creator, error: creatorError } = await supabase
      .from('creators')
      .select('id')
      .eq('user_id', user.id)
      .single()

    if (creatorError || !creator) {
      return NextResponse.json({ error: 'Creator not found' }, { status: 404 })
    }

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

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No profile fields provided' }, { status: 400 })
    }

    const { error: updateError } = await supabase
      .from('creators')
      .update(updates)
      .eq('id', creator.id)

    if (updateError) {
      console.error('Update business profile error:', JSON.stringify(updateError, Object.getOwnPropertyNames(updateError), 2))
      return NextResponse.json({ error: 'Failed to save your business profile' }, { status: 500 })
    }

    // Newly-saved business facts make every existing draft potentially stale, so
    // re-draft across ALL of this creator's videos — in the background, since it
    // can touch many comments and must not block (or time out) the save response.
    after(async () => {
      try {
        const result = await regenerateDraftsForCreator(creator.id)
        console.log('Profile save draft regeneration:', JSON.stringify(result))
      } catch (regenError) {
        console.error('Profile save draft regeneration error:', JSON.stringify(regenError, Object.getOwnPropertyNames(regenError), 2))
      }
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Save business profile error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
