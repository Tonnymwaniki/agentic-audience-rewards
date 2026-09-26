/**
 * Backfills per-video stats and metadata on existing posts.
 *
 * Ingestion stores these on every NEW video, but posts ingested before each column
 * existed were never revisited: 16 of 22 posts had view_count and like_count NULL
 * when engagement rate was added, so the rate (and the views badge) could not be
 * shown for most of My Videos.
 *
 * One videos.list call per 50 posts, with part=snippet,statistics,contentDetails,
 * liveStreamingDetails — still 1 quota unit per call whatever the parts. Writes:
 *
 *   view_count, like_count                      (always)
 *   youtube_comment_count, tags, has_captions,
 *   live_scheduled_start_at, live_scheduled_end_at,
 *   live_actual_start_at, live_actual_end_at    (migration 37 — skipped if absent)
 *
 * Never touches comments, categories or rewards. Safe to re-run: it writes current
 * values again. Videos no longer on YouTube are left untouched and reported.
 *
 * Run:
 *   npx tsx scripts/backfill-post-stats.ts            # write
 *   npx tsx scripts/backfill-post-stats.ts --dry-run  # report only
 */

import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())

import { createServiceClient } from '../lib/supabase/service'

const dryRun = process.argv.includes('--dry-run')
const BATCH = 50

const MIGRATION_37_COLUMNS = [
  'youtube_comment_count',
  'tags',
  'has_captions',
  'live_scheduled_start_at',
  'live_scheduled_end_at',
  'live_actual_start_at',
  'live_actual_end_at',
] as const

function count(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

async function main() {
  const supabase = createServiceClient()

  // Does migration 37 exist? Probe one column rather than guessing.
  const probe = await supabase.from('posts').select('youtube_comment_count').limit(1)
  const has37 = !probe.error
  console.log(has37 ? 'Migration 37 present: writing all fields.' : 'Migration 37 NOT applied: writing view_count and like_count only.')

  const { data: posts, error } = await supabase.from('posts').select('id, external_post_id, title')
  if (error || !posts) {
    console.error('Could not read posts:', error?.message)
    process.exit(1)
  }
  console.log(`${posts.length} post(s).\n`)

  const byVideo = new Map<string, Record<string, any>>()
  for (let i = 0; i < posts.length; i += BATCH) {
    const url = new URL('https://www.googleapis.com/youtube/v3/videos')
    url.searchParams.set('part', 'snippet,statistics,contentDetails,liveStreamingDetails')
    url.searchParams.set('id', posts.slice(i, i + BATCH).map(p => p.external_post_id).join(','))
    url.searchParams.set('key', process.env.YOUTUBE_API_KEY!)
    const res = await fetch(url.toString())
    if (!res.ok) throw new Error(`YouTube API error ${res.status}: ${await res.text()}`)
    const data = (await res.json()) as { items?: Array<Record<string, any>> }
    for (const item of data.items ?? []) byVideo.set(item.id, item)
  }

  let written = 0
  const missing: string[] = []
  for (const post of posts) {
    const item = byVideo.get(post.external_post_id)
    if (!item) {
      missing.push(`${post.external_post_id}  ${post.title ?? ''}`)
      continue
    }

    const update: Record<string, unknown> = {
      view_count: count(item.statistics?.viewCount),
      // null, not 0, when the owner hides likes: "hidden" and "nobody liked it" are
      // different facts, and the engagement rate reports the difference.
      like_count: count(item.statistics?.likeCount),
    }
    if (has37) {
      update.youtube_comment_count = count(item.statistics?.commentCount)
      update.tags = Array.isArray(item.snippet?.tags) ? item.snippet.tags : null
      update.has_captions =
        item.contentDetails?.caption === 'true' ? true : item.contentDetails?.caption === 'false' ? false : null
      update.live_scheduled_start_at = item.liveStreamingDetails?.scheduledStartTime ?? null
      update.live_scheduled_end_at = item.liveStreamingDetails?.scheduledEndTime ?? null
      update.live_actual_start_at = item.liveStreamingDetails?.actualStartTime ?? null
      update.live_actual_end_at = item.liveStreamingDetails?.actualEndTime ?? null
    }

    const label = (post.title ?? post.external_post_id).slice(0, 38).padEnd(40)
    const summary = `views=${update.view_count} likes=${update.like_count}` +
      (has37 ? ` comments=${update.youtube_comment_count} tags=${(update.tags as string[] | null)?.length ?? 0} captions=${update.has_captions}${update.live_actual_start_at ? ' LIVE' : ''}` : '')

    if (dryRun) {
      console.log(`  would set ${label} ${summary}`)
      continue
    }
    const { error: updateError } = await supabase.from('posts').update(update).eq('id', post.id)
    if (updateError) {
      console.error(`  FAILED ${label} ${updateError.message}`)
      continue
    }
    console.log(`  set ${label} ${summary}`)
    written++
  }

  if (missing.length) {
    console.log(`\n${missing.length} video(s) no longer on YouTube (left unchanged):`)
    for (const m of missing) console.log(`  ${m}`)
  }
  console.log(dryRun ? '\nDry run — nothing written.' : `\nDone: ${written} post(s) updated.`)
  if (!has37) console.log('Apply migration 37 and re-run to fill comment counts, tags, captions and live times.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
