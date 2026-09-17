/**
 * Backfills comment_categories.language for comments categorized before language
 * detection existed.
 *
 * Runs each pending comment through the SAME categorization prompt that ingestion
 * uses (lib/categorize.ts categorizeComments), so a backfilled language means exactly
 * what a newly detected one does — but writes ONLY the language column. Categories,
 * topics, drafts, escalation flags and rewards are left untouched.
 *
 * Cost: one Haiku call per 10 comments (~134 calls for ~1,336 comments).
 *
 * Requires migration 20240101000024_comment_language.sql.
 * Safe to re-run: only rows whose language is still null are picked up. Comments with
 * no language to detect (emoji only) stay null and are simply re-checked next time.
 *
 * Required env vars (read from .env.local):
 * - NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * - ANTHROPIC_API_KEY
 *
 * Run:
 *   npx tsx scripts/backfill-comment-language.ts             # detect and write
 *   npx tsx scripts/backfill-comment-language.ts --dry-run   # detect, write nothing
 *   npx tsx scripts/backfill-comment-language.ts --limit 50  # only the first 50 pending
 */

// Next's own env loader rather than dotenv: .env.local starts with a byte-order
// mark, and loading it exactly the way the app does avoids any parser mismatch.
import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())

import { createServiceClient } from '../lib/supabase/service'
import { categorizeComments } from '../lib/categorize'

const dryRun = process.argv.includes('--dry-run')
const limitArg = process.argv.indexOf('--limit')
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity
/** Batches of 10 (categorizeComments' own size), this many at a time. */
const CONCURRENCY = 4

async function main() {
  const supabase = createServiceClient()

  const probe = await supabase.from('comment_categories').select('language').limit(1)
  if (probe.error) {
    console.error(`comment_categories.language is not available (${probe.error.code}: ${probe.error.message}).`)
    console.error('Run supabase/migrations/20240101000024_comment_language.sql in the Supabase SQL editor first.')
    process.exit(1)
  }

  const pending: Array<{ id: string; text: string }> = []
  for (let from = 0; pending.length < limit; from += 1000) {
    const { data, error } = await supabase
      .from('comment_categories')
      .select('comment_id, comments ( text )')
      .is('language', null)
      .order('comment_id')
      .range(from, from + 999)
    if (error) throw new Error(`Could not load pending comments: ${error.message}`)
    for (const row of data ?? []) {
      const text = (row.comments as unknown as { text: string } | null)?.text
      if (text) pending.push({ id: row.comment_id as string, text })
    }
    if (!data || data.length < 1000) break
  }
  const todo = pending.slice(0, limit)
  console.log(`${todo.length} categorized comments have no language yet${dryRun ? ' (dry run: nothing will be written)' : ''}.`)

  const chunks: Array<typeof todo> = []
  for (let i = 0; i < todo.length; i += 10) chunks.push(todo.slice(i, i + 10))

  const counts: Record<string, number> = {}
  let written = 0
  let missing = 0
  let next = 0

  async function worker() {
    while (next < chunks.length) {
      const chunk = chunks[next++]
      const results = await categorizeComments(chunk)
      missing += chunk.length - results.length
      for (const r of results) {
        counts[r.language ?? 'null'] = (counts[r.language ?? 'null'] || 0) + 1
        if (dryRun || !r.language) continue
        const { error } = await supabase
          .from('comment_categories')
          .update({ language: r.language })
          .eq('comment_id', r.id)
          .is('language', null)
        if (error) throw new Error(`Update failed for ${r.id}: ${error.message}`)
        written++
      }
      process.stdout.write(`\r  processed ${Math.min(next * 10, todo.length)}/${todo.length}`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  console.log(`\n\nDetected: ${JSON.stringify(counts)}`)
  console.log(`${dryRun ? 'Would write' : 'Wrote'} ${dryRun ? todo.length - missing - (counts.null ?? 0) : written} languages; ${counts.null ?? 0} had no detectable language; ${missing} were skipped by the model (re-run to retry).`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
