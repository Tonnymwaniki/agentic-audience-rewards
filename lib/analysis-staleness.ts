import type { SupabaseClient } from '@supabase/supabase-js'
import { checkPostVerification } from '@/lib/channel-verification'
import { logError, logWarn } from '@/lib/logger'

/**
 * Stale-run detection for post analysis.
 *
 * Analysis runs in a background job. If that job dies — function timeout, deploy,
 * crashed dev worker — its final status write never happens and the post would sit
 * at analysis_status='running' forever, with the client polling a run that no
 * longer exists. A run that has made no progress for STALE_RUN_THRESHOLD_MS is
 * treated as interrupted and moved to the terminal state that matches what it
 * actually finished.
 *
 * Progress is measured by posts.analysis_heartbeat_at, which a database trigger
 * stamps on every progress write (migration 38). Fifteen minutes is far beyond any
 * gap between progress writes in a live run: evaluation reports after every
 * member, categorization after every batch, and drafting sends a throttled
 * heartbeat — while a Vercel function cannot outlive its own maxDuration anyway.
 */
export const STALE_RUN_THRESHOLD_MS = 15 * 60 * 1000

export type StaleRunEvidence = {
  stage: string | null
  /** Channel ownership verified for this post right now. */
  verified: boolean
  membersTotal: number
  membersEvaluated: number
  commentsStored: number
  commentsWithCategory: number
}

export type StaleRunOutcome = {
  status: 'done' | 'error'
  stage: 'complete' | 'complete_unverified' | 'interrupted_categorizing' | 'interrupted_evaluating' | 'interrupted'
  why: string
}

/**
 * Decides the terminal state from evidence of what completed.
 *
 * It only reports success when the evidence proves the work finished, and falls
 * back to an interrupted error otherwise — a run wrongly marked done would hide
 * missing rewards or drafts, while a run wrongly marked interrupted costs one
 * retry. Pure, so every branch is unit-testable.
 */
export function decideStaleOutcome(e: StaleRunEvidence): StaleRunOutcome {
  if (e.stage === 'evaluating') {
    // The stage only advances to 'evaluating' after categorizePost has returned
    // success, so categorization is known to be complete here.
    if (!e.verified) {
      // Unverified: the ownership gate refuses evaluation before evaluating
      // anyone, so with nobody evaluated everything this account is permitted to
      // do has finished — the same outcome a surviving run records. If members
      // WERE evaluated, a run that started verified lost its grant mid-way; that
      // partial evaluation is not "complete", so it falls through to interrupted.
      if (e.membersEvaluated === 0) {
        return { status: 'done', stage: 'complete_unverified', why: 'categorization finished; evaluation is not permitted on an unverified channel' }
      }
    } else if (e.membersTotal > 0 && e.membersEvaluated >= e.membersTotal) {
      // evaluateRewards reports progress after each member and does nothing but
      // log after the last one, so every member evaluated means the run finished
      // and only its final status write was lost.
      return { status: 'done', stage: 'complete', why: `all ${e.membersTotal} members were evaluated; only the final status write was lost` }
    }
    return {
      status: 'error',
      stage: 'interrupted_evaluating',
      why: `evaluation stopped at ${e.membersEvaluated} of ${e.membersTotal || 'unknown'} members`,
    }
  }

  if (e.stage === 'categorizing') {
    // Not claimed as done even when every comment has a category: categorizePost
    // writes categories and THEN drafts replies and files notifications, and
    // nothing here can prove that tail finished.
    const where = e.commentsWithCategory >= e.commentsStored && e.commentsStored > 0
      ? 'after categories were saved, during drafting/notifications'
      : `with ${e.commentsWithCategory} of ${e.commentsStored} comments categorized`
    return { status: 'error', stage: 'interrupted_categorizing', why: `categorization stopped ${where}` }
  }

  return { status: 'error', stage: 'interrupted', why: `stopped at unrecognised stage ${JSON.stringify(e.stage)}` }
}

type RunningPost = {
  id: string
  creator_id: string
  analysis_stage: string | null
  analysis_heartbeat_at: string | null
  members_total: number | null
  members_evaluated: number | null
}

export type ReconciledRun = {
  postId: string
  creatorId: string
  outcome: StaleRunOutcome
  lastHeartbeat: string | null
}

async function gatherEvidence(supabase: SupabaseClient, post: RunningPost): Promise<StaleRunEvidence> {
  const [{ count: commentsStored }, { count: commentsWithCategory }, verification] = await Promise.all([
    supabase.from('comments').select('id', { count: 'exact', head: true }).eq('post_id', post.id),
    supabase
      .from('comment_categories')
      .select('comment_id, comments!inner(post_id)', { count: 'exact', head: true })
      .eq('comments.post_id', post.id),
    checkPostVerification(supabase, post.creator_id, post.id),
  ])
  return {
    stage: post.analysis_stage,
    verified: verification.verified,
    membersTotal: post.members_total ?? 0,
    membersEvaluated: post.members_evaluated ?? 0,
    commentsStored: commentsStored ?? 0,
    commentsWithCategory: commentsWithCategory ?? 0,
  }
}

/**
 * Writes the outcome only if the post is STILL running and STILL stale.
 *
 * Compare-and-set: if the job was alive after all and wrote progress between the
 * staleness check and this write, its heartbeat is now newer than the cutoff, the
 * filter matches nothing, and the live run is left alone. Returns whether the row
 * was changed.
 */
export async function applyStaleOutcome(
  supabase: SupabaseClient,
  postId: string,
  cutoffIso: string,
  outcome: StaleRunOutcome
): Promise<boolean> {
  const { data, error } = await supabase
    .from('posts')
    .update({ analysis_status: outcome.status, analysis_stage: outcome.stage })
    .eq('id', postId)
    .eq('analysis_status', 'running')
    .or(`analysis_heartbeat_at.is.null,analysis_heartbeat_at.lt.${cutoffIso}`)
    .select('id')
  if (error) {
    logError('analysis.staleRuns', error, { post_id: postId, stage: 'apply_outcome' })
    return false
  }
  return (data ?? []).length > 0
}

let warnedMissingColumn = false

/**
 * Finds running posts with no progress for STALE_RUN_THRESHOLD_MS and moves each
 * to its terminal state. Scope with postId and/or creatorId; with neither it
 * sweeps every creator (the cron backstop). Never throws — it runs inside the
 * status endpoint, which must keep answering even if this fails.
 *
 * `supabase` must be a service-role client: the verification lookup reads the
 * OAuth token table, which has no RLS policies. Callers that act for a signed-in
 * creator must pass their session-derived creatorId, never a client-supplied one.
 */
export async function reconcileStaleRuns(
  supabase: SupabaseClient,
  scope: { postId?: string; creatorId?: string } = {},
  now: number = Date.now()
): Promise<ReconciledRun[]> {
  const cutoffIso = new Date(now - STALE_RUN_THRESHOLD_MS).toISOString()
  try {
    let query = supabase
      .from('posts')
      .select('id, creator_id, analysis_stage, analysis_heartbeat_at, members_total, members_evaluated')
      .eq('analysis_status', 'running')
      // NULL is stale too: the trigger stamps every transition to 'running', and
      // migration 38 stamped runs already in flight, so a running post without a
      // heartbeat has no evidence of being alive.
      .or(`analysis_heartbeat_at.is.null,analysis_heartbeat_at.lt.${cutoffIso}`)
      .limit(200)
    if (scope.postId) query = query.eq('id', scope.postId)
    if (scope.creatorId) query = query.eq('creator_id', scope.creatorId)

    const { data, error } = await query
    if (error) {
      // Without migration 38 there is no heartbeat, and no safe way to tell a
      // live run from a dead one — ingested_at would declare any run longer than
      // the threshold dead. Detection is skipped rather than guessed.
      if (error.code === '42703' || error.code === 'PGRST204') {
        if (!warnedMissingColumn) {
          warnedMissingColumn = true
          logWarn('analysis.staleRuns', 'posts.analysis_heartbeat_at missing (migration 38 not applied); stale-run detection disabled', {})
        }
        return []
      }
      logError('analysis.staleRuns', error, { stage: 'find_stale', ...scope })
      return []
    }

    const reconciled: ReconciledRun[] = []
    for (const post of (data ?? []) as RunningPost[]) {
      const evidence = await gatherEvidence(supabase, post)
      const outcome = decideStaleOutcome(evidence)
      const changed = await applyStaleOutcome(supabase, post.id, cutoffIso, outcome)
      if (!changed) continue
      logWarn('analysis.staleRuns', 'Interrupted analysis run reconciled', {
        post_id: post.id,
        creator_id: post.creator_id,
        last_heartbeat: post.analysis_heartbeat_at,
        new_status: outcome.status,
        new_stage: outcome.stage,
        why: outcome.why,
        evidence,
      })
      reconciled.push({ postId: post.id, creatorId: post.creator_id, outcome, lastHeartbeat: post.analysis_heartbeat_at })
    }
    return reconciled
  } catch (err) {
    logError('analysis.staleRuns', err, { stage: 'reconcile', ...scope })
    return []
  }
}
