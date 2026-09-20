import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Per-creator Business Profile fields, proposed by Claude from that creator's real
 * business signals rather than from a fixed list.
 *
 * The fixed columns on `creators` (phone, WhatsApp, location, hours, website,
 * delivery) apply to every business. These are the extras that only make sense for
 * one: "Class schedule" for a tutor, "Wholesale minimum order" for a retailer.
 *
 * Only DEFINITIONS are generated — key and label. Values stay null until the
 * creator types them, because inventing a plausible-looking opening time or price
 * is exactly the failure mode drafted replies must never have.
 */

export type CustomProfileField = {
  id: string
  fieldKey: string
  fieldLabel: string
  fieldValue: string | null
}

/** The brief's cap. Also a UI constraint: more than five buries the fixed fields. */
export const MAX_CUSTOM_FIELDS = 5
const MIN_CUSTOM_FIELDS = 2
const GENERATION_TIMEOUT_MS = 20000
/** Enough signal to ground the suggestions without paying for a huge prompt. */
const MAX_TITLES = 12
const MAX_TOPICS = 12

/** False once the database reports the table missing (migration 20240101000032). */
let tableAvailable = true

function markUnavailable(error: { code?: string; message?: string }): boolean {
  // 42P01 = undefined_table; PGRST205 = PostgREST cannot find it in its schema cache.
  if (error.code === '42P01' || error.code === 'PGRST205') {
    tableAvailable = false
    console.warn('custom_profile_fields does not exist yet (migration 20240101000032); skipping custom fields')
    return true
  }
  return false
}

/** This creator's custom fields, label order, for the profile form and draft prompts. */
export async function loadCustomProfileFields(
  supabase: SupabaseClient,
  creatorId: string
): Promise<CustomProfileField[]> {
  if (!tableAvailable) return []

  const { data, error } = await supabase
    .from('custom_profile_fields')
    .select('id, field_key, field_label, field_value')
    .eq('creator_id', creatorId)
    .order('field_label')

  if (error) {
    if (!markUnavailable(error)) {
      console.error('Custom profile fields fetch error:', error.message)
    }
    return []
  }

  return (data ?? []).map(row => ({
    id: row.id as string,
    fieldKey: row.field_key as string,
    fieldLabel: row.field_label as string,
    fieldValue: (row.field_value as string | null) ?? null,
  }))
}

/**
 * The real signals the suggestions are grounded in.
 *
 * Every one is drawn from stored data. When a creator has no videos yet the model
 * gets the category alone and is told so, rather than being handed invented
 * context to reason from.
 */
type BusinessSignals = {
  category: string
  videoTitles: string[]
  commentCategories: Array<{ category: string; count: number }>
  topics: Array<{ topic: string; count: number }>
}

async function gatherSignals(
  supabase: SupabaseClient,
  creatorId: string,
  category: string
): Promise<BusinessSignals> {
  const signals: BusinessSignals = { category, videoTitles: [], commentCategories: [], topics: [] }

  const { data: posts } = await supabase
    .from('posts')
    .select('id, title')
    .eq('creator_id', creatorId)
    .order('posted_at', { ascending: false })
    .limit(MAX_TITLES)

  const postList = posts ?? []
  signals.videoTitles = postList.map(p => (p.title as string) || '').filter(Boolean)

  const postIds = postList.map(p => p.id as string)
  if (postIds.length === 0) return signals

  const { data: comments } = await supabase
    .from('comments')
    .select('id')
    .in('post_id', postIds)
    .limit(1000)

  const commentIds = (comments ?? []).map(c => c.id as string)
  if (commentIds.length === 0) return signals

  const categoryCounts = new Map<string, number>()
  const topicCounts = new Map<string, number>()

  // Chunked: a single .in() with a thousand ids exceeds the URL length limit.
  for (let i = 0; i < commentIds.length; i += 200) {
    const { data: rows } = await supabase
      .from('comment_categories')
      .select('category, topic, topics')
      .in('comment_id', commentIds.slice(i, i + 200))

    for (const row of rows ?? []) {
      const c = row.category as string | null
      if (c) categoryCounts.set(c, (categoryCounts.get(c) ?? 0) + 1)

      // topics[] since migration 27; topic is the older single value.
      const list = Array.isArray(row.topics) ? (row.topics as string[]) : []
      const all = list.length > 0 ? list : [(row.topic as string | null) ?? '']
      for (const t of all) {
        if (t) topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1)
      }
    }
  }

  const rank = <T extends string>(m: Map<T, number>, limit: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)

  signals.commentCategories = rank(categoryCounts, 6).map(([category, count]) => ({ category, count }))
  signals.topics = rank(topicCounts, MAX_TOPICS).map(([topic, count]) => ({ topic, count }))

  return signals
}

const SUGGEST_TOOL = {
  name: 'suggest_profile_fields',
  description: 'Propose the extra Business Profile fields this specific creator should fill in.',
  input_schema: {
    type: 'object' as const,
    properties: {
      fields: {
        type: 'array',
        minItems: MIN_CUSTOM_FIELDS,
        maxItems: MAX_CUSTOM_FIELDS,
        items: {
          type: 'object',
          properties: {
            field_key: {
              type: 'string',
              description: 'snake_case machine key, e.g. class_schedule. Lowercase letters, digits and underscores only.',
            },
            field_label: {
              type: 'string',
              description: 'Short human label shown to the creator, e.g. "Class schedule". Under 40 characters.',
            },
            reason: {
              type: 'string',
              description: 'Which supplied signal this field is grounded in. One short sentence.',
            },
          },
          required: ['field_key', 'field_label', 'reason'],
        },
      },
    },
    required: ['fields'],
  },
}

function buildPrompt(signals: BusinessSignals): string {
  const lines: string[] = [
    `Business category the creator chose: ${signals.category}`,
  ]

  if (signals.videoTitles.length > 0) {
    lines.push('', 'Their most recent video titles:')
    for (const t of signals.videoTitles) lines.push(`- ${t}`)
  } else {
    lines.push('', 'They have not analyzed any videos yet, so there are no titles or comment data.')
  }

  if (signals.commentCategories.length > 0) {
    lines.push('', 'What their audience comments about, by category:')
    for (const c of signals.commentCategories) lines.push(`- ${c.category}: ${c.count} comments`)
  }

  if (signals.topics.length > 0) {
    lines.push('', 'Most common topics raised in their comments:')
    for (const t of signals.topics) lines.push(`- ${t.topic} (${t.count})`)
  }

  return `A creator runs a business and answers customer comments on their videos. We already store these fields for every business, so DO NOT propose them or anything equivalent:
- phone number
- WhatsApp number
- location / address
- business hours
- website or social link
- delivery information

Propose ${MIN_CUSTOM_FIELDS}-${MAX_CUSTOM_FIELDS} ADDITIONAL fields that are specifically useful for THIS business, so that when a customer asks, the creator's drafted reply can state a real answer.

${lines.join('\n')}

Rules:
- Ground every field in the signals above. If the topics show people asking about pricing tiers, propose a pricing field; do not propose fields for things nobody asks about.
- Each field must hold a short factual answer the creator can type — not an essay, not an opinion.
- Never propose a field that duplicates one of the six we already store.
- If the only signal is the category, propose the ${MIN_CUSTOM_FIELDS}-3 most obviously useful fields for that kind of business and no more.
- Labels must read naturally to a small business owner, not like database columns.`
}

const KEY_PATTERN = /^[a-z][a-z0-9_]{1,48}$/
/** The six fixed columns, in the shapes a model is likely to return them as. */
const RESERVED_KEYS = new Set([
  'business_phone', 'phone', 'phone_number', 'telephone',
  'business_whatsapp', 'whatsapp', 'whatsapp_number',
  'business_location', 'location', 'address', 'business_address',
  'business_hours', 'hours', 'opening_hours', 'working_hours',
  'business_website', 'website', 'site', 'social_links',
  'delivery_info', 'delivery', 'shipping', 'shipping_info',
])

type Suggestion = { field_key: string; field_label: string; reason: string }

/** Drops anything malformed, reserved or duplicated, and enforces the cap. */
function sanitize(raw: unknown): Suggestion[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: Suggestion[] = []

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const key = String((item as Suggestion).field_key ?? '').trim().toLowerCase()
    const label = String((item as Suggestion).field_label ?? '').trim()
    const reason = String((item as Suggestion).reason ?? '').trim()

    if (!KEY_PATTERN.test(key)) continue
    if (RESERVED_KEYS.has(key)) continue
    if (label.length === 0 || label.length > 40) continue
    if (seen.has(key)) continue

    seen.add(key)
    out.push({ field_key: key, field_label: label, reason })
    if (out.length === MAX_CUSTOM_FIELDS) break
  }

  return out
}

/**
 * Generates and stores custom field DEFINITIONS for one creator, once.
 *
 * No-ops when the creator already has fields, so the "generate on first category
 * set" trigger is safe to call repeatedly — a creator changing their category
 * later does not wipe values they have already typed.
 *
 * Never throws: this runs in an after() callback behind a save that has already
 * succeeded, and failing to suggest extra fields must not surface as a failed save.
 */
export async function generateCustomProfileFields(
  supabase: SupabaseClient,
  creatorId: string,
  category: string
): Promise<{ generated: CustomProfileField[]; skipped?: string }> {
  if (!tableAvailable) return { generated: [], skipped: 'table missing' }
  if (!category) return { generated: [], skipped: 'no business_category' }

  try {
    const { data: existing, error: existingError } = await supabase
      .from('custom_profile_fields')
      .select('id')
      .eq('creator_id', creatorId)
      .limit(1)

    if (existingError) {
      if (!markUnavailable(existingError)) {
        console.error('Custom field existence check error:', existingError.message)
      }
      return { generated: [], skipped: 'existence check failed' }
    }
    if ((existing ?? []).length > 0) return { generated: [], skipped: 'already generated' }

    const signals = await gatherSignals(supabase, creatorId, category)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS)
    let suggestions: Suggestion[] = []

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 900,
          tools: [SUGGEST_TOOL],
          // Forced tool use rather than "reply with JSON": the same choice the
          // answer verifier made after free-text JSON proved unreliable.
          tool_choice: { type: 'tool', name: SUGGEST_TOOL.name },
          messages: [{ role: 'user', content: buildPrompt(signals) }],
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        console.error('Custom field generation API error:', response.status)
        return { generated: [], skipped: `api ${response.status}` }
      }

      const data = await response.json()
      const block = Array.isArray(data.content)
        ? data.content.find((b: { type?: string; name?: string }) => b?.type === 'tool_use' && b.name === SUGGEST_TOOL.name)
        : undefined
      suggestions = sanitize((block?.input as { fields?: unknown } | undefined)?.fields)
    } finally {
      clearTimeout(timeoutId)
    }

    if (suggestions.length === 0) return { generated: [], skipped: 'no usable suggestions' }

    for (const s of suggestions) {
      console.log(`Custom field suggested for ${creatorId}: ${s.field_label} (${s.field_key}) — ${s.reason}`)
    }

    // Values stay null: definitions only, per the brief. onConflict makes a
    // concurrent second call harmless rather than a unique-violation error.
    const { data: inserted, error: insertError } = await supabase
      .from('custom_profile_fields')
      .upsert(
        suggestions.map(s => ({
          creator_id: creatorId,
          field_key: s.field_key,
          field_label: s.field_label,
          field_value: null,
        })),
        { onConflict: 'creator_id,field_key' }
      )
      .select('id, field_key, field_label, field_value')

    if (insertError) {
      if (!markUnavailable(insertError)) {
        console.error('Custom field insert error:', insertError.message)
      }
      return { generated: [], skipped: 'insert failed' }
    }

    return {
      generated: (inserted ?? []).map(row => ({
        id: row.id as string,
        fieldKey: row.field_key as string,
        fieldLabel: row.field_label as string,
        fieldValue: (row.field_value as string | null) ?? null,
      })),
    }
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError' ? 'timed out' : String(err)
    console.error('Custom field generation crashed:', reason)
    return { generated: [], skipped: reason }
  }
}

/**
 * Writes creator-supplied values for existing custom fields.
 *
 * Only keys that already exist for this creator are updated — the request body
 * cannot create new fields, so a crafted payload can't inject arbitrary content
 * into the draft-reply prompt.
 */
export async function saveCustomProfileValues(
  supabase: SupabaseClient,
  creatorId: string,
  values: Record<string, string>
): Promise<number> {
  if (!tableAvailable) return 0

  const keys = Object.keys(values)
  if (keys.length === 0) return 0

  const { data: owned, error } = await supabase
    .from('custom_profile_fields')
    .select('field_key')
    .eq('creator_id', creatorId)
    .in('field_key', keys)

  if (error) {
    if (!markUnavailable(error)) console.error('Custom field ownership check error:', error.message)
    return 0
  }

  let written = 0
  for (const row of owned ?? []) {
    const key = row.field_key as string
    const trimmed = (values[key] ?? '').trim()
    const { error: updateError } = await supabase
      .from('custom_profile_fields')
      // Cleared fields store NULL, matching how the fixed columns treat "".
      .update({ field_value: trimmed.length > 0 ? trimmed : null })
      .eq('creator_id', creatorId)
      .eq('field_key', key)

    if (updateError) console.error(`Custom field update error (${key}):`, updateError.message)
    else written++
  }

  return written
}

/** The filled-in fields as "label: value" pairs, for the draft-reply prompt. */
export function customFieldsToContext(fields: CustomProfileField[]): string[] {
  return fields
    .filter(f => f.fieldValue && f.fieldValue.trim().length > 0)
    .map(f => `${f.fieldLabel}: ${f.fieldValue!.trim()}`)
}
