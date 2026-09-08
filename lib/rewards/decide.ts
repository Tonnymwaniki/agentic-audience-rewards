import type { SupabaseClient } from '@supabase/supabase-js'
import {
  REWARD_TOOLS,
  getPersonFullHistory,
  getSimilarRewardedPeople,
  type RewardedPrecedent,
} from '@/lib/rewards/evaluate-tools'
import { normalizeConfidence, CONFIDENCE_PROMPT_GUIDANCE, type Confidence } from '@/lib/confidence'

/**
 * Tool rounds allowed per person. Two is enough to fetch both tools once each and
 * still decide; this runs inside a per-member loop, so every extra round multiplies
 * across the whole batch.
 */
export const MAX_TOOL_ROUNDS = 2
const ANTHROPIC_TIMEOUT_MS = 15000

export type RewardDecision = {
  qualifies: boolean
  /** null when the model omitted it or returned something unrecognised. */
  confidence: Confidence | null
  reason: string
}

/** Everything the tools need, resolved once per run rather than per member. */
export type DecisionContext = {
  supabase: SupabaseClient
  /** Every post belonging to this creator — the boundary the history tool queries within. */
  creatorPostIds: string[]
  postTitles: Map<string, string>
  /** This creator's audience member ids, for scoping the precedent lookup. */
  memberIds: string[]
  /** Cached across the batch: precedent is identical for every member in a run. */
  precedentCache: { value: RewardedPrecedent | null }
}

/**
 * Decides whether one audience member qualifies, with two optional lookups
 * available to the model before it commits.
 *
 * Extracted from evaluateRewards so the decision can be exercised directly — in a
 * test or a one-off — without running a whole batch and writing reward rows.
 *
 * Returns decision: null when the model's reply could not be parsed; the caller
 * decides what that means for the member.
 */
export async function decideReward(
  ctx: DecisionContext,
  member: { id: string; display_name: string },
  signals: Record<string, unknown>
): Promise<{ decision: RewardDecision | null; toolsUsed: string[] }> {
  const { supabase, creatorPostIds, postTitles, memberIds, precedentCache } = ctx

    const prompt = `You are deciding which audience members deserve on-chain recognition for genuine engagement with a content creator. This audience member's activity: ${JSON.stringify({ ...signals, audience_member_id: member.id })}.

If priorEngagementProfile is present, it summarizes this person's engagement across all of the creator's posts over time — weigh it alongside the current signals, and let a consistent pattern of genuine engagement count in their favor even if this post's comments alone are borderline.

IMPORTANT: the signals above may be scoped to a single video. If the decision is borderline, or you want to know whether this person engages consistently beyond this one video, call get_person_full_history first. If you are unsure where this creator's bar sits, call get_similar_rewarded_people to see who they have already rewarded and why. Decide immediately without any tool call when the signals are already clear-cut.

Qualify people who show genuine engagement — this can include: commenting 3+ times with substantive (non-spam, non-repetitive) content even on a single post, asking thoughtful questions, showing clear purchase intent, or giving specific praise that references actual content (not just emojis or one-word reactions). Do not require engagement across multiple posts — that's a bonus signal, not a requirement. Disqualify only clear one-off/low-effort engagement (1-2 very short or generic comments) or spam/repetitive content.

When you have decided, respond with ONLY valid JSON: {"qualifies": true or false, "confidence": "high" or "medium" or "low", "reason": "one sentence explaining why, referencing specific evidence"}

On confidence: ${CONFIDENCE_PROMPT_GUIDANCE}`

    type ContentBlock =
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      { role: 'user', content: prompt },
    ]

    let content: ContentBlock[] = []
    let toolRounds = 0
    const toolsUsed: string[] = []

    // Tool-use loop. Most members should exit on the first pass with no tool call
    // at all — the tools exist for the borderline cases.
    for (;;) {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS)

      let response: Response
      try {
        response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY!,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 512,
            tools: REWARD_TOOLS,
            messages,
          }),
          signal: controller.signal,
        })
      } catch (fetchErr) {
        clearTimeout(timeoutId)
        if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
          console.error('Reward evaluate error: request timed out after 15s')
        } else {
          console.error('Reward evaluate fetch error:', JSON.stringify(fetchErr, Object.getOwnPropertyNames(fetchErr), 2))
        }
        throw fetchErr instanceof Error ? fetchErr : new Error('Request failed')
      } finally {
        clearTimeout(timeoutId)
      }

      if (!response.ok) {
        throw new Error(`Anthropic API error: ${response.status}`)
      }

      const data = await response.json()
      content = (data.content || []) as ContentBlock[]
      const toolUses = content.filter(
        (block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use'
      )

      // No tool requested, or the round budget is spent: whatever text came back is
      // the decision. Stopping at the cap rather than looping is what keeps a large
      // batch inside the function's time limit.
      if (toolUses.length === 0 || toolRounds >= MAX_TOOL_ROUNDS) break

      toolRounds++
      messages.push({ role: 'assistant', content })

      const toolResults = []
      for (const toolUse of toolUses) {
        toolsUsed.push(toolUse.name)
        let result: unknown

        if (toolUse.name === 'get_person_full_history') {
          // The member id comes from OUR loop, not from the model's input, so a
          // tool call cannot be steered into looking up a different person.
          result = await getPersonFullHistory(supabase, creatorPostIds, postTitles, member.id)
        } else if (toolUse.name === 'get_similar_rewarded_people') {
          // Identical for every member in this run, so fetched once and reused
          // rather than re-queried per person.
          if (!precedentCache.value) {
            precedentCache.value = await getSimilarRewardedPeople(supabase, memberIds)
          }
          result = precedentCache.value
        } else {
          result = { error: `Unknown tool: ${toolUse.name}` }
        }

        toolResults.push({
          type: 'tool_result' as const,
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        })
      }

      messages.push({ role: 'user', content: toolResults })
    }

    if (toolsUsed.length > 0) {
      console.log(`Reward evaluate: ${member.display_name} — tools used: ${toolsUsed.join(', ')}`)
    }

    const textBlock = content.find(
      (block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text'
    )
    const replyText = textBlock?.text

    if (!replyText) {
      throw new Error('Empty response from Anthropic')
    }

    const match = replyText.match(/\{[\s\S]*\}/)
    if (!match) {
      throw new Error('No JSON object found in response')
    }

    let decision: RewardDecision
    try {
      const parsed = JSON.parse(match[0])
      decision = {
        qualifies: Boolean(parsed.qualifies),
        // Normalised rather than trusted: the model can return "very high", a number
        // or nothing at all, and an unrecognised value has to become null rather
        // than a confident-looking badge nobody actually scored.
        confidence: normalizeConfidence(parsed.confidence),
        reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      }
    } catch (parseErr) {
      console.error('Reward evaluate parse error:', JSON.stringify(parseErr, Object.getOwnPropertyNames(parseErr), 2))
      return { decision: null, toolsUsed }
    }

    return { decision, toolsUsed }
}
