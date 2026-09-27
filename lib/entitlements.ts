import type { SupabaseClient } from '@supabase/supabase-js'

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
 * analysis volume, research chat volume, and features that exist as a single
 * on/off (export, audience segments, reply-sending once it ships).
 */
export const FREE_LIMITS = {
  videosAnalyzedPerMonth: 3,
  researchQueriesPerMonth: 10,
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
  | { allowed: false; reason: string; limit: number; used: number }

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
  if (plan === 'pro') return { allowed: true }

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
    }
  }

  return { allowed: true }
}

/** Call before sending a research chat message (app/api/research/chat). */
export async function checkResearchQuota(
  supabase: SupabaseClient,
  creatorId: string
): Promise<EntitlementCheck> {
  const plan = await getCreatorPlan(supabase, creatorId)
  if (plan === 'pro') return { allowed: true }

  const { data: conversations } = await supabase
    .from('research_conversations')
    .select('id')
    .eq('creator_id', creatorId)

  const conversationIds = (conversations ?? []).map(c => c.id)
  if (conversationIds.length === 0) return { allowed: true }

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
    }
  }

  return { allowed: true }
}

/** Simple on/off checks — export, audience segments, and (once built) reply-sending. */
export async function requiresPro(supabase: SupabaseClient, creatorId: string): Promise<boolean> {
  return (await getCreatorPlan(supabase, creatorId)) !== 'pro'
}
