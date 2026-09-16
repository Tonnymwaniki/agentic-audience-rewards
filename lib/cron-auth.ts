import type { NextRequest } from 'next/server'

/**
 * True when a request carries this deployment's CRON_SECRET, either as the
 * `Authorization: Bearer` header Vercel Cron sends or as a `secret` query
 * parameter for manual runs. Shared by every /api/cron route so they can't drift.
 *
 * Callers should check that CRON_SECRET is configured first and fail loudly if
 * not: with no secret this returns false, which would otherwise read as a
 * permissions problem rather than a missing setting.
 */
export function isCronAuthorized(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return false

  const authHeader = request.headers.get('authorization')
  if (authHeader === `Bearer ${cronSecret}`) return true

  const secretParam = request.nextUrl.searchParams.get('secret')
  return secretParam === cronSecret
}
