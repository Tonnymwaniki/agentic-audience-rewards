import { NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { deleteCreatorData, findOrphanedRows } from '@/lib/creator-deletion'
import { revokeCreatorGoogleAccess } from '@/lib/youtube-oauth'
import { logError, logInfo } from '@/lib/logger'

export const dynamic = 'force-dynamic'

/** The client must send this exact string. A bare POST does nothing. */
const CONFIRMATION = 'DELETE'

/**
 * "Delete my account" — permanent, and the only irreversible endpoint in the app.
 *
 * Three guards, none of which is the UI's confirmation dialog:
 *
 *  1. requireCreator() derives the creator id from the validated session. There
 *     is no request parameter naming what to delete, so the endpoint cannot be
 *     pointed at another account even by someone who is signed in.
 *  2. The body must carry the literal confirmation string. A CSRF-style POST, a
 *     retried fetch or a mis-wired button therefore cannot destroy an account on
 *     its own.
 *  3. After the cascade, the account is re-read. If any creator-owned row
 *     survived, the auth user is LEFT IN PLACE and the route returns 500 —
 *     deleting the login while data remains would strand rows that no one can
 *     reach or remove through the app.
 */
export async function POST(request: Request) {
  const result = await requireCreator()
  if (!result.ok) return result.response

  const { supabase, creatorId, userId } = result.auth

  let body: { confirm?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Confirmation required' }, { status: 400 })
  }

  if (body.confirm !== CONFIRMATION) {
    return NextResponse.json(
      { error: `Confirmation required: send { "confirm": "${CONFIRMATION}" }` },
      { status: 400 }
    )
  }

  // BEFORE the cascade, never after. youtube_oauth_tokens cascades from creators,
  // so once deleteCreatorData runs the tokens are gone and Google's grant could
  // never be withdrawn from our side — deleting our row would leave the app with
  // standing read access to an account whose owner believes they have left.
  //
  // Deliberately not inside the try/catch below: revokeCreatorGoogleAccess never
  // throws, and a Google outage must not be able to abort a deletion the creator
  // has already confirmed.
  const revoke = await revokeCreatorGoogleAccess(supabase, creatorId)
  if (revoke.outcome === 'failed' || revoke.outcome === 'decrypt_failed') {
    // Deletion continues regardless — this is recorded so a live grant that
    // outlived its account can be found and chased up.
    logError('api/creator/delete', new Error(`Google revocation did not complete: ${revoke.outcome}`), {
      creator_id: creatorId,
      user_id: userId,
      revoke_outcome: revoke.outcome,
      token_type: revoke.tokenType,
      stage: 'revoke_google_access',
    })
  } else {
    logInfo('api/creator/delete', 'Google access revocation resolved', {
      creator_id: creatorId,
      revoke_outcome: revoke.outcome,
      token_type: revoke.tokenType,
    })
  }

  let report: Record<string, number>
  try {
    report = await deleteCreatorData(supabase, creatorId)
  } catch (error) {
    logError('api/creator/delete', error, { creator_id: creatorId, user_id: userId, stage: 'cascade' })
    return NextResponse.json(
      {
        error:
          'Something went wrong deleting your account. Nothing further was removed and your login still works — please contact support.',
      },
      { status: 500 }
    )
  }

  const leftovers = await findOrphanedRows(supabase, creatorId)
  if (Object.keys(leftovers).length > 0) {
    logError('api/creator/delete', new Error('Deletion left rows behind; auth user kept'), { creator_id: creatorId, user_id: userId, leftovers, stage: 'verify' })
    return NextResponse.json(
      {
        error:
          'Your data could not be fully removed, so your login has been kept. Please contact support.',
        leftovers,
      },
      { status: 500 }
    )
  }

  // Last, and only once the data is provably gone.
  const { error: userError } = await supabase.auth.admin.deleteUser(userId)
  if (userError) {
    logError('api/creator/delete', userError, { creator_id: creatorId, user_id: userId, stage: 'delete_auth_user' })
    return NextResponse.json(
      {
        error:
          'Your data was deleted but your login could not be removed. Please contact support.',
        deleted: report,
      },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true, deleted: report })
}
