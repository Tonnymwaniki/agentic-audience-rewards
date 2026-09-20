import { NextRequest, NextResponse } from 'next/server'
import { ingestNewComments } from '@/lib/ingest'
import { embedPostCommentsSafely } from '@/lib/embeddings'
import { categorizePost } from '@/lib/categorize'
import { createServiceClient } from '@/lib/supabase/service'
import { isCronAuthorized } from '@/lib/cron-auth'

// Gives the loop over all tracked videos room to finish within one invocation.
// Vercel Hobby caps this at 60s, Pro at 300s — raise the plan if this route
// starts timing out with a large number of tracked videos.
export const maxDuration = 300

const POLL_INTERVAL_MS = 20 * 60 * 1000
// Notifications are no longer created here. categorizePost() now writes one inbox
// entry per drafted or escalated comment, which covers every path that produces a
// draft — first analysis, manual re-analysis and this poller alike. Inserting them
// here as well double-notified every comment the poller picked up.

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET) {
    console.error('Poll comments: CRON_SECRET is not configured')
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
  }

  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = createServiceClient()
    const threshold = new Date(Date.now() - POLL_INTERVAL_MS).toISOString()

    const { data: tracked, error } = await supabase
      .from('tracked_videos')
      .select('id, creator_id, post_id, posts (external_post_id, title)')
      .eq('polling_enabled', true)
      .lt('last_checked_at', threshold)

    if (error) {
      console.error('Poll comments: fetch tracked_videos error', JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
      return NextResponse.json({ error: 'Failed to fetch tracked videos' }, { status: 500 })
    }

    const results: Array<{ post_id: string; success: boolean; newComments?: number; error?: string }> = []

    for (const track of tracked || []) {
      const post = track.posts as unknown as { external_post_id: string; title: string } | null
      const videoId = post?.external_post_id

      if (!videoId) {
        results.push({ post_id: track.post_id, success: false, error: 'Missing external_post_id on post' })
        continue
      }

      try {
        const ingestResult = await ingestNewComments(track.creator_id, track.post_id, videoId)

        if (ingestResult.newCommentIds.length > 0) {
          // Nothing is waiting on this job, so embedding can simply run in line.
          // Only this post's null-embedding rows are picked up — i.e. the new ones.
          await embedPostCommentsSafely(supabase, track.post_id)
          await categorizePost(track.post_id)
        }

        await supabase
          .from('tracked_videos')
          .update({ last_checked_at: new Date().toISOString() })
          .eq('id', track.id)

        results.push({ post_id: track.post_id, success: true, newComments: ingestResult.commentsIngested })
      } catch (err) {
        console.error('Poll comments: error processing post', track.post_id, JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
        results.push({
          post_id: track.post_id,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }

    return NextResponse.json({ success: true, checked: results.length, results })
  } catch (error) {
    console.error("CRON POLL ERROR:", JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
