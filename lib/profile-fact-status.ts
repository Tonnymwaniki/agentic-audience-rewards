import type { SupabaseClient } from '@supabase/supabase-js'
import type { BusinessProfile } from '@/lib/categorize'
import type { CustomProfileField } from '@/lib/custom-profile-fields'
import { FIXED_PROFILE_FIELDS } from '@/lib/knowledge-gaps'
import { INSIGHT_COOLDOWN_DAYS } from '@/lib/insight-agent'
import { cosine } from '@/lib/knowledge-embeddings'
import { logError, logInfo, logWarn } from '@/lib/logger'

/**
 * Confidence states for Business Profile facts (migration 46):
 *   STALE        — not set or reconfirmed for STALE_AFTER_DAYS.
 *   CONTRADICTED — recent comments from several people consistently say something
 *                  different from the stored value (runContradictionAgent, daily).
 * A contradiction is tied to the value it was about: editing the field ends it, and
 * "Yes, still accurate" clears it. While it stands, drafted replies get the field as
 * UNCERTAIN instead of as a verified fact, and Research is told the same.
 */

export const STALE_AFTER_DAYS = 90
export const CONTRADICTION_WINDOW_DAYS = 14
/** A field needs at least this many recent comments related to it to be checked. */
export const CONTRADICTION_MIN_RELATED = 5
/** ...and a contradiction must be supported by at least this many different people. */
export const CONTRADICTION_MIN_PEOPLE = 3
/**
 * Cosine similarity (voyage-4, document vs document) above which a comment counts as
 * about a field. Measured 2026-09-26 against "Business hours: Monday to Saturday, 8am
 * to 8pm.": comments about hours — agreeing or contradicting — scored 0.52–0.74;
 * unrelated ones (recipes, prices, delivery) 0.26–0.47.
 */
export const RELATED_MIN_SIMILARITY = 0.5
const MAX_RELATED = 15
const MODEL = 'claude-haiku-4-5-20251001'
const DAY = 24 * 60 * 60 * 1000

export type FactSource = 'fixed' | 'custom'
export const factKey = (source: FactSource | string, fieldKey: string) => `${source}:${fieldKey}`

export type FactStatusRow = {
  source: FactSource
  field_key: string
  confirmed_at: string
  contradicted_at: string | null
  contradicted_value: string | null
  contradiction_summary: string | null
  contradiction_example: string | null
}

export type FactState =
  | { state: 'ok'; confirmedAt: string | null; ageDays: number | null }
  | { state: 'stale'; confirmedAt: string; ageDays: number }
  | { state: 'contradicted'; confirmedAt: string; ageDays: number; summary: string; example: string | null; since: string }

let statusTableAvailable = true
const missingTable = (code?: string) => code === 'PGRST205' || code === '42P01'

/** This creator's status rows, keyed by factKey. Empty if migration 46 isn't applied. */
export async function loadFactStatuses(supabase: SupabaseClient, creatorId: string): Promise<Map<string, FactStatusRow>> {
  if (!statusTableAvailable) return new Map()
  const { data, error } = await supabase
    .from('profile_fact_status')
    .select('source, field_key, confirmed_at, contradicted_at, contradicted_value, contradiction_summary, contradiction_example')
    .eq('creator_id', creatorId)
  if (error) {
    if (missingTable(error.code)) statusTableAvailable = false
    else logWarn('profileFactStatus.load', error.message, { creator_id: creatorId })
    return new Map()
  }
  return new Map((data ?? []).map(r => [factKey(r.source as string, r.field_key as string), r as FactStatusRow]))
}

/** Pure: the state of one field given its row and CURRENT value. */
export function factState(row: FactStatusRow | undefined, currentValue: string | null, now = Date.now()): FactState {
  if (!row) return { state: 'ok', confirmedAt: null, ageDays: null }
  const ageDays = Math.floor((now - Date.parse(row.confirmed_at)) / DAY)
  // Only a contradiction of the value that is stored NOW counts.
  if (row.contradicted_at && currentValue !== null && row.contradicted_value === currentValue) {
    return { state: 'contradicted', confirmedAt: row.confirmed_at, ageDays, summary: row.contradiction_summary ?? '', example: row.contradiction_example, since: row.contradicted_at }
  }
  if (ageDays >= STALE_AFTER_DAYS) return { state: 'stale', confirmedAt: row.confirmed_at, ageDays }
  return { state: 'ok', confirmedAt: row.confirmed_at, ageDays }
}

/** "4 months ago", "3 weeks ago" — for the reconfirm prompt. */
export function describeAge(days: number): string {
  if (days >= 60) return `${Math.floor(days / 30)} months ago`
  if (days >= 14) return `${Math.floor(days / 7)} weeks ago`
  return `${days} day${days === 1 ? '' : 's'} ago`
}

export type ProfileFact = { source: FactSource; field_key: string; label: string; value: string }

/** Every filled-in profile field, fixed and custom. */
export async function loadProfileFacts(supabase: SupabaseClient, creatorId: string): Promise<ProfileFact[]> {
  const [{ data: creator }, { data: custom }] = await Promise.all([
    supabase.from('creators').select(FIXED_PROFILE_FIELDS.map(f => f.column).join(', ')).eq('id', creatorId).maybeSingle(),
    supabase.from('custom_profile_fields').select('field_key, field_label, field_value').eq('creator_id', creatorId),
  ])
  const facts: ProfileFact[] = []
  for (const f of FIXED_PROFILE_FIELDS) {
    const v = ((creator as Record<string, string | null> | null)?.[f.column] ?? '').trim()
    if (v) facts.push({ source: 'fixed', field_key: f.column, label: f.label, value: v })
  }
  for (const f of custom ?? []) {
    const v = ((f.field_value as string | null) ?? '').trim()
    if (v) facts.push({ source: 'custom', field_key: f.field_key as string, label: f.field_label as string, value: v })
  }
  return facts
}

/** Starts the clock for filled-in fields that have no status row yet. */
export async function ensureFactStatusRows(supabase: SupabaseClient, creatorId: string, facts: ProfileFact[]) {
  if (!statusTableAvailable || facts.length === 0) return
  const { error } = await supabase
    .from('profile_fact_status')
    .upsert(facts.map(f => ({ creator_id: creatorId, source: f.source, field_key: f.field_key })), { onConflict: 'creator_id,source,field_key', ignoreDuplicates: true })
  if (error && missingTable(error.code)) statusTableAvailable = false
}

const CLEARED = { contradicted_at: null, contradicted_value: null, contradiction_summary: null, contradiction_example: null, contradiction_comment_ids: null }

/** "Yes, still accurate": refresh the timestamp and clear any contradiction. */
export async function reconfirmFact(supabase: SupabaseClient, creatorId: string, source: FactSource, fieldKey: string) {
  return supabase
    .from('profile_fact_status')
    .upsert({ creator_id: creatorId, source, field_key: fieldKey, confirmed_at: new Date().toISOString(), ...CLEARED }, { onConflict: 'creator_id,source,field_key' })
    .select('confirmed_at')
    .single()
}

/**
 * After a profile save: a field whose value CHANGED is freshly confirmed (and any
 * contradiction of the old value ends); a field that was cleared loses its row.
 * Unchanged fields keep their existing timestamp — saving the form isn't
 * reconfirming every field on it.
 */
export async function recordProfileEdits(
  supabase: SupabaseClient,
  creatorId: string,
  before: Map<string, string>,
  after: Map<string, string>
) {
  if (!statusTableAvailable) return
  const now = new Date().toISOString()
  const changed = [...after].filter(([k, v]) => before.get(k) !== v)
  const cleared = [...before.keys()].filter(k => !after.has(k))
  if (changed.length) {
    await supabase.from('profile_fact_status').upsert(
      changed.map(([k]) => {
        const [source, ...rest] = k.split(':')
        return { creator_id: creatorId, source, field_key: rest.join(':'), confirmed_at: now, ...CLEARED }
      }),
      { onConflict: 'creator_id,source,field_key' }
    )
  }
  for (const k of cleared) {
    const [source, ...rest] = k.split(':')
    await supabase.from('profile_fact_status').delete().eq('creator_id', creatorId).eq('source', source).eq('field_key', rest.join(':'))
  }
}

/** The filled-in values as factKey -> value, for recordProfileEdits. */
export async function snapshotProfileValues(supabase: SupabaseClient, creatorId: string): Promise<Map<string, string>> {
  return new Map((await loadProfileFacts(supabase, creatorId)).map(f => [factKey(f.source, f.field_key), f.value]))
}

/**
 * What drafted replies may state. A CONTRADICTED field is removed from the verified
 * facts and returned separately as uncertain, with what customers report, so the
 * draft doesn't assert a value customers are disputing. Stale fields stay verified —
 * old isn't the same as wrong.
 */
export function applyFactStatusesForDrafts(
  profile: BusinessProfile | null,
  customFields: CustomProfileField[],
  statuses: Map<string, FactStatusRow>,
  now = Date.now()
): { profile: BusinessProfile | null; customFields: CustomProfileField[]; uncertain: string[] } {
  const uncertain: string[] = []
  let adjusted = profile
  if (profile) {
    adjusted = { ...profile }
    for (const f of FIXED_PROFILE_FIELDS) {
      const value = (profile as Record<string, string | null>)[f.column]
      const s = factState(statuses.get(factKey('fixed', f.column)), value?.trim() || null, now)
      if (s.state === 'contradicted') {
        ;(adjusted as Record<string, string | null>)[f.column] = null
        uncertain.push(`${f.label}: "${value}" (customers recently report: ${s.summary})`)
      }
    }
  }
  const keep: CustomProfileField[] = []
  for (const f of customFields) {
    const s = factState(statuses.get(factKey('custom', f.fieldKey)), f.fieldValue?.trim() || null, now)
    if (s.state === 'contradicted') uncertain.push(`${f.fieldLabel}: "${f.fieldValue}" (customers recently report: ${s.summary})`)
    else keep.push(f)
  }
  return { profile: adjusted, customFields: keep, uncertain }
}

// ---------------------------------------------------------------------------
// CONTRADICTED detection — the daily job's contradiction pass.
// ---------------------------------------------------------------------------

export type RelatedComment = { id: string; text: string; audience_member_id: string | null; similarity: number }

export type ContradictionVerdict = {
  genuine: boolean
  whatCustomersSay: string
  supportingIds: string[]
  exampleId: string | null
  reason: string
}

/** One Claude call for one field: a real contradiction, or noise? */
export async function judgeContradiction(fact: ProfileFact, comments: RelatedComment[]): Promise<ContradictionVerdict> {
  const ids = comments.map((_, i) => `c${i + 1}`)
  const prompt = `A small business's profile states this about itself:
${fact.label}: "${fact.value}"

Recent comments from customers that relate to this (each tagged with an id and an anonymous person id):
${comments.map((c, i) => `${ids[i]} [person ${c.audience_member_id?.slice(0, 6) ?? '?'}]: ${c.text.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')}

Decide whether customers, TAKEN TOGETHER, genuinely indicate the profile statement is wrong or out of date — several different people independently reporting the same different reality (e.g. the profile says "open until 8pm" and several people say they found it closed at 6pm).
NOT a genuine contradiction:
- one person's bad experience, confusion or one-off complaint, however angry;
- questions (asking about something is not stating it's different);
- opinions or preferences ("8pm is too early") that don't dispute the fact;
- comments that agree with the profile.

Respond with ONLY JSON, no markdown:
{"genuine": true, "what_customers_say": "one short phrase describing what they report instead", "supporting": ["c1", "c3"], "example": "c3", "reason": "..."}
"supporting" = only the comments that actually contradict the profile; "example" = the clearest one. If not genuine, "genuine": false with supporting [] and a reason.`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  let response: Response
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, messages: [{ role: 'user', content: prompt }] }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) throw new Error(`Anthropic API error: ${response.status}`)
  const data = await response.json()
  const match = String(data.content?.[0]?.text ?? '').match(/\{[\s\S]*\}/)
  if (!match) throw new Error('No JSON object in the contradiction judgement')
  const p = JSON.parse(match[0]) as Record<string, unknown>
  const byId = new Map(ids.map((id, i) => [id, comments[i].id]))
  const supportingIds = (Array.isArray(p.supporting) ? p.supporting : []).map(x => byId.get(String(x))).filter((x): x is string => Boolean(x))
  return {
    genuine: p.genuine === true,
    whatCustomersSay: typeof p.what_customers_say === 'string' ? p.what_customers_say.trim().slice(0, 200) : '',
    supportingIds,
    exampleId: byId.get(String(p.example)) ?? supportingIds[0] ?? null,
    reason: typeof p.reason === 'string' ? p.reason : '',
  }
}

export type ContradictionReport = {
  skipped?: string
  checked: Array<{ field: string; related: number }>
  tooFewRelated: string[]
  cooldown: string[]
  alreadyContradicted: string[]
  verdicts: Array<{ field: string; genuine: boolean; people: number; accepted: boolean; whatCustomersSay: string; reason: string }>
  flagged: Array<{ field: string; notification_id: string; message: string }>
  errors: string[]
}

const parseVector = (v: unknown): number[] => (typeof v === 'string' ? JSON.parse(v) : (v as number[]))

/** The daily contradiction pass for one creator. Never throws; `judge` is injectable. */
export async function runContradictionAgent(
  supabase: SupabaseClient,
  creatorId: string,
  now: Date = new Date(),
  deps: { judge?: typeof judgeContradiction } = {}
): Promise<ContradictionReport> {
  const report: ContradictionReport = { checked: [], tooFewRelated: [], cooldown: [], alreadyContradicted: [], verdicts: [], flagged: [], errors: [] }
  try {
    const facts = await loadProfileFacts(supabase, creatorId)
    if (facts.length === 0) return report
    await ensureFactStatusRows(supabase, creatorId, facts)
    if (!statusTableAvailable) return { ...report, skipped: 'migration 46 not applied' }
    const statuses = await loadFactStatuses(supabase, creatorId)

    const { data: factEmb, error: embError } = await supabase.from('profile_fact_embeddings').select('source, field_key, content, embedding').eq('creator_id', creatorId)
    if (embError) return { ...report, skipped: missingTable(embError.code) ? 'migration 45 not applied' : embError.message }

    // Recent comments that have embeddings.
    const { data: posts } = await supabase.from('posts').select('id').eq('creator_id', creatorId)
    const since = new Date(now.getTime() - CONTRADICTION_WINDOW_DAYS * DAY).toISOString()
    const comments: Array<{ id: string; text: string; audience_member_id: string | null; embedding: number[] }> = []
    const postIds = (posts ?? []).map(p => p.id as string)
    for (let i = 0; i < postIds.length; i += 100) {
      const { data } = await supabase
        .from('comments')
        .select('id, text, audience_member_id, embedding')
        .in('post_id', postIds.slice(i, i + 100))
        .gte('posted_at', since)
        .lte('posted_at', now.toISOString())
        .not('embedding', 'is', null)
      for (const c of data ?? []) comments.push({ id: c.id as string, text: c.text as string, audience_member_id: c.audience_member_id as string | null, embedding: parseVector(c.embedding) })
    }
    if (comments.length === 0) return report

    const cooldownSince = new Date(now.getTime() - INSIGHT_COOLDOWN_DAYS * DAY).toISOString()
    const { data: recent } = await supabase
      .from('surfaced_insights')
      .select('theme')
      .eq('creator_id', creatorId)
      .like('theme', 'contradiction:%')
      .gte('surfaced_at', cooldownSince)
    const inCooldown = new Set((recent ?? []).map(r => r.theme as string))

    for (const fact of facts) {
      const key = factKey(fact.source, fact.field_key)
      const theme = `contradiction:${key}`
      if (factState(statuses.get(key), fact.value, now.getTime()).state === 'contradicted') { report.alreadyContradicted.push(fact.label); continue }
      if (inCooldown.has(theme)) { report.cooldown.push(fact.label); continue }
      const emb = (factEmb ?? []).find(f => f.source === fact.source && f.field_key === fact.field_key && f.content === `${fact.label}: ${fact.value}`)
      if (!emb) continue // not embedded yet (or embedded for an older value) — next run
      const fv = parseVector(emb.embedding)
      const related = comments
        .map(c => ({ id: c.id, text: c.text, audience_member_id: c.audience_member_id, similarity: cosine(fv, c.embedding) }))
        .filter(c => c.similarity >= RELATED_MIN_SIMILARITY)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, MAX_RELATED)
      report.checked.push({ field: fact.label, related: related.length })
      if (related.length < CONTRADICTION_MIN_RELATED) { report.tooFewRelated.push(fact.label); continue }

      const v = await (deps.judge ?? judgeContradiction)(fact, related)
      const supporters = related.filter(c => v.supportingIds.includes(c.id))
      const people = new Set(supporters.map(c => c.audience_member_id ?? c.id)).size
      // The AI's "genuine" is necessary but not sufficient: it must also rest on
      // several different people, not one person posting repeatedly.
      const accepted = v.genuine && people >= CONTRADICTION_MIN_PEOPLE && Boolean(v.whatCustomersSay)
      report.verdicts.push({ field: fact.label, genuine: v.genuine, people, accepted, whatCustomersSay: v.whatCustomersSay, reason: v.reason })

      const { data: claim, error: claimError } = await supabase
        .from('surfaced_insights')
        .insert({ creator_id: creatorId, theme, trend_pct: null, surfaced_at: now.toISOString(), outcome: accepted ? 'notified' : 'rejected' })
        .select('id')
        .single()
      if (claimError || !claim) { report.errors.push(`record ${fact.label}: ${claimError?.message}`); continue }
      if (!accepted) continue

      const example = related.find(c => c.id === v.exampleId)?.text.replace(/\s+/g, ' ').trim().slice(0, 200) ?? null
      const { error: statusError } = await supabase.from('profile_fact_status').upsert(
        {
          creator_id: creatorId,
          source: fact.source,
          field_key: fact.field_key,
          contradicted_at: now.toISOString(),
          contradicted_value: fact.value,
          contradiction_summary: v.whatCustomersSay,
          contradiction_example: example,
          contradiction_comment_ids: v.supportingIds,
        },
        { onConflict: 'creator_id,source,field_key' }
      )
      if (statusError) {
        await supabase.from('surfaced_insights').delete().eq('id', claim.id)
        report.errors.push(`status ${fact.label}: ${statusError.message}`)
        continue
      }
      const message = `Customers are saying something different from what your profile states for ${fact.label} — please review. Your profile says "${fact.value.slice(0, 120).replace(/[.\s]+$/, '')}"${example ? `; for example, a customer wrote "${example.slice(0, 140).replace(/[.\s]+$/, '')}"` : ''}.`
      const { data: note, error: noteError } = await supabase
        .from('notifications')
        .insert({ creator_id: creatorId, comment_id: null, type: 'profile_contradiction', message, read: false })
        .select('id')
        .single()
      if (noteError || !note) { report.errors.push(`notify ${fact.label}: ${noteError?.message}`); continue }
      report.flagged.push({ field: fact.label, notification_id: note.id as string, message })
    }

    logInfo('profileFactStatus.contradictions', 'Contradiction pass', {
      creator_id: creatorId,
      checked: report.checked,
      verdicts: report.verdicts.map(v => `${v.field}:${v.accepted ? 'flagged' : 'rejected'}`),
    })
  } catch (err) {
    logError('profileFactStatus.contradictions', err, { creator_id: creatorId })
    report.errors.push(err instanceof Error ? err.message : String(err))
  }
  return report
}
