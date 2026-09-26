import type { SupabaseClient } from '@supabase/supabase-js'
import type { AudienceInsight, TrendWindow } from '@/lib/audience-insights'
import { logError, logInfo, logWarn } from '@/lib/logger'

/**
 * The Insight Agent: after the daily audience_insights refresh, it looks for themes
 * whose trend swung sharply, asks Claude whether each swing is genuinely worth the
 * creator's attention, and sends the ones that are to the inbox as notifications.
 *
 *   1. Filter (no AI): |trend_pct| >= 40, the theme has >= 5 comments overall, AND
 *      the larger side of the swing rests on >= 5 comments in its 30-day window.
 *      The last condition is the one that matters: comment_count is ALL-TIME, so a
 *      theme with 200 comments can still "swing" on 2 -> 3 recent comments. Themes
 *      surfaced for this creator in the last 7 days are skipped (surfaced_insights).
 *   2. Judge (one batched Claude call per creator): notable or not, and if notable,
 *      one specific sentence. A big swing can still be "not notable".
 *   3. Record EVERY verdict in surfaced_insights, so a theme is left alone for 7
 *      days whichever way it was judged — no repeat notification for an accepted
 *      one, and no repeat AI call for a rejected one. Accepted: claim, then notify
 *      (if notifying fails, the claim is removed so a later run can try again).
 *      Rejected: recorded with outcome 'rejected'. A theme Claude didn't return a
 *      verdict for, or a failed AI call, records nothing and is retried next run.
 *
 * Nothing here can fail the insights refresh; errors are logged and reported.
 */

export const INSIGHT_TREND_THRESHOLD_PCT = 40
export const INSIGHT_MIN_THEME_COMMENTS = 5
export const INSIGHT_MIN_WINDOW_COMMENTS = 5
export const INSIGHT_COOLDOWN_DAYS = 7
const MODEL = 'claude-haiku-4-5-20251001'

export type InsightCandidate = {
  theme: string
  trendPct: number
  direction: string
  commentCount: number
  window: TrendWindow
}

export type FilteredOut = { theme: string; reason: string }

/** Step 1, pure: which stored themes are even worth asking about. */
export function selectInsightCandidates(
  insights: AudienceInsight[],
  windows: Map<string, TrendWindow>,
  recentlySurfaced: Set<string>
): { candidates: InsightCandidate[]; filtered: FilteredOut[] } {
  const candidates: InsightCandidate[] = []
  const filtered: FilteredOut[] = []
  for (const i of insights) {
    const w = windows.get(i.topic)
    const out = (reason: string) => filtered.push({ theme: i.topic, reason })
    if (i.trend_pct === null) { out(`no trend percentage (${i.trend_direction})`); continue }
    if (Math.abs(i.trend_pct) < INSIGHT_TREND_THRESHOLD_PCT) { out(`swing ${i.trend_pct}% below ±${INSIGHT_TREND_THRESHOLD_PCT}%`); continue }
    if (i.comment_count < INSIGHT_MIN_THEME_COMMENTS) { out(`only ${i.comment_count} comments overall`); continue }
    if (!w || Math.max(w.recent, w.previous) < INSIGHT_MIN_WINDOW_COMMENTS) {
      out(`small sample: ${w?.previous ?? '?'} → ${w?.recent ?? '?'} comments across the two windows`)
      continue
    }
    if (recentlySurfaced.has(i.topic)) { out(`already judged in the last ${INSIGHT_COOLDOWN_DAYS} days`); continue }
    candidates.push({ theme: i.topic, trendPct: i.trend_pct, direction: i.trend_direction, commentCount: i.comment_count, window: w })
  }
  return { candidates, filtered }
}

export type InsightJudgement = {
  theme: string
  notable: boolean
  reason: string
  insight: string | null
  /** 'ai' = Claude's sentence; 'template' = it omitted the required figure, so a factual one was used. */
  insightSource?: 'ai' | 'template'
}

export type JudgeInput = {
  candidates: InsightCandidate[]
  postTitles: Map<string, string>
}

const pct = (n: number) => `${n > 0 ? '+' : ''}${Math.round(n)}%`

/** The video most of a theme's recent comments sit under, if one clearly dominates. */
function mainVideo(c: InsightCandidate, postTitles: Map<string, string>): string | null {
  const top = c.window.recentByPost[0]
  return top && top.comments * 2 >= c.window.recent ? postTitles.get(top.post_id) ?? null : null
}

/**
 * The figure a notification must state, e.g. "367%". Claude is told to use it, and
 * a sentence without it is replaced: a notification should never describe a trend
 * without its actual size.
 */
export function requiredFigure(c: InsightCandidate): string {
  return `${Math.abs(Math.round(c.trendPct))}%`
}

/** Plain factual sentence used when Claude's omits the figure. */
export function templateInsight(c: InsightCandidate, postTitles: Map<string, string>): string {
  const video = mainVideo(c, postTitles)
  const theme = c.theme.replace(/_/g, ' ')
  return `Comments about ${theme} are ${c.trendPct > 0 ? 'up' : 'down'} ${requiredFigure(c)} as a share of all comments over the last ${c.window.windowDays} days${video ? `, mostly under "${video}"` : ''}.`
}

/** Step 2: one Claude call for all of a creator's candidates. */
export async function judgeInsightCandidates({ candidates, postTitles }: JudgeInput): Promise<InsightJudgement[]> {
  const payload = candidates.map(c => ({
    theme: c.theme,
    change_in_share_of_comments: pct(c.trendPct),
    must_state_figure: requiredFigure(c),
    main_video: mainVideo(c, postTitles),
    windows: `last ${c.window.windowDays} days: ${c.window.recent} of ${c.window.totalRecent} comments; the ${c.window.windowDays} days before: ${c.window.previous} of ${c.window.totalPrevious}`,
    sentiment_recent: c.window.recentSentiment,
    sentiment_before: c.window.previousSentiment,
    recent_comments_by_video: c.window.recentByPost.slice(0, 3).map(v => ({ video: postTitles.get(v.post_id) ?? 'Untitled video', comments: v.comments })),
    sample_recent_comments: c.window.recentSamples.map(s => s.text),
  }))

  const prompt = `You watch a YouTube creator's audience and decide which shifts are worth sending them a notification about. They will see at most a few of these, so be selective.

Each candidate is a THEME whose share of all comments changed sharply between the last ${candidates[0].window.windowDays} days and the ${candidates[0].window.windowDays} days before. You get the numbers, the sentiment in each window, which videos the recent comments came from, and sample recent comments.

For each candidate decide "notable": true only if it is something the creator would genuinely want to know and could act on — a real change in what the audience talks about or how they feel, clearly supported by the sample comments. Mark it NOT notable when:
- the swing simply mirrors what a video was about (a video on topic X naturally brings comments about X) and the reaction itself says nothing new;
- the theme is generic or vague (thanks, appreciation, general praise with no specific point);
- the sample comments don't actually support a coherent point.
A swing driven by one video CAN be notable when the audience's reaction is itself the news (e.g. complaints about pricing piling up under the latest video).

If notable, write "insight": ONE sentence, at most 30 words, addressed to the creator ("your"), specific. It MUST contain the candidate's "must_state_figure" exactly as given (e.g. "367%") with its direction (up/down), and, when "main_video" is set, that video's title. Say what people are actually saying, but only what the sample comments clearly show. The windows are ${candidates[0].window.windowDays} days, so say "over the last ${candidates[0].window.windowDays} days" — never "this week" or "today". No hype, no advice, no quotes of commenters' words.
Always give a short "reason" for your decision.

Respond with ONLY a JSON array, one item per candidate, no markdown: [{"theme": "...", "notable": true, "reason": "...", "insight": "..."}] (insight null when not notable).

Candidates:
${JSON.stringify(payload, null, 1)}`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  let response: Response
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) throw new Error(`Anthropic API error: ${response.status}`)
  const data = await response.json()
  const text: string = data.content?.[0]?.text ?? ''
  const match = text.match(/\[[\s\S]*\]/)
  if (!match) throw new Error('No JSON array in the insight judgement')
  const parsed = JSON.parse(match[0]) as Array<Record<string, unknown>>

  const byTheme = new Map(candidates.map(c => [c.theme, c]))
  const out: InsightJudgement[] = []
  for (const item of parsed) {
    const theme = typeof item.theme === 'string' ? item.theme : ''
    const candidate = byTheme.get(theme)
    if (!candidate || out.some(o => o.theme === theme)) continue
    const notable = item.notable === true
    const reason = typeof item.reason === 'string' ? item.reason : ''
    if (!notable) {
      out.push({ theme, notable: false, reason, insight: null })
      continue
    }
    const sentence = typeof item.insight === 'string' ? item.insight.trim() : ''
    // Claude decides WHETHER it is notable; the figure must be the real one. A
    // sentence missing it (or unusable) is replaced by a factual template.
    const usable = sentence.length >= 20 && sentence.length <= 280 && sentence.includes(requiredFigure(candidate))
    out.push({
      theme,
      notable: true,
      reason,
      insight: usable ? sentence : templateInsight(candidate, postTitles),
      insightSource: usable ? 'ai' : 'template',
    })
  }
  return out
}

let surfacedTableAvailable = true
/** False once the database rejects surfaced_insights.outcome (migration 44 not run). */
let outcomeColumnAvailable = true

type SurfacedRow = { creator_id: string; theme: string; trend_pct: number; surfaced_at: string; outcome: 'notified' | 'rejected' }

/**
 * Inserts verdict rows. `outcome` is written when migration 44 has added the column;
 * without it the rows still go in (suppression only needs theme + time), so the 7-day
 * cooldown works either way.
 */
async function recordVerdicts(supabase: SupabaseClient, rows: SurfacedRow[]) {
  const attempt = () =>
    supabase
      .from('surfaced_insights')
      .insert(
        outcomeColumnAvailable
          ? rows
          : rows.map(r => ({ creator_id: r.creator_id, theme: r.theme, trend_pct: r.trend_pct, surfaced_at: r.surfaced_at }))
      )
      .select('id, theme')
  let result = await attempt()
  if (result.error && outcomeColumnAvailable && (result.error.code === 'PGRST204' || result.error.code === '42703') && /outcome/.test(result.error.message ?? '')) {
    outcomeColumnAvailable = false
    logWarn('insightAgent', 'surfaced_insights.outcome missing (migration 44 not applied); recording verdicts without it', {})
    result = await attempt()
  }
  return result
}

async function loadRecentlySurfaced(supabase: SupabaseClient, creatorId: string, now: Date): Promise<Set<string> | null> {
  const since = new Date(now.getTime() - INSIGHT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('surfaced_insights')
    .select('theme')
    .eq('creator_id', creatorId)
    .gte('surfaced_at', since)
  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') {
      surfacedTableAvailable = false
      logWarn('insightAgent', 'surfaced_insights missing (migration 43 not applied); Insight Agent disabled', {})
      return null
    }
    throw new Error(`Could not read surfaced_insights: ${error.message}`)
  }
  return new Set((data ?? []).map(r => r.theme as string))
}

export type InsightAgentReport = {
  skipped?: string
  filtered: FilteredOut[]
  candidates: string[]
  judgements: InsightJudgement[]
  surfaced: Array<{ theme: string; notification_id: string; message: string }>
  /** Themes judged not notable and recorded, so they're skipped for 7 days. */
  rejectedRecorded: string[]
  errors: string[]
}

/** Steps 1–3 for one creator. Never throws. `judge` is injectable for tests. */
export async function runInsightAgent(
  supabase: SupabaseClient,
  creatorId: string,
  insights: AudienceInsight[],
  windows: Map<string, TrendWindow>,
  now: Date = new Date(),
  deps: { judge?: (input: JudgeInput) => Promise<InsightJudgement[]> } = {}
): Promise<InsightAgentReport> {
  const report: InsightAgentReport = { filtered: [], candidates: [], judgements: [], surfaced: [], rejectedRecorded: [], errors: [] }
  try {
    if (!surfacedTableAvailable) return { ...report, skipped: 'migration 43 not applied' }
    const recentlySurfaced = await loadRecentlySurfaced(supabase, creatorId, now)
    if (!recentlySurfaced) return { ...report, skipped: 'migration 43 not applied' }

    const { candidates, filtered } = selectInsightCandidates(insights, windows, recentlySurfaced)
    report.filtered = filtered
    report.candidates = candidates.map(c => c.theme)
    if (candidates.length === 0) return report

    const postIds = [...new Set(candidates.flatMap(c => c.window.recentByPost.map(v => v.post_id)))]
    const { data: posts } = await supabase.from('posts').select('id, title').in('id', postIds)
    const postTitles = new Map((posts ?? []).map(p => [p.id as string, (p.title as string) || 'Untitled video']))

    report.judgements = await (deps.judge ?? judgeInsightCandidates)({ candidates, postTitles })

    for (const j of report.judgements.filter(x => x.notable && x.insight)) {
      const candidate = candidates.find(c => c.theme === j.theme)!
      // Claim first, so a crash between the two writes can't lead to a repeat
      // notification; if notifying then fails, release the claim.
      const { data: claimed, error: claimError } = await recordVerdicts(supabase, [
        { creator_id: creatorId, theme: j.theme, trend_pct: candidate.trendPct, surfaced_at: now.toISOString(), outcome: 'notified' },
      ])
      const claim = claimed?.[0]
      if (claimError || !claim) {
        report.errors.push(`claim ${j.theme}: ${claimError?.message ?? 'no row'}`)
        continue
      }
      const { data: note, error: noteError } = await supabase
        .from('notifications')
        .insert({ creator_id: creatorId, comment_id: null, type: 'insight', message: j.insight, read: false })
        .select('id')
        .single()
      if (noteError || !note) {
        await supabase.from('surfaced_insights').delete().eq('id', claim.id)
        report.errors.push(`notify ${j.theme}: ${noteError?.message ?? 'no row'}`)
        continue
      }
      report.surfaced.push({ theme: j.theme, notification_id: note.id as string, message: j.insight! })
    }

    // Rejections get the same 7-day cooldown, so the same unremarkable swing isn't
    // sent back to Claude every day.
    const rejected = report.judgements.filter(x => !x.notable)
    if (rejected.length > 0) {
      const { data, error } = await recordVerdicts(
        supabase,
        rejected.map(j => ({
          creator_id: creatorId,
          theme: j.theme,
          trend_pct: candidates.find(c => c.theme === j.theme)!.trendPct,
          surfaced_at: now.toISOString(),
          outcome: 'rejected' as const,
        }))
      )
      if (error) report.errors.push(`record rejections: ${error.message}`)
      else report.rejectedRecorded = (data ?? []).map(r => r.theme as string)
    }

    logInfo('insightAgent', 'Insight Agent run', {
      creator_id: creatorId,
      candidates: report.candidates,
      notable: report.judgements.filter(j => j.notable).map(j => j.theme),
      surfaced: report.surfaced.length,
      rejected_recorded: report.rejectedRecorded,
    })
  } catch (err) {
    logError('insightAgent', err, { creator_id: creatorId })
    report.errors.push(err instanceof Error ? err.message : String(err))
  }
  return report
}
