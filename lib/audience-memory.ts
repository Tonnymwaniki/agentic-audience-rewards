import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { updateAudienceSegment } from '@/lib/segments'
import { updateAudienceLevel } from '@/lib/levels'
import { logError, logInfo } from '@/lib/logger'
import { recordAiUsage } from '@/lib/ai-usage'

type CommenterProfileRow = { id: string; segment: string | null; level: string | null; profile_summary: string | null }

/**
 * Turns a stored audience-member row into the short line generateDraftReply
 * (lib/categorize.ts) puts in front of the model as `commenterContext` — tone
 * guidance only, e.g. "super fan — loyal fan — asks about restock a lot". Returns
 * null when there's nothing worth saying yet (new/unsegmented commenter).
 */
export function buildCommenterContext(member: CommenterProfileRow): string | null {
  const bits: string[] = []
  if (member.level && member.level !== 'new') bits.push(member.level.replace(/_/g, ' '))
  if (member.segment) bits.push(member.segment.replace(/_/g, ' '))
  if (member.profile_summary) bits.push(member.profile_summary)
  return bits.length ? bits.join(' — ') : null
}

/**
 * Batch version: looks up segment/level/profile_summary for a set of audience
 * member ids and returns a ready-to-use id → context string map, skipping anyone
 * with nothing worth saying. Used wherever drafts are (re)generated in bulk so
 * it's one query for the whole run rather than one per comment.
 */
export async function loadCommenterContexts(
  supabase: SupabaseClient,
  audienceMemberIds: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const uniqueIds = [...new Set(audienceMemberIds)]
  if (uniqueIds.length === 0) return result

  const { data: rows, error } = await supabase
    .from('audience_members')
    .select('id, segment, level, profile_summary')
    .in('id', uniqueIds)

  if (error) {
    logError('audience-memory.loadCommenterContexts', error, { member_count: uniqueIds.length })
    return result
  }

  for (const row of (rows ?? []) as CommenterProfileRow[]) {
    const context = buildCommenterContext(row)
    if (context) result.set(row.id, context)
  }
  return result
}

/** creatorId is optional for backward compatibility with any other caller, but
 *  every call from the reward-evaluation loop (its main caller, and the only one
 *  that runs at real volume) should pass it — otherwise this call's real
 *  Anthropic spend is invisible to that creator's AI budget (lib/entitlements.ts). */
export async function updateAudienceProfile(audience_member_id: string, creatorId?: string | null) {
  const supabase = createServiceClient()
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)

  // Rule-based, no model call, and done BEFORE the early return below: a person with
  // a single buying comment is exactly the one a creator wants segmented, and they
  // would never reach the summary step.
  const segmented = await updateAudienceSegment(supabase, audience_member_id)

  // Same reasoning, same placement: rule-based, no model call, and ahead of the
  // early return so someone with a single comment still gets a level.
  const levelled = await updateAudienceLevel(supabase, audience_member_id)

  try {
    const { data: comments, error: commentsError } = await supabase
      .from('comments')
      .select('text, comment_categories (category, topic)')
      .eq('audience_member_id', audience_member_id)

    if (commentsError) {
      throw commentsError
    }

    if (!comments || comments.length < 2) {
      return { success: true, updated: false, segment: segmented?.segment ?? null, level: levelled?.level ?? null }
    }

    const commentSummaries = comments.map(c => {
      const category = c.comment_categories as unknown as { category: string; topic: string | null } | null
      return {
        text: c.text,
        category: category?.category || 'other',
        topic: category?.topic || null,
      }
    })

    const prompt = `Summarize this audience member's engagement pattern in 2-3 sentences: what topics they care about, their tone, and any notable behavior (loyal, business-interested, skeptical, etc.). Their comments: ${JSON.stringify(commentSummaries)}. Respond with ONLY the summary text, no preamble.`

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`)
    }

    const data = await response.json()

    if (creatorId) {
      recordAiUsage(supabase, {
        creatorId,
        feature: 'audience_profile',
        model: 'claude-haiku-4-5-20251001',
        usage: data.usage,
      })
    }

    const summary = data.content?.[0]?.text?.trim()

    if (!summary) {
      throw new Error('Empty response from Anthropic')
    }

    const { error: updateError } = await supabase
      .from('audience_members')
      .update({ profile_summary: summary, profile_updated_at: new Date().toISOString() })
      .eq('id', audience_member_id)

    if (updateError) {
      throw updateError
    }

    logInfo('audienceMemory.updateProfile', 'Audience profile saved', { audience_member_id })

    return { success: true, updated: true, summary }
  } catch (error) {
    logError('audienceMemory.updateProfile', error, { audience_member_id })
    return { success: false, updated: false }
  } finally {
    clearTimeout(timeoutId)
  }
}

/** A profile older than this is refreshed again even without a brand-new comment. */
const STALE_PROFILE_MS = 3 * 24 * 60 * 60 * 1000

/**
 * How many full (LLM) profile refreshes one call will do. Segment/level are free
 * and always refreshed for everyone passed in; this only bounds the summary calls,
 * so a large batch (a channel's first full import) can't turn into hundreds of
 * sequential Anthropic calls in one categorization run. Anyone left over stays
 * eligible next time this runs, since staleness doesn't reset until it succeeds.
 */
const MAX_PROFILE_SUMMARIES_PER_CALL = 30

/**
 * Keeps segment/level/profile_summary current for a batch of audience members —
 * meant to be called with everyone who just got a newly-categorized comment, from
 * every path that categorizes comments (first analysis, cron polling, manual
 * re-analysis). Before this existed, that data only ever updated when a creator
 * clicked "Evaluate" on Rewards or hit /api/analyze, so most people's segment and
 * level were simply never computed.
 *
 * Segment and level are rule-based (no model call) and always refreshed. The LLM
 * summary is the only part that costs anything, so it's skipped for anyone whose
 * profile_summary is less than STALE_PROFILE_MS old — a repeat commenter doesn't
 * need a fresh paragraph after every single new comment — and capped per call.
 */
export async function refreshAudienceProfiles(
  supabase: SupabaseClient,
  audienceMemberIds: string[],
  creatorId?: string | null
): Promise<void> {
  const uniqueIds = [...new Set(audienceMemberIds)]
  if (uniqueIds.length === 0) return

  const { data: rows, error } = await supabase.from('audience_members').select('id, profile_updated_at').in('id', uniqueIds)
  if (error) {
    logError('audienceMemory.refreshAudienceProfiles', error, { stage: 'fetch_staleness' })
    return
  }
  const updatedAtById = new Map((rows ?? []).map(r => [r.id as string, r.profile_updated_at as string | null]))

  let summariesUsed = 0
  for (const id of uniqueIds) {
    const updatedAt = updatedAtById.get(id) ?? null
    const stale = !updatedAt || Date.now() - new Date(updatedAt).getTime() > STALE_PROFILE_MS

    if (stale && summariesUsed < MAX_PROFILE_SUMMARIES_PER_CALL) {
      summariesUsed++
      // Does segment + level + summary in one call.
      await updateAudienceProfile(id, creatorId)
    } else {
      // Either fresh enough already, or this call's summary budget is spent —
      // segment/level still cost nothing, so they're never skipped.
      await updateAudienceSegment(supabase, id)
      await updateAudienceLevel(supabase, id)
    }
  }
}
