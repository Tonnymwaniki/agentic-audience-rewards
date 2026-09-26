import { createServiceClient } from '@/lib/supabase/service'
import { fetchInBatches } from '@/lib/supabase-helpers'
import { updateAudienceProfile } from '@/lib/audience-memory'
import { decideReward, MAX_TOOL_ROUNDS } from '@/lib/rewards/decide'
import type { RewardedPrecedent } from '@/lib/rewards/evaluate-tools'
import { logError, logInfo, logWarn } from '@/lib/logger'
import { checkPostVerification, getVerifiedChannelIds, resolveVerifiedPostIds, VERIFY_OWNERSHIP_MESSAGE } from '@/lib/channel-verification'

export type EvaluateProgressCallback = (evaluated: number, total: number) => void

/**
 * The post a creator-wide recognition is filed against: the member's most recent
 * comment among the (already verified-only) comments passed in. Null only if the
 * list is empty, which cannot happen for an eligible member.
 */
function latestVerifiedPostFor(
  comments: Array<{ post_id: string; posted_at: string | null }>
): string | null {
  let best: { post_id: string; posted_at: string | null } | null = null
  for (const c of comments) {
    if (!best || (c.posted_at ?? '') > (best.posted_at ?? '')) best = c
  }
  return best?.post_id ?? null
}

export async function evaluateRewards(
  creator_id: string,
  post_id?: string | null,
  onProgress?: EvaluateProgressCallback
) {
  const supabase = createServiceClient()

  // CAPABILITY GATE, before any work or spend. Recognizing someone commits to
  // minting them a token — acting on a real person on behalf of a channel. That
  // requires proof the caller owns the channel.
  //
  // Scoped to the post when one is named. A creator verified for channel A must
  // not be able to evaluate a video belonging to channel B. With no post_id the
  // run spans every post, so it requires at least one verified grant and then
  // filters per post below.
  if (post_id) {
    const verification = await checkPostVerification(supabase, creator_id, post_id)
    if (!verification.verified) {
      logWarn('rewards.evaluate', 'Blocked: channel ownership not verified', {
        creator_id, post_id, channel_id: verification.channelId, reason: verification.reason,
      })
      return {
        success: false,
        blocked: 'unverified_channel' as const,
        error: VERIFY_OWNERSHIP_MESSAGE,
        evaluated: 0,
        qualified: 0,
        results: [],
      }
    }
  } else {
    const verifiedIds = await getVerifiedChannelIds(supabase, creator_id)
    if (verifiedIds.length === 0) {
      logWarn('rewards.evaluate', 'Blocked: no verified channel for this creator', { creator_id })
      return {
        success: false,
        blocked: 'unverified_channel' as const,
        error: VERIFY_OWNERSHIP_MESSAGE,
        evaluated: 0,
        qualified: 0,
        results: [],
      }
    }
  }

  // --- The verified scope: which of this creator's posts may be ACTED on ------
  //
  // "Has at least one verified channel" (the check above) is necessary but was
  // being treated as sufficient. A creator verified for channel A who had also
  // analysed channel B then got creator-wide evaluations of B's audience — the
  // exact thing post-scoped runs refuse. Every step below is now confined to posts
  // on a channel this creator has proven they own:
  //
  //   * which members are candidates   (only people who engaged on verified posts)
  //   * which comments are the evidence (their verified-post comments only)
  //   * what the history tool may read  (the boundary for get_person_full_history)
  //   * which post a reward is filed on (so the claim-time gate can check it)
  //
  // Post-scoped runs resolve to the single, already-verified post.
  const { data: creatorPosts, error: creatorPostsError } = await supabase
    .from('posts')
    .select('id, title')
    .eq('creator_id', creator_id)

  if (creatorPostsError) {
    logError('rewards.evaluate', creatorPostsError, { creator_id, stage: 'fetch_posts' })
  }

  // Two different sets, deliberately kept apart:
  //
  //   allVerifiedPostIds — every post on a channel this creator owns. The history
  //     tool's boundary in BOTH modes: its whole purpose is to see a fan's
  //     engagement across the creator's other videos, so a post-scoped run must not
  //     narrow it to one post (an earlier version of this change did exactly that).
  //
  //   verifiedPostIds — the posts whose commenters are CANDIDATES. The one named
  //     post when scoped (already verified above), otherwise all verified posts.
  const allVerifiedPostIds = await resolveVerifiedPostIds(
    supabase,
    creator_id,
    (creatorPosts || []).map(p => p.id)
  )
  const verifiedPostIds = post_id ? new Set([post_id]) : allVerifiedPostIds

  // Logged in both modes: which posts supply candidates, and how wide the history
  // tool may look. Makes the ownership scope of every run auditable after the fact.
  logInfo('rewards.evaluate', 'Run scoped to verified channels', {
    creator_id,
    post_id: post_id ?? null,
    posts_total: (creatorPosts || []).length,
    candidate_posts: verifiedPostIds.size,
    history_boundary_posts: allVerifiedPostIds.size,
  })

  if (!post_id) {
    if (verifiedPostIds.size === 0) {
      // Verified for a channel, but nothing analysed on it yet.
      return { success: true, evaluated: 0, qualified: 0, results: [] }
    }
  }

  // Paged: PostgREST caps a response at 1000 rows, and a channel can easily have
  // more never-rewarded members than that. Without this, everyone past the first
  // 1000 was silently skipped — measured on a real channel, 337 of 1337 eligible
  // members (including every author who had only replied to a comment).
  const audienceMembers: Array<{ id: string; display_name: string; reward_status: string; profile_summary: string | null }> = []
  const membersPageSize = 1000
  for (let from = 0; ; from += membersPageSize) {
    const { data, error: membersError } = await supabase
      .from('audience_members')
      .select('id, display_name, reward_status, profile_summary')
      .eq('creator_id', creator_id)
      .eq('reward_status', 'none')
      .order('id')
      .range(from, from + membersPageSize - 1)

    if (membersError) {
      logError('rewards.evaluate', membersError, { creator_id, stage: 'fetch_audience_members', page_from: from })
      throw new Error('Failed to fetch audience members')
    }
    audienceMembers.push(...((data ?? []) as typeof audienceMembers))
    if (!data || data.length < membersPageSize) break
  }

  if (audienceMembers.length === 0) {
    return { success: true, evaluated: 0, qualified: 0, results: [] }
  }

  const memberIds = audienceMembers.map(m => m.id)

  const allComments: Array<{ id: string; audience_member_id: string; post_id: string; text: string; posted_at: string | null }> = []
  const commentsBatchSize = 200

  for (let i = 0; i < memberIds.length; i += commentsBatchSize) {
    const batch = memberIds.slice(i, i + commentsBatchSize)
    // Confined to verified posts in BOTH modes. Previously only post-scoped runs
    // were filtered, so a creator-wide run read comments on every channel.
    const query = supabase
      .from('comments')
      .select('id, audience_member_id, post_id, text, posted_at')
      .in('audience_member_id', batch)
      .in('post_id', Array.from(verifiedPostIds))

    let page = 0
    const pageSize = 1000
    let hasMore = true

    while (hasMore) {
      const { data, error } = await query.range(page * pageSize, (page + 1) * pageSize - 1)

      if (error) {
        logError('rewards.evaluate', error, { creator_id, stage: 'fetch_comments_batch', page })
        break
      }
      if (data) allComments.push(...data)

      if (!data || data.length < pageSize) {
        hasMore = false
      } else {
        page++
      }
    }
  }

  const comments = allComments

  console.log("REWARD DEBUG - post_id received:", post_id)
  console.log("REWARD DEBUG - comments returned:", comments.length, "post_id filter active:", !!post_id)

  const commentIds = comments.map(c => c.id)

  let categories: Array<{ comment_id: string; category: string; topic: string | null }> = []

  if (commentIds.length > 0) {
    const categoryRows = await fetchInBatches<{ comment_id: string; category: string; topic: string | null }>(supabase, {
      table: 'comment_categories',
      select: 'comment_id, category, topic',
      inColumn: 'comment_id',
      inValues: commentIds,
    })

    categories = categoryRows
  }

  const commentsByMember = new Map<string, Array<{ id: string; post_id: string; text: string; posted_at: string | null }>>()
  for (const comment of comments) {
    const list = commentsByMember.get(comment.audience_member_id) || []
    list.push(comment)
    commentsByMember.set(comment.audience_member_id, list)
  }

  const categoriesByCommentId = new Map(categories.map(c => [c.comment_id, c]))

  const eligibleMembers = audienceMembers.filter(member => {
    const memberComments = commentsByMember.get(member.id) || []
    return memberComments.length >= 1
  })

  console.log("REWARD DEBUG - members found for evaluation:", eligibleMembers.length)

  // Held at 20, but the arithmetic behind it has been re-derived rather than
  // assumed. Worst case per member is now FIVE sequential Claude calls: the initial
  // decision, one round per tool lookup (MAX_TOOL_ROUNDS), the self-critique, and
  // the profile update.
  //
  // Measured rather than estimated: a real 11-member batch took 86s — 7.8s per
  // member with tool lookups on every one and no critiques (all high confidence).
  // The critique only fires for medium/low decisions and costs ~2-3s, so even if
  // every member needed one the average lands near 11s, giving ~27 members inside
  // the route's 300s budget. 20 keeps a margin under that while still firing before
  // a run can silently time out.
  const ELIGIBLE_MEMBERS_WARNING_THRESHOLD = 20
  const WORST_CASE_CALLS_PER_MEMBER = 3 + MAX_TOOL_ROUNDS

  if (eligibleMembers.length > ELIGIBLE_MEMBERS_WARNING_THRESHOLD) {
    console.warn(
      `Reward evaluate warning: ${eligibleMembers.length} eligible members for creator ${creator_id}` +
      (post_id ? ` (post ${post_id})` : '') +
      ` — each member makes 2 sequential Claude calls in the clear-cut case and up to ${WORST_CASE_CALLS_PER_MEMBER}` +
      ` when the decision needs tool lookups and a self-critique, so this run may approach the function duration limit.`
    )
  }

  // --- Run-scoped context for the decision tools -----------------------------
  //
  // Resolved once for the whole batch, not per member. get_person_full_history
  // deliberately looks across ALL of this creator's videos even when the run is
  // scoped to one post_id, which is the point of the tool — but it must stay inside
  // this creator's posts, so those ids are the boundary it queries within.
  // The history tool's boundary. It still looks across videos — that is its
  // purpose — but only across VERIFIED ones, so a recognition can never be
  // justified by engagement on a channel the creator does not own.
  const creatorPostIds = Array.from(allVerifiedPostIds)
  const postTitles = new Map((creatorPosts || []).map(p => [p.id, p.title as string]))

  // Precedent is identical for every member in this run, so it is fetched at most
  // once and only if some evaluation actually asks for it. Boxed so decideReward
  // can populate it for the whole batch.
  const precedentCache: { value: RewardedPrecedent | null } = { value: null }

  let evaluated = 0
  let qualified = 0
  const results: Array<{
    audience_member_display_name: string
    qualifies: boolean
    reason: string
    /** null when the model didn't score it or returned something unrecognised. */
    confidence?: string | null
    /** Which lookups the decision actually needed — empty for the clear-cut cases. */
    toolsUsed?: string[]
    /** Whether a second, skeptical pass ran, and whether it changed the answer. */
    critiqued?: boolean
    overturned?: boolean
  }> = []

  for (const member of eligibleMembers) {
    const memberComments = commentsByMember.get(member.id) || []

    const distinctPosts = new Set(memberComments.map(c => c.post_id)).size
    const purchaseIntentCount = memberComments.filter(c => categoriesByCommentId.get(c.id)?.category === 'purchase_intent').length
    const praiseCount = memberComments.filter(c => categoriesByCommentId.get(c.id)?.category === 'praise').length
    const questionCount = memberComments.filter(c => categoriesByCommentId.get(c.id)?.category === 'question').length

    const sampleComments = memberComments.slice(0, 3).map(c => c.text)

    const signals = {
      totalComments: memberComments.length,
      distinctPosts,
      purchaseIntentCount,
      praiseCount,
      questionCount,
      sampleComments,
      priorEngagementProfile: member.profile_summary || null,
    }

    try {
      const { decision, toolsUsed, critique } = await decideReward(
        { supabase, creatorPostIds, postTitles, memberIds, precedentCache },
        member,
        signals
      )

      if (toolsUsed.length > 0) {
        console.log(`Reward evaluate: ${member.display_name} — tools used: ${toolsUsed.join(', ')}`)
      }
      if (critique.overturned) {
        logInfo('rewards.evaluate', 'Decision overturned on self-critique', { creator_id, audience_member_id: member.id, member: member.display_name })
      }

      if (!decision) {
        results.push({
          audience_member_display_name: member.display_name,
          qualifies: false,
          reason: 'Failed to parse AI response',
        })
        evaluated++
        onProgress?.(evaluated, eligibleMembers.length)
        continue
      }

      try {
        await updateAudienceProfile(member.id)
      } catch (profileErr) {
        logError('rewards.evaluate', profileErr, { creator_id, audience_member_id: member.id, stage: 'update_audience_profile' })
      }

      if (!decision.qualifies) {
        results.push({
          audience_member_display_name: member.display_name,
          qualifies: false,
          reason: decision.reason,
          confidence: decision.confidence,
          toolsUsed,
          critiqued: critique.critiqued,
          overturned: critique.overturned,
        })
        evaluated++
        onProgress?.(evaluated, eligibleMembers.length)
        continue
      }

      // Filed against a real, verified post in BOTH modes. Creator-wide runs used to
      // write post_id: null, and the claim-time ownership gate skips rewards with no
      // post — so every creator-wide reward bypassed it. It is now the member's most
      // recent comment on a verified channel, which is also the most honest answer to
      // "which video is this recognition for?".
      const rewardPostId = post_id || latestVerifiedPostFor(commentsByMember.get(member.id) || [])

      const { error: insertError } = await supabase
        .from('reward_events')
        .insert({
          audience_member_id: member.id,
          reason: decision.reason,
          // Persisted so the Rewards page can steer the creator to the shaky calls.
          confidence: decision.confidence,
          status: 'pending',
          claim_token: crypto.randomUUID(),
          post_id: rewardPostId,
        })

      if (insertError) {
        logError('rewards.evaluate', insertError, { creator_id, audience_member_id: member.id, post_id: rewardPostId, stage: 'insert_reward_event' })
      } else {
        const { error: updateError } = await supabase
          .from('audience_members')
          .update({ reward_status: 'eligible' })
          .eq('id', member.id)

        if (updateError) {
          logError('rewards.evaluate', updateError, { creator_id, audience_member_id: member.id, stage: 'mark_member_eligible' })
        } else {
          qualified++
        }
      }

      results.push({
        audience_member_display_name: member.display_name,
        qualifies: true,
        reason: decision.reason,
        confidence: decision.confidence,
        toolsUsed,
        critiqued: critique.critiqued,
        overturned: critique.overturned,
      })
      evaluated++
      onProgress?.(evaluated, eligibleMembers.length)
    } catch (err) {
      logError('rewards.evaluate', err, { creator_id, audience_member_id: member.id, stage: 'evaluate_member' })
      results.push({
        audience_member_display_name: member.display_name,
        qualifies: false,
        reason: err instanceof Error ? err.message : 'Unknown error',
      })
      evaluated++
      onProgress?.(evaluated, eligibleMembers.length)
    }
  }

  // Was console.error with the entire results array inlined, which meant every
  // successful run reported itself as an error and buried the real ones. It is an
  // info-level summary; the per-member detail is already returned to the caller.
  logInfo('rewards.evaluate', 'Evaluation complete', {
    creator_id,
    post_id: post_id || null,
    evaluated,
    qualified,
    overturned_by_critic: results.filter(r => r.overturned).length,
  })

  return { success: true, evaluated, qualified, results }
}
