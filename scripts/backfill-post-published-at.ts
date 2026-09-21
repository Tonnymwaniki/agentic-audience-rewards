/**
 * Backfills posts.posted_at with each video's real YouTube upload time.
 *
 * posts.posted_at was never written by the ingest path — lib/ingest.ts built its
 * upsert without it — so every post ingested before that fix has posted_at NULL.
 * The column is the only record of when a video actually went live (ingested_at is
 * merely when we pulled it in), and without it nothing can measure how long after
 * publication a comment arrived, which is what the "Since posted" view on Agent
 * Home reports.
 *
 * Reads videos.list with part=snippet, batched 50 ids per request (1 quota unit
 * per batch), and updates ONLY posted_at. No comments, no categorization, no
 * embeddings, no rewards.
 *
 * Safe to re-run: it writes the same upload timestamps again. By default it only
 * fills rows where posted_at IS NULL; pass --all to refresh every post. Videos
 * that no longer exist on YouTube are left alone and reported.
 *
 * Required env vars (read from .env.local):
 * - NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * - YOUTUBE_API_KEY
 *
 * Run:
 *   npx tsx scripts/backfill-post-published-at.ts            # fill NULLs
 *   npx tsx scripts/backfill-post-published-at.ts --dry-run  # fetch and report only
 *   npx tsx scripts/backfill-post-published-at.ts --all      # refresh every post
 */

// Next's own env loader rather than dotenv: .env.local starts with a byte-order
// mark, and loading it exactly the way the app does avoids any parser mismatch.
import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())

import { createServiceClient } from '../lib/supabase/service'

const dryRun = process.argv.includes('--dry-run')
const refreshAll = process.argv.includes('--all')

/** videos.list accepts up to 50 ids in one request. */
const BATCH = 50

type PostRow = { id: string; external_post_id: string; title: string | null; posted_at: string | null }

async function fetchPublishedAt(videoIds: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>()

  for (let i = 0; i < videoIds.length; i += BATCH) {
    const batch = videoIds.slice(i, i + BATCH)
    const url = new URL('https://www.googleapis.com/youtube/v3/videos')
    url.searchParams.set('part', 'snippet')
    url.searchParams.set('id', batch.join(','))
    url.searchParams.set('key', process.env.YOUTUBE_API_KEY!)

    const res = await fetch(url.toString())
    if (!res.ok) {
      throw new Error(`YouTube API error ${res.status}: ${await res.text()}`)
    }

    const data = await res.json()
    for (const item of data.items ?? []) {
      if (item.id && item.snippet?.publishedAt) found.set(item.id, item.snippet.publishedAt)
    }
  }

  return found
}

async function main() {
  const supabase = createServiceClient()

  let query = supabase.from('posts').select('id, external_post_id, title, posted_at')
  if (!refreshAll) query = query.is('posted_at', null)

  const { data: posts, error } = await query
  if (error) {
    console.error('Could not read posts:', error.message)
    process.exit(1)
  }

  const rows = (posts ?? []) as PostRow[]
  console.log(`${rows.length} post(s) to backfill${refreshAll ? ' (--all: refreshing every post)' : ' with posted_at NULL'}.`)
  if (rows.length === 0) return

  const published = await fetchPublishedAt(rows.map(p => p.external_post_id))
  console.log(`YouTube returned an upload time for ${published.size} of ${rows.length}.\n`)

  let written = 0
  const missing: PostRow[] = []

  for (const post of rows) {
    const publishedAt = published.get(post.external_post_id)
    if (!publishedAt) {
      missing.push(post)
      continue
    }

    const label = (post.title ?? post.external_post_id).slice(0, 44)
    if (dryRun) {
      console.log(`  would set ${label.padEnd(46)} -> ${publishedAt}`)
      continue
    }

    const { error: updateError } = await supabase
      .from('posts')
      .update({ posted_at: publishedAt })
      .eq('id', post.id)

    if (updateError) {
      console.error(`  FAILED ${label}: ${updateError.message}`)
      continue
    }

    console.log(`  set ${label.padEnd(46)} -> ${publishedAt}`)
    written++
  }

  if (missing.length > 0) {
    console.log(`\n${missing.length} video(s) no longer on YouTube (left unchanged):`)
    for (const post of missing) {
      console.log(`  ${post.external_post_id}  ${(post.title ?? '').slice(0, 50)}`)
    }
  }

  console.log(dryRun ? '\nDry run — nothing written.' : `\nDone: ${written} post(s) updated.`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
