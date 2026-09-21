import { NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { buildCreatorExport } from '@/lib/creator-export'
import { createClient as createCookieClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

/**
 * "Download my data". Reads one creator's own rows and returns them as a JSON
 * attachment.
 *
 * The creator id comes from requireCreator() — derived from the validated
 * session, never from a query string. An exported file is the whole account in
 * one place, so an endpoint that accepted a caller-supplied creator_id would be
 * a one-request dump of anyone's data.
 */
export async function GET() {
  const result = await requireCreator()
  if (!result.ok) return result.response

  const { supabase, creatorId } = result.auth

  // Only for labelling the file's `account` block; identity itself already came
  // from requireCreator().
  const authClient = await createCookieClient()
  const {
    data: { user },
  } = await authClient.auth.getUser()

  try {
    const payload = await buildCreatorExport(supabase, creatorId, user?.email ?? null)
    const stamp = new Date().toISOString().slice(0, 10)

    return new NextResponse(JSON.stringify(payload, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="notice-data-export-${stamp}.json"`,
        // A personal data dump must never sit in a shared or browser cache.
        'Cache-Control': 'no-store, private',
      },
    })
  } catch (error) {
    console.error('Creator export error:', error)
    return NextResponse.json(
      { error: 'Could not build your export. Please try again.' },
      { status: 500 }
    )
  }
}
