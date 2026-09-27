import type { SupabaseClient } from '@supabase/supabase-js'
import { logError, logWarn } from '@/lib/logger'

/**
 * Real per-creator AI spend, computed from what each Anthropic response's own
 * `usage` object reports — not a proxy like "videos analyzed" (a 20-comment
 * video and a 2,000-comment video cost wildly different amounts, and reward
 * evaluation alone can outweigh categorization+drafting combined for a video
 * with many unique commenters). This is what backs the Free/Pro AI budgets in
 * lib/entitlements.ts, so a creator paying for their own Anthropic key can't be
 * run up by one heavy user analyzing everything on a large channel.
 *
 * Current Haiku 4.5 pricing: $1/M input tokens, $5/M output tokens (Anthropic's
 * own pricing page, checked 2026-09-27). Cache multipliers are included for
 * completeness but not exercised by any call site today — Haiku 4.5 requires
 * 4,096 tokens of cacheable prefix before caching does anything at all, and
 * every fixed instructional block in this codebase (categorization rules,
 * reward-decision rules, the research system prompt) is well under that, so
 * adding cache_control to them would be a no-op, not a cost saving.
 */
const HAIKU_4_5_PRICING = {
  inputPerMTok: 1.0,
  outputPerMTok: 5.0,
  cacheWritePerMTok: 1.25,
  cacheReadPerMTok: 0.1,
} as const

export type AnthropicUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export type AiFeature =
  | 'categorize'
  | 'business_relevance'
  | 'draft_reply'
  | 'reward_decide'
  | 'reward_critique'
  | 'audience_profile'
  | 'research_chat'

export function computeCostUsd(usage: AnthropicUsage | undefined | null): number {
  if (!usage) return 0
  const input = usage.input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0

  return (
    (input / 1_000_000) * HAIKU_4_5_PRICING.inputPerMTok +
    (output / 1_000_000) * HAIKU_4_5_PRICING.outputPerMTok +
    (cacheWrite / 1_000_000) * HAIKU_4_5_PRICING.cacheWritePerMTok +
    (cacheRead / 1_000_000) * HAIKU_4_5_PRICING.cacheReadPerMTok
  )
}

/**
 * Records one Anthropic call's cost against a creator. Never throws — this is
 * accounting alongside the real work (categorizing, drafting, deciding), and a
 * failed insert here must not fail the analysis that already happened, the same
 * way embedPostCommentsSafely never blocks analysis over an embedding failure.
 *
 * Fire-and-forget by design: callers should NOT await this on the hot path
 * (call it, don't block on it) except where the caller already awaits other
 * bookkeeping in sequence — a missed row just slightly undercounts that
 * creator's month, not a correctness bug.
 */
export async function recordAiUsage(
  supabase: SupabaseClient,
  args: {
    creatorId: string
    feature: AiFeature
    model: string
    usage: AnthropicUsage | undefined | null
    postId?: string | null
  }
): Promise<void> {
  try {
    const cost = computeCostUsd(args.usage)
    const { error } = await supabase.from('ai_usage_events').insert({
      creator_id: args.creatorId,
      feature: args.feature,
      model: args.model,
      input_tokens: args.usage?.input_tokens ?? 0,
      output_tokens: args.usage?.output_tokens ?? 0,
      cache_creation_input_tokens: args.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: args.usage?.cache_read_input_tokens ?? 0,
      cost_usd: cost,
      post_id: args.postId ?? null,
    })
    if (error) logWarn('ai-usage.record', 'Failed to record AI usage', { creator_id: args.creatorId, feature: args.feature, reason: error.message })
  } catch (err) {
    logError('ai-usage.record', err, { creator_id: args.creatorId, feature: args.feature })
  }
}

function startOfMonthIso(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

/**
 * This calendar month's total AI cost for a creator, in USD, summed across every
 * feature — categorization, drafting, reward decisions/critiques, audience
 * profile updates, research chat. One shared budget rather than per-feature
 * ones: it's one Anthropic key being spent against, and reward evaluation
 * (decide + critique + profile update, up to 3 calls per unique commenter) is
 * usually the single biggest line item for an active channel, bigger than
 * categorization and drafting combined.
 *
 * NOTE: a few lower-volume call sites (research answer verification, research
 * conversation titling, content-idea generation, the daily knowledge-gap/
 * custom-field/profile-fact-status jobs) are not yet instrumented, so this is a
 * close lower bound on real spend, not an exact total. The instrumented paths
 * (categorization, business-relevance, draft replies, reward decide/critique,
 * audience profile updates, research chat) dominate at scale, since they run
 * per-comment or per-member rather than once per post/run.
 */
export async function getMonthlyCostUsd(supabase: SupabaseClient, creatorId: string): Promise<number> {
  const { data, error } = await supabase
    .from('ai_usage_events')
    .select('cost_usd')
    .eq('creator_id', creatorId)
    .gte('created_at', startOfMonthIso())

  if (error) {
    logError('ai-usage.getMonthlyCostUsd', error, { creator_id: creatorId })
    // Fails OPEN: a read failure here must not itself become the reason a
    // creator gets locked out of analysis they're otherwise entitled to.
    return 0
  }

  return (data ?? []).reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0)
}
