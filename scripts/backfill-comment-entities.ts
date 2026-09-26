/**
 * Backfills comment_categories.entities (named brands, companies, products and
 * organizations) for comments categorized before entity extraction existed.
 *
 * Runs each pending comment through the SAME categorization prompt ingestion uses
 * (lib/categorize.ts categorizeComments), so a backfilled value means exactly what a
 * newly classified one does — same canonical-name rules — but writes ONLY
 * `entities`. Categories, topics, sentiment, emotion, language, drafts, escalation
 * flags and rewards are left untouched.
 *
 * Writes [] for comments scanned with no entities, so coverage can be reported; a
 * comment the model skipped stays NULL and is picked up by the next run.
 *
 * Cost: one Haiku call per 10 comments.
 *
 * Requires migration 20240101000041_comment_entities.sql.
 * Safe to re-run: only rows whose entities are still null are picked up.
 *
 * Run:
 *   npx tsx scripts/backfill-comment-entities.ts                 # detect and write
 *   npx tsx scripts/backfill-comment-entities.ts --dry-run       # detect, write nothing
 *   npx tsx scripts/backfill-comment-entities.ts --limit 100     # only the first 100
 *   npx tsx scripts/backfill-comment-entities.ts --post <uuid>   # only one video's comments
 */

import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())

import { createServiceClient } from '../lib/supabase/service'
import { categorizeComments } from '../lib/categorize'

const dryRun = process.argv.includes('--dry-run')
const limitArg = process.argv.indexOf('--limit')
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity
const postArg = process.argv.indexOf('--post')
const postId = postArg > -1 ? process.argv[postArg + 1] : null
const CONCURRENCY = 4

async function main() {
  const supabase = createServiceClient()

  const probe = await supabase.from('comment_categories').select('entities').limit(1)
  if (probe.error) {
    console.error(`comment_categories.entities is not available (${probe.error.code}: ${probe.error.message}).`)
    console.error('Run supabase/migrations/20240101000041_comment_entities.sql in the Supabase SQL editor first.')
    process.exit(1)
  }

  const pending: Array<{ id: string; text: string }> = []
  for (let from = 0; pending.length < limit; from += 1000) {
    let query = supabase
      .from('comment_categories')
      .select('comment_id, comments!inner ( text, post_id )')
      .is('entities', null)
      .order('comment_id')
      .range(from, from + 999)
    if (postId) query = query.eq('comments.post_id', postId)

    const { data, error } = await query
    if (error) throw new Error(`Could not load pending comments: ${error.message}`)
    for (const row of data ?? []) {
      const text = (row.comments as unknown as { text: string } | null)?.text
      if (text) pending.push({ id: row.comment_id as string, text })
    }
    if (!data || data.length < 1000) break
  }
  const todo = pending.slice(0, limit)
  console.log(`${todo.length} categorized comments not yet scanned for entities${postId ? ` (post ${postId})` : ''}${dryRun ? ' (dry run: nothing will be written)' : ''}.`)

  const chunks: Array<typeof todo> = []
  for (let i = 0; i < todo.length; i += 10) chunks.push(todo.slice(i, i + 10))

  const sizes: Record<number, number> = {}
  let written = 0
  let missing = 0
  let next = 0

  async function worker() {
    while (next < chunks.length) {
      const chunk = chunks[next++]
      const results = await categorizeComments(chunk)
      missing += chunk.length - results.length
      for (const r of results) {
        // null = the model omitted the key: leave the row unscanned for a re-run.
        if (r.entities === null) {
          missing++
          continue
        }
        sizes[r.entities.length] = (sizes[r.entities.length] || 0) + 1
        if (dryRun) continue
        const { error } = await supabase
          .from('comment_categories')
          .update({ entities: r.entities })
          .eq('comment_id', r.id)
          .is('entities', null)
        if (error) throw new Error(`Update failed for ${r.id}: ${error.message}`)
        written++
      }
      process.stdout.write(`\r  processed ${Math.min(next * 10, todo.length)}/${todo.length}`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  console.log(`\n\nentities per comment: ${JSON.stringify(sizes)}`)
  console.log(`${dryRun ? 'Would write' : 'Wrote'} ${dryRun ? todo.length - missing : written} rows; ${missing} were skipped by the model (re-run to retry).`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
