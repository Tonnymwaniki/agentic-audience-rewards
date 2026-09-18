/**
 * Backfills comment_categories.sentiment and .emotion for comments categorized
 * before those were classified.
 *
 * Runs each pending comment through the SAME categorization prompt ingestion uses
 * (lib/categorize.ts categorizeComments), so a backfilled value means exactly what a
 * newly classified one does — but writes ONLY sentiment and emotion. Categories,
 * topics, drafts, escalation flags, language and rewards are left untouched.
 *
 * Until a comment has been through this, readers fall back to the old category-derived
 * sentiment (praise = positive, complaint = negative, everything else neutral), so the
 * backfill can be run in stages.
 *
 * Cost: one Haiku call per 10 comments.
 *
 * Requires migration 20240101000026_comment_sentiment_emotion.sql.
 * Safe to re-run: only rows whose sentiment is still null are picked up.
 *
 * Run:
 *   npx tsx scripts/backfill-comment-sentiment.ts                 # detect and write
 *   npx tsx scripts/backfill-comment-sentiment.ts --dry-run       # detect, write nothing
 *   npx tsx scripts/backfill-comment-sentiment.ts --limit 100     # only the first 100
 *   npx tsx scripts/backfill-comment-sentiment.ts --post <uuid>   # only one video's comments
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
/** Batches of 10 (categorizeComments' own size), this many at a time. */
const CONCURRENCY = 4

async function main() {
  const supabase = createServiceClient()

  const probe = await supabase.from('comment_categories').select('sentiment, emotion').limit(1)
  if (probe.error) {
    console.error(`comment_categories.sentiment/emotion are not available (${probe.error.code}: ${probe.error.message}).`)
    console.error('Run supabase/migrations/20240101000026_comment_sentiment_emotion.sql in the Supabase SQL editor first.')
    process.exit(1)
  }

  const pending: Array<{ id: string; text: string }> = []
  for (let from = 0; pending.length < limit; from += 1000) {
    let query = supabase
      .from('comment_categories')
      .select('comment_id, comments!inner ( text, post_id )')
      .is('sentiment', null)
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
  console.log(`${todo.length} categorized comments have no sentiment yet${postId ? ` (post ${postId})` : ''}${dryRun ? ' (dry run: nothing will be written)' : ''}.`)

  const chunks: Array<typeof todo> = []
  for (let i = 0; i < todo.length; i += 10) chunks.push(todo.slice(i, i + 10))

  const sentiments: Record<string, number> = {}
  const emotions: Record<string, number> = {}
  let written = 0
  let missing = 0
  let next = 0

  async function worker() {
    while (next < chunks.length) {
      const chunk = chunks[next++]
      const results = await categorizeComments(chunk)
      missing += chunk.length - results.length
      for (const r of results) {
        sentiments[String(r.sentiment)] = (sentiments[String(r.sentiment)] || 0) + 1
        emotions[String(r.emotion)] = (emotions[String(r.emotion)] || 0) + 1
        if (dryRun || !r.sentiment) continue
        const { error } = await supabase
          .from('comment_categories')
          .update({ sentiment: r.sentiment, emotion: r.emotion })
          .eq('comment_id', r.id)
          .is('sentiment', null)
        if (error) throw new Error(`Update failed for ${r.id}: ${error.message}`)
        written++
      }
      process.stdout.write(`\r  processed ${Math.min(next * 10, todo.length)}/${todo.length}`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  console.log(`\n\nsentiment: ${JSON.stringify(sentiments)}`)
  console.log(`emotion:   ${JSON.stringify(emotions)}`)
  console.log(`${dryRun ? 'Would write' : 'Wrote'} ${dryRun ? todo.length - missing : written} rows; ${missing} were skipped by the model (re-run to retry).`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
