import { createServiceClient } from '@/lib/supabase/service'
import { fetchInBatches } from '@/lib/supabase-helpers'
import { updateAudienceProfile } from '@/lib/audience-memory'
import { decideReward, MAX_TOOL_ROUNDS } from '@/lib/rewards/decide'
import type { RewardedPrecedent } from '@/lib/rewards/evaluate-tools'

export type EvaluateProgressCallback = (evaluated: number, total: number) => void

export async function evaluateRewards(
  creator_id: string,
  post_id?: string | null,
  onProgress?: EvaluateProgressCallback
) {
  const supabase = createServiceClient()

  const { data: audienceMembers, error: membersError } = await supabase
    .from('audience_members')
    .select('id, display_name, reward_status, profile_summary')
    .eq('creator_id', creator_id)
    .eq('reward_status', 'none')

  if (membersError) {
    console.error('Audience members fetch error:', JSON.stringify(membersError, Object.getOwnPropertyNames(membersError), 2))
    throw new Error('Failed to fetch audience members')
  }

  if (!audienceMembers || audienceMembers.length === 0) {
    return { success: true, evaluated: 0, qualified: 0, results: [] }
  }

  const memberIds = audienceMembers.map(m => m.id)

  const allComments: Array<{ id: string; audience_member_id: string; post_id: string; text: string }> = []
  const commentsBatchSize = 200

  for (let i = 0; i < memberIds.length; i += commentsBatchSize) {
    const batch = memberIds.slice(i, i + commentsBatchSize)
    let query = supabase
      .from('comments')
      .select('id, audience_member_id, post_id, text')
      .in('audience_member_id', batch)

    if (post_id) {
      query = query.eq('post_id', post_id)
    }

    let page = 0
    const pageSize = 1000
    let hasMore = true

    while (hasMore) {
      const { data, error } = await query.range(page * pageSize, (page + 1) * pageSize - 1)

      if (error) {
        console.error('Comments batch error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
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

  const commentsByMember = new Map<string, Array<{ id: string; post_id: string; text: string }>>()
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
  const { data: creatorPosts, error: creatorPostsError } = await supabase
    .from('posts')
    .select('id, title')
    .eq('creator_id', creator_id)

  if (creatorPostsError) {
    console.error('Reward evaluate posts fetch error:', JSON.stringify(creatorPostsError, Object.getOwnPropertyNames(creatorPostsError), 2))
  }

  const creatorPostIds = (creatorPosts || []).map(p => p.id)
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
        console.log(`Reward evaluate: ${member.display_name} — decision overturned on self-critique.`)
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
        console.error('Audience profile update error:', JSON.stringify(profileErr, Object.getOwnPropertyNames(profileErr), 2))
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

      const { error: insertError } = await supabase
        .from('reward_events')
        .insert({
          audience_member_id: member.id,
          reason: decision.reason,
          // Persisted so the Rewards page can steer the creator to the shaky calls.
          confidence: decision.confidence,
          status: 'pending',
          claim_token: crypto.randomUUID(),
          post_id: post_id || null,
        })

      if (insertError) {
        console.error('Reward event insert error:', JSON.stringify(insertError, Object.getOwnPropertyNames(insertError), 2))
      } else {
        const { error: updateError } = await supabase
          .from('audience_members')
          .update({ reward_status: 'eligible' })
          .eq('id', member.id)

        if (updateError) {
          console.error('Audience member update error:', JSON.stringify(updateError, Object.getOwnPropertyNames(updateError), 2))
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
      console.error('Reward evaluate error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
      results.push({
        audience_member_display_name: member.display_name,
        qualifies: false,
        reason: err instanceof Error ? err.message : 'Unknown error',
      })
      evaluated++
      onProgress?.(evaluated, eligibleMembers.length)
    }
  }

  console.error('Reward evaluate results:', JSON.stringify(results, null, 2))

  return { success: true, evaluated, qualified, results }
}
