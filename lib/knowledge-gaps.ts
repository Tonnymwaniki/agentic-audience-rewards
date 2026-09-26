import type { SupabaseClient } from '@supabase/supabase-js'
import { themesForRow } from '@/lib/audience-insights'
import { KEY_PATTERN, MAX_CUSTOM_FIELDS, RESERVED_KEYS, sanitize } from '@/lib/custom-profile-fields'
import { INSIGHT_COOLDOWN_DAYS } from '@/lib/insight-agent'
import { logError, logInfo, logWarn } from '@/lib/logger'

/**
 * Knowledge-gap detection — the Insight Agent's second daily pass.
 *
 * Finds questions the audience keeps asking that the creator's Business Profile
 * can't answer yet, and offers to add a field for them:
 *   1. Recent 'question' AND 'purchase_intent' comments (last GAP_WINDOW_DAYS)
 *      grouped by theme, using the same theme logic as audience insights. A theme
 *      needs GAP_MIN_QUESTIONS. purchase_intent is included because the business
 *      questions a profile field answers best — price, how to order, delivery cost —
 *      are categorized as purchase_intent, not question (lib/categorize.ts).
 *   2. One Claude call per creator decides, for each cluster, whether an EXISTING
 *      field already covers it — the six fixed fields and every custom field — or
 *      whether it isn't profile material at all (e.g. questions about a video's
 *      content). Only a genuine gap gets a proposed field.
 *   3. For a gap (at most GAP_MAX_NEW_FIELDS_PER_DAY per creator per day): an empty
 *      custom_profile_fields row, the same shape the original generation writes, and
 *      a notification linking to the profile page.
 * Every verdict is recorded in surfaced_insights as "gap:<theme>" (notified or
 * rejected), so a cluster isn't re-judged or re-notified for 7 days — the same
 * cooldown as trend insights.
 */

export const GAP_WINDOW_DAYS = 14
export const GAP_MIN_QUESTIONS = 5
/** Comment categories scanned for recurring questions. */
export const GAP_CATEGORIES = ['question', 'purchase_intent']
export const GAP_MAX_NEW_FIELDS_PER_DAY = 2
/** Clusters sent to Claude per run, busiest first. */
const GAP_MAX_CLUSTERS_JUDGED = 6
/**
 * Custom fields a creator can end up with once gap suggestions are added. The
 * original generation stops at MAX_CUSTOM_FIELDS (5); gaps may add up to three
 * more, and never beyond this, so the profile page can't fill up indefinitely.
 */
export const GAP_MAX_TOTAL_CUSTOM_FIELDS = MAX_CUSTOM_FIELDS + 3
const MODEL = 'claude-haiku-4-5-20251001'
const DAY = 24 * 60 * 60 * 1000

export const FIXED_PROFILE_FIELDS = [
  { column: 'business_phone', label: 'Phone number' },
  { column: 'business_whatsapp', label: 'WhatsApp number' },
  { column: 'business_location', label: 'Location / address' },
  { column: 'business_hours', label: 'Business hours' },
  { column: 'business_website', label: 'Website or social link' },
  { column: 'delivery_info', label: 'Delivery information' },
] as const

export type QuestionCluster = {
  theme: string
  questions: number
  /** Distinct people asking — what the notification quotes. */
  people: number
  samples: string[]
}

type QuestionRow = { text: string; audience_member_id: string | null; topic: string | null; topics: string[] | null }

/** Pure: group recent questions by theme and keep the ones with enough volume. */
export function clusterQuestions(rows: QuestionRow[]): QuestionCluster[] {
  const byTheme = new Map<string, QuestionRow[]>()
  for (const r of rows) for (const theme of themesForRow(r)) byTheme.set(theme, [...(byTheme.get(theme) ?? []), r])
  return [...byTheme]
    .filter(([, rs]) => rs.length >= GAP_MIN_QUESTIONS)
    .map(([theme, rs]) => ({
      theme,
      questions: rs.length,
      people: new Set(rs.map(r => r.audience_member_id ?? r.text)).size,
      samples: [...new Set(rs.map(r => r.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)))].slice(0, 8),
    }))
    .sort((a, b) => b.questions - a.questions || a.theme.localeCompare(b.theme))
}

export type GapVerdict = {
  theme: string
  verdict: 'covered' | 'gap' | 'not_profile_info'
  coveredBy: string | null
  fieldKey: string | null
  fieldLabel: string | null
  /** Completes "N people have asked about ___" in the notification. */
  askedAbout: string | null
  reason: string
}

export type ExistingFields = {
  fixed: Array<{ label: string; value: string | null }>
  custom: Array<{ key: string; label: string; value: string | null }>
}

/** One Claude call: is each cluster covered, not profile material, or a real gap? */
export async function judgeQuestionClusters(clusters: QuestionCluster[], existing: ExistingFields): Promise<GapVerdict[]> {
  // Values are shown whole up to 300 characters; a longer one is marked as
  // shortened by us, so it isn't mistaken for an incomplete answer. (An 80-char cut
  // once made Claude call complete values "cut off mid-sentence".)
  const show = (v: string | null) => (v ? `: "${v.length > 300 ? `${v.slice(0, 300)}…" [shortened here]` : `${v}"`}` : ' (empty)')
  const fieldLines = [...existing.fixed, ...existing.custom].map(f => `- ${f.label}${show(f.value)}`)
  const prompt = `A creator runs a small business and keeps a Business Profile — short factual fields their drafted replies use to answer customers. These fields ALREADY exist (value shown, or "(empty)" if not filled in yet):
${fieldLines.join('\n')}

Their audience has recently asked many questions, grouped by theme below with sample questions. For EACH cluster decide:
- "covered": an existing field above already answers this kind of question (even if it's still empty — the fix is to fill it in, not to add another field). Give "covered_by" = that field's label exactly.
- "not_profile_info": the questions aren't about the business in a way one short profile fact could answer (e.g. questions about a video's subject, opinions, how-to questions a video should answer).
- "gap": a recurring question about the business that NO existing field answers, and that one short factual answer the creator can type would answer. Propose ONE new field: "field_key" (snake_case, lowercase letters/digits/underscores, e.g. "vegetarian_options") and "field_label" (under 40 characters, natural to a small business owner, e.g. "Vegetarian options"). Ground it in what the questions actually ask — never a generic field. Also give "asked_about": a short phrase that completes "N people have asked about ___" naturally, e.g. "whether you have vegetarian options". Never propose phone, WhatsApp, location/address, hours, website/social, or delivery — those exist.
Give a short "reason" for every verdict.

Copy each cluster's "id" back exactly. Respond with ONLY a JSON array, no markdown: [{"id": "q1", "verdict": "gap", "covered_by": null, "field_key": "...", "field_label": "...", "asked_about": "...", "reason": "..."}]

Clusters:
${JSON.stringify(clusters.map((c, i) => ({ id: `q${i + 1}`, theme: c.theme, questions: c.questions, people: c.people, sample_questions: c.samples })), null, 1)}`

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
  const match = String(data.content?.[0]?.text ?? '').match(/\[[\s\S]*\]/)
  if (!match) throw new Error('No JSON array in the gap judgement')
  const parsed = JSON.parse(match[0]) as Array<Record<string, unknown>>

  // Matched back by the id we assigned, not by the model echoing a theme name — a
  // reworded theme ("halal certification" for "certification") used to be dropped
  // silently, leaving a run that judged nothing and said nothing.
  const byId = new Map(clusters.map((c, i) => [`q${i + 1}`, c.theme]))
  const existingKeys = new Set(existing.custom.map(f => f.key))
  const existingLabels = new Set([...existing.fixed, ...existing.custom].map(f => f.label.toLowerCase().trim()))
  const out: GapVerdict[] = []
  for (const item of parsed) {
    const theme = byId.get(typeof item.id === 'string' ? item.id.trim() : '') ?? ''
    if (!theme || out.some(o => o.theme === theme)) continue
    const reason = typeof item.reason === 'string' ? item.reason : ''
    // Seen in testing: the model writing the KEY name as the value
    // ("verdict": "covered_by"). Its meaning is unambiguous, so it's read as covered —
    // as is any odd verdict that still names the covering field.
    const coveredByName = typeof item.covered_by === 'string' && item.covered_by.trim() ? item.covered_by.trim() : null
    const raw = typeof item.verdict === 'string' ? item.verdict.trim().toLowerCase() : ''
    const verdict: GapVerdict['verdict'] | null =
      raw === 'gap' || raw === 'not_profile_info' ? raw
      : raw === 'covered' || raw === 'covered_by' || (coveredByName && raw !== 'gap') ? 'covered'
      : null
    if (!verdict) continue
    if (verdict !== 'gap') {
      out.push({ theme, verdict, coveredBy: coveredByName, fieldKey: null, fieldLabel: null, askedAbout: null, reason })
      continue
    }
    // The proposed field must pass the SAME rules as generated fields, and must not
    // duplicate one the creator already has — if it does, the cluster is covered.
    const [field] = sanitize([{ field_key: item.field_key, field_label: item.field_label, reason }])
    if (!field) {
      out.push({ theme, verdict: 'not_profile_info', coveredBy: null, fieldKey: null, fieldLabel: null, askedAbout: null, reason: `proposed field was invalid or reserved (${String(item.field_key)}); ${reason}` })
      continue
    }
    if (existingKeys.has(field.field_key) || existingLabels.has(field.field_label.toLowerCase())) {
      out.push({ theme, verdict: 'covered', coveredBy: field.field_label, fieldKey: null, fieldLabel: null, askedAbout: null, reason: `proposed field already exists; ${reason}` })
      continue
    }
    const asked = typeof item.asked_about === 'string' ? item.asked_about.trim().replace(/[.?!]+$/, '') : ''
    out.push({
      theme,
      verdict: 'gap',
      coveredBy: null,
      fieldKey: field.field_key,
      fieldLabel: field.field_label,
      askedAbout: asked.length >= 3 && asked.length <= 80 ? asked : null,
      reason,
    })
  }
  if (out.length === 0) throw new Error(`Gap judgement returned no usable verdicts for ${clusters.length} clusters`)
  return out
}

export type GapReport = {
  skipped?: string
  clusters: Array<{ theme: string; questions: number; people: number }>
  cooldown: string[]
  judged: GapVerdict[]
  created: Array<{ theme: string; field_key: string; field_label: string; notification_id: string; message: string }>
  deferred: string[]
  errors: string[]
}

/** Every step for one creator. Never throws. `judge` is injectable for tests. */
export async function runKnowledgeGapAgent(
  supabase: SupabaseClient,
  creatorId: string,
  now: Date = new Date(),
  deps: { judge?: typeof judgeQuestionClusters } = {}
): Promise<GapReport> {
  const report: GapReport = { clusters: [], cooldown: [], judged: [], created: [], deferred: [], errors: [] }
  try {
    // --- 1. recent question clusters
    const since = new Date(now.getTime() - GAP_WINDOW_DAYS * DAY).toISOString()
    const { data: posts } = await supabase.from('posts').select('id').eq('creator_id', creatorId)
    const postIds = (posts ?? []).map(p => p.id as string)
    if (postIds.length === 0) return report
    const { data: qrows, error: qError } = await supabase
      .from('comments')
      .select('text, audience_member_id, comment_categories!inner(category, topic, topics)')
      .in('post_id', postIds)
      .in('comment_categories.category', GAP_CATEGORIES)
      .gte('posted_at', since)
      .lte('posted_at', now.toISOString())
    if (qError) throw new Error(`Could not load questions: ${qError.message}`)
    const rows: QuestionRow[] = (qrows ?? []).map(r => {
      const cat = r.comment_categories as unknown as { topic: string | null; topics: string[] | null }
      return { text: r.text as string, audience_member_id: r.audience_member_id as string | null, topic: cat?.topic ?? null, topics: cat?.topics ?? null }
    })
    const allClusters = clusterQuestions(rows)
    report.clusters = allClusters.map(c => ({ theme: c.theme, questions: c.questions, people: c.people }))
    if (allClusters.length === 0) return report

    // --- cooldown: anything judged in the last 7 days (either verdict)
    const cooldownSince = new Date(now.getTime() - INSIGHT_COOLDOWN_DAYS * DAY).toISOString()
    const { data: recent, error: recentError } = await supabase
      .from('surfaced_insights')
      .select('theme, outcome, surfaced_at')
      .eq('creator_id', creatorId)
      .like('theme', 'gap:%')
      .gte('surfaced_at', cooldownSince)
    if (recentError) {
      if (recentError.code === 'PGRST205' || recentError.code === '42P01' || recentError.code === '42703') return { ...report, skipped: 'migrations 43/44 not applied' }
      throw new Error(`Could not read surfaced_insights: ${recentError.message}`)
    }
    const judgedRecently = new Set((recent ?? []).map(r => (r.theme as string).slice(4)))
    report.cooldown = allClusters.filter(c => judgedRecently.has(c.theme)).map(c => c.theme)
    const clusters = allClusters.filter(c => !judgedRecently.has(c.theme)).slice(0, GAP_MAX_CLUSTERS_JUDGED)
    if (clusters.length === 0) return report

    // --- 2. what already exists, and the judgement
    const [{ data: creator }, { data: custom }] = await Promise.all([
      supabase.from('creators').select(FIXED_PROFILE_FIELDS.map(f => f.column).join(', ')).eq('id', creatorId).maybeSingle(),
      supabase.from('custom_profile_fields').select('field_key, field_label, field_value').eq('creator_id', creatorId),
    ])
    const existing: ExistingFields = {
      fixed: FIXED_PROFILE_FIELDS.map(f => ({ label: f.label, value: ((creator as Record<string, string | null> | null)?.[f.column] ?? null) || null })),
      custom: (custom ?? []).map(f => ({ key: f.field_key as string, label: f.field_label as string, value: (f.field_value as string | null) || null })),
    }
    report.judged = await (deps.judge ?? judgeQuestionClusters)(clusters, existing)
    // A cluster with no usable verdict isn't recorded (so it's retried next run) —
    // but it is reported, never silently lost.
    const unjudged = clusters.filter(c => !report.judged.some(j => j.theme === c.theme)).map(c => c.theme)
    if (unjudged.length) {
      report.errors.push(`no usable verdict for: ${unjudged.join(', ')} (retried next run)`)
      logWarn('knowledgeGaps', 'Clusters left unjudged by the model; retried next run', { creator_id: creatorId, themes: unjudged })
    }

    // --- 3. act, within the daily and total caps
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
    const createdToday = (recent ?? []).filter(r => r.outcome === 'notified' && (r.surfaced_at as string) >= startOfDay).length
    let allowance = Math.min(GAP_MAX_NEW_FIELDS_PER_DAY - createdToday, GAP_MAX_TOTAL_CUSTOM_FIELDS - existing.custom.length)

    const record = (theme: string, outcome: 'notified' | 'rejected') =>
      supabase
        .from('surfaced_insights')
        .insert({ creator_id: creatorId, theme: `gap:${theme}`, trend_pct: null, surfaced_at: now.toISOString(), outcome })
        .select('id')
        .single()

    for (const v of report.judged) {
      if (v.verdict !== 'gap') {
        const { error } = await record(v.theme, 'rejected')
        if (error) report.errors.push(`record ${v.theme}: ${error.message}`)
        continue
      }
      if (allowance <= 0) {
        // Over today's cap: NOT recorded, so it's reconsidered on the next run.
        report.deferred.push(v.theme)
        continue
      }
      const cluster = clusters.find(c => c.theme === v.theme)!
      const { data: claim, error: claimError } = await record(v.theme, 'notified')
      if (claimError || !claim) { report.errors.push(`claim ${v.theme}: ${claimError?.message}`); continue }

      const { data: field, error: fieldError } = await supabase
        .from('custom_profile_fields')
        .insert({ creator_id: creatorId, field_key: v.fieldKey, field_label: v.fieldLabel, field_value: null })
        .select('id')
        .single()
      if (fieldError || !field) {
        await supabase.from('surfaced_insights').delete().eq('id', claim.id)
        report.errors.push(`field ${v.theme}: ${fieldError?.message}`)
        continue
      }
      const topic = v.askedAbout ?? v.fieldLabel!.toLowerCase()
      const message = `${cluster.people} ${cluster.people === 1 ? 'person has' : 'people have'} asked about ${topic} — want to add this to your Business Profile?`
      const { data: note, error: noteError } = await supabase
        .from('notifications')
        .insert({ creator_id: creatorId, comment_id: null, type: 'knowledge_gap', message, read: false })
        .select('id')
        .single()
      if (noteError || !note) {
        await supabase.from('custom_profile_fields').delete().eq('id', field.id)
        await supabase.from('surfaced_insights').delete().eq('id', claim.id)
        report.errors.push(`notify ${v.theme}: ${noteError?.message}`)
        continue
      }
      allowance--
      report.created.push({ theme: v.theme, field_key: v.fieldKey!, field_label: v.fieldLabel!, notification_id: note.id as string, message })
    }

    logInfo('knowledgeGaps', 'Knowledge-gap run', {
      creator_id: creatorId,
      clusters: report.clusters.map(c => c.theme),
      cooldown: report.cooldown,
      verdicts: report.judged.map(j => `${j.theme}:${j.verdict}`),
      created: report.created.map(c => c.field_key),
      deferred: report.deferred,
    })
  } catch (err) {
    logError('knowledgeGaps', err, { creator_id: creatorId })
    report.errors.push(err instanceof Error ? err.message : String(err))
  }
  return report
}

// Re-exported so callers/tests can check a key without importing two modules.
export { KEY_PATTERN, RESERVED_KEYS }
