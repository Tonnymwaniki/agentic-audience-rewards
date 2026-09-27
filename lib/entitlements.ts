import type { SupabaseClient } from '@supabase/supabase-js'
import { getMonthlyCostUsd } from '@/lib/ai-usage'

/**
 * Free vs Pro limits, and the checks routes call before doing the thing a limit
 * gates. Kept here as one file rather than scattered inline checks so the two
 * places that need to agree — the pricing page copy and the actual enforcement —
 * read from the same numbers.
 *
 * NOTE on "connected channels": this app's schema ties ONE YouTube OAuth grant to
 * one creator row (`youtube_oauth_tokens.creator_id` is its PRIMARY KEY — see
 * that migration's comment). There is no multi-channel-per-creator concept to
 * gate yet; supporting several channels per account would be a separate,
 * larger schema change, not a billing toggle. So the Free/Pro split here is
 * built entirely on limits that already vary per creator today: monthly video
 * analysis volume, research chat volume, real AI spend, and features that exist
 * as a single on/off (export, audience segments, reply-sending once it ships).
 */
export const FREE_LIMITS = {
  videosAnalyzedPerMonth: 3,
  researchQueriesPerMonth: 10,
} as const

/**
 * Hard monthly ceiling on real Anthropic spend per creator, in USD, on top of the
 * count-based limits above. This is the actual protection against the scenario
 * that count-based limits can't cover: a single Pro creator with a very large
 * channel (thousands of videos, or a few videos with tens of thousands of
 * comments) running analysis until it consumes far more of the API key's spend
 * than their KES 999/month covers. "Unlimited" on Pro means unlimited videos and
 * research questions, not an unlimited AI bill — this is the number that keeps
 * that promise honest.
 *
 * Sized from lib/ai-usage.ts's real prompt/batch structure, not guessed: a video
 * with ~170 comments and ~125 unique commenters costs roughly $0.40-0.50 in AI
 * calls end to end (categorization + business-relevance + draft replies + reward
 * decide/critique/profile-update per unique commenter). At $1 ≈ KES 130:
 *   - free: covers the 3-video/10-query count limits with real room to spare
 *     (~KES 210 worst case), so the count limits — not this — are what a free
 *     creator actually hits first.
 *   - pro: ~KES 800 of AI spend, i.e. roughly 15-16 comment-heavy videos in a
 *     month, leaving margin under the KES 999 price for infra + PayHero fees.
 *     A creator who is genuinely about to exceed this should be moved to a
 *     custom/metered arrangement, not silently cut off mid-channel.
 */
export const AI_MONTHLY_BUDGET_USD = {
  free: 1.6,
  pro: 6.2,
} as const

export type Plan = 'free' | 'pro'

export async function getCreatorPlan(supabase: SupabaseClient, creatorId: string): Promise<Plan> {
  const { data } = await supabase.from('creators').select('plan').eq('id', creatorId).maybeSingle()
  return data?.plan === 'pro' ? 'pro' : 'free'
}

function startOfMonthIso(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

export type EntitlementCheck =
  | { allowed: true }
  | { allowed: false; reason: string; limit: number; used: number; unit?: 'videos' | 'queries' | 'kes' }

const USD_TO_KES = 130

function kes(usd: number): number {
  return Math.round(usd * USD_TO_KES)
}

/**
 * The real-spend gate, shared by both checkCanAnalyzeVideo and
 * checkResearchQuota. Applies to BOTH plans — free creators are protected by
 * the count limits below well before this would ever fire, but Pro has no count
 * limit at all, so this is the only thing standing between "unlimited analysis"
 * and an unbounded Anthropic bill on one account.
 */
async function checkAiBudget(supabase: SupabaseClient, creatorId: string, plan: Plan): Promise<EntitlementCheck> {
  const budgetUsd = AI_MONTHLY_BUDGET_USD[plan]
  const usedUsd = await getMonthlyCostUsd(supabase, creatorId)

  if (usedUsd >= budgetUsd) {
    return {
      allowed: false,
      reason:
        plan === 'pro'
          ? `This account has used its fair-use AI budget for this month (~KES ${kes(usedUsd)} of ~KES ${kes(budgetUsd)}). This resets next month — contact us if you need a higher plan for a very large channel.`
          : `Free plan's AI budget for this month is used up (~KES ${kes(usedUsd)} of ~KES ${kes(budgetUsd)}). Upgrade to Pro for a much higher monthly budget.`,
      limit: kes(budgetUsd),
      used: kes(usedUsd),
      unit: 'kes',
    }
  }

  return { allowed: true }
}

/**
 * Call before starting analysis on a NEW video (ingestYouTubeVideo /
 * categorizePost path). Re-analyzing an already-analyzed video should not be
 * gated here — this only counts posts newly reaching analysis_status='done'
 * this calendar month, so callers must check this BEFORE kicking off analysis
 * on a video that hasn't been analyzed yet, not on every re-check.
 */
export async function checkCanAnalyzeVideo(
  supabase: SupabaseClient,
  creatorId: string
): Promise<EntitlementCheck> {
  const plan = await getCreatorPlan(supabase, creatorId)

  if (plan === 'free') {
    const { count } = await supabase
      .from('posts')
      .select('id', { count: 'exact', head: true })
      .eq('creator_id', creatorId)
      .eq('analysis_status', 'done')
      .gte('ingested_at', startOfMonthIso())

    const used = count ?? 0
    if (used >= FREE_LIMITS.videosAnalyzedPerMonth) {
      return {
        allowed: false,
        reason: `Free plan includes ${FREE_LIMITS.videosAnalyzedPerMonth} analyzed videos per month. Upgrade to Pro for unlimited analysis.`,
        limit: FREE_LIMITS.videosAnalyzedPerMonth,
        used,
        unit: 'videos',
      }
    }
  }

  // Real-spend gate applies on both plans — see checkAiBudget's comment.
  return checkAiBudget(supabase, creatorId, plan)
}

/** Call before sending a research chat message (app/api/research/chat). */
export async function checkResearchQuota(
  supabase: SupabaseClient,
  creatorId: string
): Promise<EntitlementCheck> {
  const plan = await getCreatorPlan(supabase, creatorId)

  if (plan === 'free') {
    const { data: conversations } = await supabase
      .from('research_conversations')
      .select('id')
      .eq('creator_id', creatorId)

    const conversationIds = (conversations ?? []).map(c => c.id)

    if (conversationIds.length > 0) {
      const { count } = await supabase
        .from('research_messages')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'user')
        .in('conversation_id', conversationIds)
        .gte('created_at', startOfMonthIso())

      const used = count ?? 0
      if (used >= FREE_LIMITS.researchQueriesPerMonth) {
        return {
          allowed: false,
          reason: `Free plan includes ${FREE_LIMITS.researchQueriesPerMonth} research questions per month. Upgrade to Pro for unlimited research chat.`,
          limit: FREE_LIMITS.researchQueriesPerMonth,
          used,
          unit: 'queries',
        }
      }
    }
  }

  // Real-spend gate applies on both plans — see checkAiBudget's comment.
  return checkAiBudget(supabase, creatorId, plan)
}

/** Simple on/off checks — export, audience segments, and (once built) reply-sending. */
export async function requiresPro(supabase: SupabaseClient, creatorId: string): Promise<boolean> {
  return (await getCreatorPlan(supabase, creatorId)) !== 'pro'
}
