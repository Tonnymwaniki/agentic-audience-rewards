/**
 * Backfills posts.channel_id with the YouTube channel that owns each video.
 *
 * Capability gating (lib/channel-verification.ts) needs to know which channel a
 * post belongs to before it will allow a drafted reply or a reward evaluation.
 * Without this column it falls back to a live YouTube lookup per post, which is
 * correct but puts a network round trip in front of every gate check.
 *
 * Reads videos.list with part=snippet, batched 50 ids per request (1 quota unit
 * per batch), and writes ONLY channel_id. No comments, no categorization, no
 * rewards.
 *
 * Safe to re-run: it writes the same channel ids again. By default it fills rows
 * where channel_id IS NULL; pass --all to refresh every post. Videos that no
 * longer exist on YouTube are left null and reported — the gate treats an unknown
 * channel as unverified, which is the safe answer.
 *
 * Required env vars (read from .env.local):
 * - NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * - YOUTUBE_API_KEY
 *
 * Run:
 *   npx tsx scripts/backfill-post-channel-id.ts            # fill NULLs
 *   npx tsx scripts/backfill-post-channel-id.ts --dry-run  # report only
 *   npx tsx scripts/backfill-post-channel-id.ts --all      # refresh every post
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

type PostRow = { id: string; external_post_id: string; title: string | null; channel_id: string | null }

async function fetchChannels(videoIds: string[]): Promise<Map<string, { channelId: string; channelTitle: string }>> {
  const found = new Map<string, { channelId: string; channelTitle: string }>()

  for (let i = 0; i < videoIds.length; i += BATCH) {
    const url = new URL('https://www.googleapis.com/youtube/v3/videos')
    url.searchParams.set('part', 'snippet')
    url.searchParams.set('id', videoIds.slice(i, i + BATCH).join(','))
    url.searchParams.set('key', process.env.YOUTUBE_API_KEY!)

    const res = await fetch(url.toString())
    if (!res.ok) throw new Error(`YouTube API error ${res.status}: ${await res.text()}`)

    const data = (await res.json()) as {
      items?: Array<{ id: string; snippet?: { channelId?: string; channelTitle?: string } }>
    }
    for (const item of data.items ?? []) {
      if (item.id && item.snippet?.channelId) {
        found.set(item.id, {
          channelId: item.snippet.channelId,
          channelTitle: item.snippet.channelTitle ?? '(unknown)',
        })
      }
    }
  }

  return found
}

async function main() {
  const supabase = createServiceClient()

  const probe = await supabase.from('posts').select('channel_id').limit(1)
  if (probe.error) {
    console.error(`posts.channel_id is not available (${probe.error.code}: ${probe.error.message}).`)
    console.error('Run supabase/migrations/20240101000036_posts_channel_id.sql first.')
    process.exit(1)
  }

  let query = supabase.from('posts').select('id, external_post_id, title, channel_id')
  if (!refreshAll) query = query.is('channel_id', null)

  const { data, error } = await query
  if (error) {
    console.error('Could not read posts:', error.message)
    process.exit(1)
  }

  const rows = (data ?? []) as PostRow[]
  console.log(`${rows.length} post(s) to backfill${refreshAll ? ' (--all)' : ' with channel_id NULL'}.`)
  if (rows.length === 0) return

  const channels = await fetchChannels(rows.map(r => r.external_post_id))
  console.log(`YouTube resolved ${channels.size} of ${rows.length}.\n`)

  const byChannel = new Map<string, number>()
  let written = 0
  const missing: PostRow[] = []

  for (const post of rows) {
    const match = channels.get(post.external_post_id)
    if (!match) {
      missing.push(post)
      continue
    }

    byChannel.set(match.channelTitle, (byChannel.get(match.channelTitle) ?? 0) + 1)
    const label = (post.title ?? post.external_post_id).slice(0, 40)

    if (dryRun) {
      console.log(`  would set ${label.padEnd(42)} -> ${match.channelId}  (${match.channelTitle})`)
      continue
    }

    const { error: updateError } = await supabase
      .from('posts')
      .update({ channel_id: match.channelId })
      .eq('id', post.id)

    if (updateError) {
      console.error(`  FAILED ${label}: ${updateError.message}`)
      continue
    }
    written++
  }

  console.log('\nby channel:')
  for (const [title, count] of [...byChannel.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}  ${title}`)
  }

  if (missing.length > 0) {
    console.log(`\n${missing.length} video(s) no longer on YouTube (left null — treated as unverified):`)
    for (const post of missing) console.log(`  ${post.external_post_id}  ${(post.title ?? '').slice(0, 44)}`)
  }

  console.log(dryRun ? '\nDry run — nothing written.' : `\nDone: ${written} post(s) updated.`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
