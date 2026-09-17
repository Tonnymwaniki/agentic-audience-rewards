/**
 * Backfills comments.like_count for comments ingested before likes were stored.
 *
 * Re-fetches each analyzed video's comment threads from YouTube (commentThreads.list,
 * 1 quota unit per page of 100) and updates ONLY like_count on the matching stored
 * comments — no new comments, no categorization, no embeddings, no rewards.
 *
 * Requires migration 20240101000023_comment_likes_and_search_filters.sql.
 * Safe to re-run: it just writes the current like counts again. Comments since
 * deleted on YouTube are left as they are and reported.
 *
 * Required env vars (read from .env.local):
 * - NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * - YOUTUBE_API_KEY
 *
 * Run:
 *   npx tsx scripts/backfill-comment-likes.ts            # write like counts
 *   npx tsx scripts/backfill-comment-likes.ts --dry-run  # fetch and report, write nothing
 */

// Next's own env loader rather than dotenv: .env.local starts with a byte-order
// mark, and loading it exactly the way the app does avoids any parser mismatch.
import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())

import { createServiceClient } from '../lib/supabase/service'
import { fetchVideoComments } from '../lib/youtube'

const dryRun = process.argv.includes('--dry-run')

async function main() {
  const supabase = createServiceClient()

  if (!dryRun) {
    const probe = await supabase.from('comments').select('like_count').limit(1)
    if (probe.error) {
      console.error(`comments.like_count is not available (${probe.error.code}: ${probe.error.message}).`)
      console.error('Run supabase/migrations/20240101000023_comment_likes_and_search_filters.sql in the Supabase SQL editor first.')
      process.exit(1)
    }
  }

  const { data: posts, error: postsError } = await supabase.from('posts').select('id, external_post_id, title')
  if (postsError) throw new Error(`Could not load posts: ${postsError.message}`)

  let quotaUnits = 0
  let updated = 0
  let unmatched = 0
  let failedVideos = 0
  const top: Array<{ likes: number; text: string; title: string }> = []

  for (const post of posts ?? []) {
    const stored: Array<{ id: string; external_comment_id: string; text: string }> = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('comments')
        .select('id, external_comment_id, text')
        .eq('post_id', post.id)
        .range(from, from + 999)
      if (error) throw new Error(`Could not load comments for ${post.id}: ${error.message}`)
      stored.push(...(data ?? []))
      if (!data || data.length < 1000) break
    }
    if (stored.length === 0) continue

    let fetched
    try {
      fetched = await fetchVideoComments(post.external_post_id)
    } catch (err) {
      // Comments disabled, video removed or private: nothing to refresh.
      failedVideos++
      console.warn(`  skipped "${post.title}": ${err instanceof Error ? err.message : err}`)
      continue
    }
    quotaUnits += Math.max(1, Math.ceil(fetched.length / 100))
    const likesById = new Map(fetched.map(c => [c.externalCommentId, c.likeCount]))

    let videoUpdated = 0
    let videoUnmatched = 0
    for (const comment of stored) {
      const likes = likesById.get(comment.external_comment_id)
      if (likes === undefined) {
        videoUnmatched++
        continue
      }
      top.push({ likes, text: comment.text, title: post.title })
      if (!dryRun) {
        const { error } = await supabase.from('comments').update({ like_count: likes }).eq('id', comment.id)
        if (error) throw new Error(`Update failed for comment ${comment.id}: ${error.message}`)
      }
      videoUpdated++
    }
    updated += videoUpdated
    unmatched += videoUnmatched
    console.log(`  ${dryRun ? 'would update' : 'updated'} ${videoUpdated}/${stored.length}${videoUnmatched ? ` (${videoUnmatched} no longer on YouTube)` : ''} — ${post.title}`)
  }

  console.log(`\n${dryRun ? 'DRY RUN — nothing written. ' : ''}${updated} comments ${dryRun ? 'would get' : 'got'} like counts; ${unmatched} not found on YouTube; ${failedVideos} videos skipped; ~${quotaUnits} YouTube quota units used.`)
  console.log('Most-liked comments:')
  for (const t of top.sort((a, b) => b.likes - a.likes).slice(0, 5)) {
    console.log(`  ${t.likes} likes — "${t.text.replace(/\s+/g, ' ').slice(0, 70)}" (${t.title})`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
