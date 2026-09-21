import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { logError } from '@/lib/logger'

export const dynamic = 'force-dynamic'

/** A health check that hangs is worse than one that fails — it stalls the poller. */
const DB_TIMEOUT_MS = 5000

/**
 * Uptime endpoint: is the app serving, and can it reach its database?
 *
 * Deliberately UNAUTHENTICATED, and deliberately thin because of it. It performs
 * one trivial count against a table with no personal data in it, and returns only
 * booleans, a latency figure and a status string. It never reports row counts,
 * environment values, versions or error text, because anything it returns is
 * public: a health endpoint that echoes a database error hands out schema details
 * and confirms which infrastructure you run.
 *
 * Returns 200 when healthy and 503 when the database is unreachable, so a plain
 * HTTP status check is enough for a monitor — no body parsing required.
 */
export async function GET() {
  const startedAt = Date.now()

  const checks: Record<string, { ok: boolean; latency_ms?: number }> = {
    app: { ok: true },
  }

  try {
    const supabase = createServiceClient()
    const dbStartedAt = Date.now()

    // `platforms` is the right table to probe: tiny, fixed, and contains nothing
    // private. head+count sends no rows back at all.
    const query = supabase.from('platforms').select('*', { count: 'exact', head: true })

    const { error } = (await Promise.race([
      query,
      new Promise<{ error: Error }>((_, reject) =>
        setTimeout(() => reject(new Error(`Database check exceeded ${DB_TIMEOUT_MS}ms`)), DB_TIMEOUT_MS)
      ),
    ])) as { error: unknown }

    if (error) throw error

    checks.database = { ok: true, latency_ms: Date.now() - dbStartedAt }
  } catch (error) {
    // Logged in full server-side, where the detail is safe; the response stays bare.
    logError('api/health', error, { check: 'database' })
    checks.database = { ok: false }
  }

  const healthy = Object.values(checks).every(check => check.ok)

  return NextResponse.json(
    {
      status: healthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      checks,
      latency_ms: Date.now() - startedAt,
    },
    {
      status: healthy ? 200 : 503,
      // A cached health check reports the past, which is the one thing it must not do.
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    }
  )
}
