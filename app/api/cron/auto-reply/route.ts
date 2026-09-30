import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { isCronAuthorized } from '@/lib/cron-auth'
import { logError, logWarn } from '@/lib/logger'
import { getVerifiedChannelIds } from '@/lib/channel-verification'
import { getCreatorPlan } from '@/lib/entitlements'
import { approveAndSendReply } from '@/lib/reply-approval'
import { normalizeConfidence, type Confidence } from '@/lib/confidence'

// One pass over every creator with automation on can mean many sequential YouTube
// sends across many creators; give it real room rather than timing out mid-run.
// Vercel Hobby caps this at 60s, Pro at 300s.
export const maxDuration = 300

/**
 * Sends drafted replies unattended, for creators who opted into it.
 *
 * This is deliberately thin: every actual safety decision (ownership
 * verification, plan eligibility, OAuth write-scope) lives in
 * approveAndSendReply / sendReplyToYouTube, the same path manual "Approve"
 * uses. This route's own job is narrower — decide WHICH drafts are even
 * candidates — and it re-derives that from the database on every run rather
 * than trusting anything cached, since a setting or a grant can change between
 * runs.
 *
 * 'complaint' is never eligible here, full stop, regardless of what a creator
 * has in reply_automation_categories — a wrong automated reply to an upset
 * commenter is the costliest mistake this feature could make, so there is no
 * setting that overrides this exclusion.
 */
const NEVER_AUTO_SEND_CATEGORIES = new Set(['complaint'])

// Higher number = more confident. Used to implement "at least X confidence" —
// draft_confidence is categorical (lib/confidence.ts), not a 0-1 float, so this
// is a rank comparison, not a numeric threshold.
const CONFIDENCE_RANK: Record<Confidence, number> = { low: 1, medium: 2, high: 3 }

function meetsMinimumConfidence(actual: string | null, minimum: string): boolean {
  const actualLevel = normalizeConfidence(actual)
  const minLevel = normalizeConfidence(minimum)
  // A draft with no recorded confidence, or a creator setting that somehow isn't
  // a real level, never qualifies — automation requires an actual, legible
  // confidence signal to act on, not an absence of one.
  if (!actualLevel || !minLevel) return false
  return CONFIDENCE_RANK[actualLevel] >= CONFIDENCE_RANK[minLevel]
}

type Candidate = {
  commentId: string
  postId: string
  category: string
  confidence: string | null
}

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET) {
    logError('api/cron/auto-reply', new Error('CRON_SECRET is not configured'), { stage: 'auth_precondition' })
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
  }

  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const summary: Array<{
    creator_id: string
    considered: number
    sent: number
    failed: number
    skipped: number
    error?: string
  }> = []

  try {
    const { data: creators, error: creatorsError } = await supabase
      .from('creators')
      .select(
        'id, plan, reply_automation_enabled, reply_automation_categories, reply_automation_min_confidence, reply_automation_max_per_run'
      )
      .eq('reply_automation_enabled', true)

    if (creatorsError) {
      // reply_automation_* columns (migration 52) may not exist yet on this
      // database — nothing to automate until it's run, so an empty result (not a
      // hard failure) is the right outcome for the whole cron.
      if ((creatorsError.code === 'PGRST204' || creatorsError.code === '42703')) {
        logWarn('api/cron/auto-reply', 'creators.reply_automation_* does not exist yet; skipping run (run the pending migration)', {})
        return NextResponse.json({ success: true, creatorsProcessed: 0, note: 'automation columns not migrated yet' })
      }
      logError('api/cron/auto-reply', creatorsError, { stage: 'fetch_creators' })
      return NextResponse.json({ error: 'Failed to fetch creators' }, { status: 500 })
    }

    for (const creator of creators ?? []) {
      const creatorId = creator.id as string
      const result = { creator_id: creatorId, considered: 0, sent: 0, failed: 0, skipped: 0 }

      try {
        // Automation is Pro-only, by decision — re-checked here (not just trusted
        // from whatever set the toggle) since a plan can lapse after the toggle
        // was turned on.
        const plan = await getCreatorPlan(supabase, creatorId)
        if (plan !== 'pro') {
          summary.push({ ...result, error: 'not on pro plan; skipped' })
          continue
        }

        const verifiedChannelIds = await getVerifiedChannelIds(supabase, creatorId)
        if (verifiedChannelIds.length === 0) {
          // Nothing this creator owns can be auto-replied to. Not an error —
          // just nothing eligible this run.
          summary.push(result)
          continue
        }

        const categories: string[] = Array.isArray(creator.reply_automation_categories)
          ? (creator.reply_automation_categories as string[]).filter(c => !NEVER_AUTO_SEND_CATEGORIES.has(c))
          : []
        if (categories.length === 0) {
          summary.push(result)
          continue
        }

        const maxPerRun = typeof creator.reply_automation_max_per_run === 'number' ? creator.reply_automation_max_per_run : 20
        const minConfidence = (creator.reply_automation_min_confidence as string | null) ?? 'high'

        // Posts belonging to this creator's verified channels — the acting
        // capability only ever applies to those, so there is no point scanning
        // drafts on unverified/research channels at all.
        const { data: posts, error: postsError } = await supabase
          .from('posts')
          .select('id')
          .eq('creator_id', creatorId)
          .in('channel_id', verifiedChannelIds)

        if (postsError) {
          logError('api/cron/auto-reply', postsError, { creator_id: creatorId, stage: 'fetch_posts' })
          summary.push({ ...result, error: 'failed to fetch posts' })
          continue
        }

        const postIds = (posts ?? []).map(p => p.id as string)
        if (postIds.length === 0) {
          summary.push(result)
          continue
        }

        // Undrafted, unapproved, unsent, matching category — pulled generously
        // (more than maxPerRun) since confidence filtering happens client-side
        // below (categorical, not something Postgres needs to rank for us) and
        // some rows will fail that check.
        const { data: comments, error: commentsError } = await supabase
          .from('comments')
          .select(
            'id, post_id, comment_categories!inner (category, draft_reply, draft_confidence, draft_reply_approved_at, reply_send_status)'
          )
          .in('post_id', postIds)
          .in('comment_categories.category', categories)
          .is('comment_categories.draft_reply_approved_at', null)
          .is('comment_categories.reply_send_status', null)
          .not('comment_categories.draft_reply', 'is', null)
          .limit(maxPerRun * 5)

        if (commentsError) {
          logError('api/cron/auto-reply', commentsError, { creator_id: creatorId, stage: 'fetch_candidates' })
          summary.push({ ...result, error: 'failed to fetch candidates' })
          continue
        }

        const candidates: Candidate[] = (comments ?? []).flatMap(row => {
          const cc = Array.isArray(row.comment_categories) ? row.comment_categories[0] : row.comment_categories
          if (!cc) return []
          return [
            {
              commentId: row.id as string,
              postId: row.post_id as string,
              category: cc.category as string,
              confidence: (cc.draft_confidence as string | null) ?? null,
            },
          ]
        })

        const eligible = candidates
          .filter(c => !NEVER_AUTO_SEND_CATEGORIES.has(c.category))
          .filter(c => meetsMinimumConfidence(c.confidence, minConfidence))
          .slice(0, maxPerRun)

        result.considered = eligible.length

        for (const candidate of eligible) {
          try {
            const sendResult = await approveAndSendReply(supabase, {
              creatorId,
              commentId: candidate.commentId,
              autoSent: true,
            })

            if (!sendResult.ok) {
              // Ownership can lapse between the pre-filter above and now (token
              // revoked mid-run, say) — approveAndSendReply re-checks it itself,
              // so a refusal here is exactly that gate doing its job, not a bug.
              result.skipped++
              continue
            }

            if (sendResult.sendStatus === 'sent') result.sent++
            else if (sendResult.sendStatus === 'failed') result.failed++
            else result.skipped++
          } catch (err) {
            logError('api/cron/auto-reply', err, { creator_id: creatorId, comment_id: candidate.commentId, stage: 'send_one' })
            result.failed++
          }
        }

        summary.push(result)
      } catch (err) {
        logError('api/cron/auto-reply', err, { creator_id: creatorId, stage: 'process_creator' })
        summary.push({ ...result, error: err instanceof Error ? err.message : 'Unknown error' })
      }
    }

    return NextResponse.json({ success: true, creatorsProcessed: summary.length, results: summary })
  } catch (err) {
    logError('api/cron/auto-reply', err, { stage: 'request' })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
