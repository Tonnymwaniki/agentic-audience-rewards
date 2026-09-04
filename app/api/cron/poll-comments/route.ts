import { NextRequest, NextResponse } from 'next/server'
import { ingestNewComments } from '@/lib/ingest'
import { categorizePost } from '@/lib/categorize'
import { createServiceClient } from '@/lib/supabase/service'

// Gives the loop over all tracked videos room to finish within one invocation.
// Vercel Hobby caps this at 60s, Pro at 300s — raise the plan if this route
// starts timing out with a large number of tracked videos.
export const maxDuration = 300

const POLL_INTERVAL_MS = 20 * 60 * 1000

function isAuthorized(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return false

  const authHeader = request.headers.get('authorization')
  if (authHeader === `Bearer ${cronSecret}`) return true

  const secretParam = request.nextUrl.searchParams.get('secret')
  return secretParam === cronSecret
}

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET) {
    console.error('Poll comments: CRON_SECRET is not configured')
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
  }

  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const threshold = new Date(Date.now() - POLL_INTERVAL_MS).toISOString()

  const { data: tracked, error } = await supabase
    .from('tracked_videos')
    .select('id, creator_id, post_id, posts (external_post_id)')
    .eq('polling_enabled', true)
    .lt('last_checked_at', threshold)

  if (error) {
    console.error('Poll comments: fetch tracked_videos error', JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
    return NextResponse.json({ error: 'Failed to fetch tracked videos' }, { status: 500 })
  }

  const results: Array<{ post_id: string; success: boolean; newComments?: number; error?: string }> = []

  for (const track of tracked || []) {
    const videoId = (track.posts as unknown as { external_post_id: string } | null)?.external_post_id

    if (!videoId) {
      results.push({ post_id: track.post_id, success: false, error: 'Missing external_post_id on post' })
      continue
    }

    try {
      const ingestResult = await ingestNewComments(track.creator_id, track.post_id, videoId)

      if (ingestResult.newCommentIds.length > 0) {
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
}
