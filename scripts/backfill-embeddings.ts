/**
 * Backfills comments.embedding for every comment that doesn't have one yet.
 *
 * Requires migration 20240101000019_add_comment_embeddings.sql to have been run.
 * Safe to re-run at any time: it only picks up comments whose embedding is still
 * null, so an interrupted run resumes where it stopped.
 *
 * Required env vars (read from .env.local):
 * - NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * - VOYAGE_API_KEY
 *
 * Run:
 *   npx tsx scripts/backfill-embeddings.ts            # embed everything pending
 *   npx tsx scripts/backfill-embeddings.ts --dry-run  # only report what's pending
 */

// Next's own env loader rather than dotenv: .env.local starts with a byte-order
// mark, and loading it exactly the way the app does avoids any parser mismatch.
import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())

import { createServiceClient } from '../lib/supabase/service'
import { embedPendingComments, EMBEDDING_DIMENSION, EMBEDDING_MODEL } from '../lib/embeddings'

const dryRun = process.argv.includes('--dry-run')
const fmt = (n: number) => n.toLocaleString('en-US')

async function main() {
  const supabase = createServiceClient()

  // Fail early with the fix spelled out, rather than deep inside the run. A normal
  // one-row read, not a HEAD count: a failed HEAD request has no body, so its
  // error message is empty and a missing column would be indistinguishable.
  const probe = await supabase.from('comments').select('id').is('embedding', null).limit(1)
  if (probe.error) {
    if (probe.error.code === '42703') {
      console.error('comments.embedding does not exist yet. Run this in the Supabase SQL editor first:\n')
      console.error('  CREATE EXTENSION IF NOT EXISTS vector;')
      console.error(`  ALTER TABLE comments ADD COLUMN IF NOT EXISTS embedding vector(${EMBEDDING_DIMENSION});\n`)
      console.error('(also in supabase/migrations/20240101000019_add_comment_embeddings.sql)')
    } else {
      console.error('Could not query comments:', probe.error.message)
    }
    process.exitCode = 1
    return
  }

  const { count: pendingCount, error: countError } = await supabase
    .from('comments')
    .select('id', { count: 'exact', head: true })
    .is('embedding', null)
  if (countError) {
    console.error('Could not count pending comments (HTTP error with no detail)')
    process.exitCode = 1
    return
  }
  const pending = pendingCount ?? 0
  console.log(`Model: ${EMBEDDING_MODEL} (${EMBEDDING_DIMENSION} dimensions)`)
  console.log(`Comments without an embedding: ${fmt(pending)}`)

  if (dryRun || pending === 0) {
    if (dryRun) console.log('Dry run — nothing embedded or written.')
    return
  }

  const started = Date.now()
  let lastLogged = -1

  const result = await embedPendingComments(supabase, {
    onProgress: ({ embedded, total }) => {
      // Roughly every 5%, plus the final count — enough to watch, not a flood.
      const step = Math.max(1, Math.floor(total / 20))
      if (embedded === total || embedded - lastLogged >= step) {
        console.log(`Embedded ${fmt(embedded)} of ${fmt(total)} comments`)
        lastLogged = embedded
      }
    },
  })

  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log(
    `\nDone in ${seconds}s — embedded ${fmt(result.embedded)}, ` +
      `skipped ${fmt(result.skipped)} blank, failed ${fmt(result.failed)}.`
  )

  // Read one row back to prove what landed in Postgres is a real vector of the
  // right size, not just that the update calls returned no error.
  const { data: sample, error: sampleError } = await supabase
    .from('comments')
    .select('id, embedding')
    .not('embedding', 'is', null)
    .limit(1)
    .maybeSingle()

  if (sampleError || !sample) {
    console.error('Could not read back a stored embedding:', sampleError?.message ?? 'no rows')
    process.exitCode = 1
    return
  }

  const stored = typeof sample.embedding === 'string' ? JSON.parse(sample.embedding) : sample.embedding
  const ok = Array.isArray(stored) && stored.length === EMBEDDING_DIMENSION
  console.log(`Read-back check: comment ${sample.id} has a ${Array.isArray(stored) ? stored.length : '?'}-dimension vector ${ok ? '✓' : '✗'}`)

  const { count: remaining } = await supabase
    .from('comments')
    .select('id', { count: 'exact', head: true })
    .is('embedding', null)
  console.log(`Still without an embedding: ${fmt(remaining ?? 0)} (blank comments stay null by design)`)

  if (!ok || result.failed > 0) process.exitCode = 1
}

// process.exitCode rather than process.exit(): exiting while fetch sockets are
// still closing trips a libuv assertion on Windows ("UV_HANDLE_CLOSING"), turning
// a clean failure into a crash. Letting the event loop drain avoids it.
main().catch(err => {
  console.error('Backfill failed:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
