import type { SupabaseClient } from '@supabase/supabase-js'
import { aggregateEntities, entityKey, loadEntityAliases, resolveEntity } from '@/lib/entities'
import { generateEmbedding, generateEmbeddings, toVectorLiteral } from '@/lib/embeddings'
import { themesForRow } from '@/lib/audience-insights'
import { FIXED_PROFILE_FIELDS } from '@/lib/knowledge-gaps'
import { logError, logWarn } from '@/lib/logger'

/**
 * Embeddings for named ENTITIES and business-profile FACTS (migration 45), so
 * Research can match them by meaning: "the disappearing-photo app company" finds
 * Snap, "do you ship internationally?" finds the delivery field — with no words in
 * common. Separate from the comment embeddings.
 *
 * Entities are embedded as their canonical name plus context aggregated from the
 * comments naming them (built deterministically — no model call), when first seen
 * and again once their mentions double. Facts are "Label: value" for every filled-in
 * field, re-embedded when the value changes and removed when it is cleared.
 *
 * Similarity is cosine over one creator's rows, computed here. Every function takes
 * the service client and a session- or job-derived creator id, and never throws.
 */

export type EntityCommentRow = {
  text: string
  post_id: string
  entities: string[]
  category: string | null
  sentiment: string | null
  topic: string | null
  topics: string[] | null
}

const CATEGORY_WORDS: Record<string, [string, string]> = {
  complaint: ['complaint', 'complaints'],
  praise: ['praise', 'praise'],
  question: ['question', 'questions'],
  purchase_intent: ['buying question', 'buying questions'],
  content_request: ['content request', 'content requests'],
  spam: ['spam comment', 'spam comments'],
  other: ['other comment', 'other comments'],
}

const tally = (xs: Array<string | null | undefined>) => {
  const m = new Map<string, number>()
  for (const x of xs) if (x) m.set(x, (m.get(x) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/**
 * Up to three short excerpts that NAME the entity — what gives the embedding its
 * meaning. Measured on real data: with only the aggregate stats ("mostly praise,
 * about quality"), "humanoid robot startups" matched iRobot over Figure AI, because
 * nothing said what Figure AI is. A sentence like "Figure AI will be the Apple of
 * robotics" does. Deterministic: shortest informative sentences first.
 */
function nameExcerpts(name: string, rows: EntityCommentRow[]): string[] {
  const words = name.toLowerCase().split(/\s+/).filter(w => w.length >= 3)
  const sentences = rows.flatMap(r =>
    r.text
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .split(/(?<=[.!?])\s+/)
      .map(t => t.replace(/\s+/g, ' ').trim())
  )
  const naming = sentences.filter(t => t.length >= 25 && words.some(w => t.toLowerCase().includes(w)))
  return [...new Set(naming)]
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, 3)
    .map(t => (t.length > 160 ? `${t.slice(0, 157)}…` : t))
}

/**
 * "Snap — named in 24 comments, mostly complaints (12) and questions (5); mostly
 * negative (15 negative, 3 positive); about leadership, profitability, glasses.
 * Mentions: "…"". Pure: the same rows always give the same text.
 */
export function buildEntityContext(name: string, rows: EntityCommentRow[]): string {
  const cats = tally(rows.map(r => r.category)).slice(0, 2)
  const sents = tally(rows.map(r => r.sentiment))
  const themes = tally(rows.flatMap(r => themesForRow(r))).slice(0, 4).map(([t]) => t.replace(/_/g, ' '))
  const parts = [`${name} — named in ${rows.length} comment${rows.length === 1 ? '' : 's'}`]
  if (cats.length) parts.push(`mostly ${cats.map(([c, n]) => `${(CATEGORY_WORDS[c] ?? [c, c])[n === 1 ? 0 : 1]} (${n})`).join(' and ')}`)
  if (sents.length) parts.push(`mostly ${sents[0][0]} (${sents.map(([s, n]) => `${n} ${s}`).join(', ')})`)
  if (themes.length) parts.push(`about ${themes.join(', ')}`)
  const excerpts = nameExcerpts(name, rows)
  return `${parts.join('; ')}.${excerpts.length ? ` Mentions: ${excerpts.map(e => `"${e}"`).join(' ')}` : ''}`
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

const parseVector = (v: unknown): number[] => (typeof v === 'string' ? JSON.parse(v) : (v as number[]))
const missingTable = (code?: string) => code === 'PGRST205' || code === '42P01'

/** Every comment of this creator that names at least one entity, with its category data. */
export async function loadEntityCommentRows(supabase: SupabaseClient, creatorId: string): Promise<EntityCommentRow[]> {
  const { data: posts } = await supabase.from('posts').select('id').eq('creator_id', creatorId)
  const postIds = (posts ?? []).map(p => p.id as string)
  const rows: EntityCommentRow[] = []
  for (let i = 0; i < postIds.length; i += 100) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('comments')
        .select('text, post_id, comment_categories!inner(entities, category, sentiment, topic, topics)')
        .in('post_id', postIds.slice(i, i + 100))
        .not('comment_categories.entities', 'is', null)
        .range(from, from + 999)
      if (error) throw new Error(`Could not load entity comments: ${error.message}`)
      for (const r of data ?? []) {
        const c = r.comment_categories as unknown as { entities: string[] | null; category: string | null; sentiment: string | null; topic: string | null; topics: string[] | null }
        if (c?.entities?.length) rows.push({ text: r.text as string, post_id: r.post_id as string, entities: c.entities, category: c.category, sentiment: c.sentiment, topic: c.topic, topics: c.topics })
      }
      if (!data || data.length < 1000) break
    }
  }
  return rows
}

export type SyncReport = { embedded: string[]; refreshed: string[]; removed: string[]; unchanged: number; skipped?: string; error?: string }

/**
 * Embeds entities first seen since the last sync, and re-embeds ones whose mentions
 * have at least doubled (their context has materially changed).
 */
export async function syncEntityEmbeddings(
  supabase: SupabaseClient,
  creatorId: string,
  options: { force?: boolean } = {}
): Promise<SyncReport> {
  const report: SyncReport = { embedded: [], refreshed: [], removed: [], unchanged: 0 }
  try {
    const { data: stored, error } = await supabase.from('entity_embeddings').select('entity_key, mention_count').eq('creator_id', creatorId)
    if (error) return missingTable(error.code) ? { ...report, skipped: 'migration 45 not applied' } : { ...report, error: error.message }
    const storedBy = new Map((stored ?? []).map(r => [r.entity_key as string, r.mention_count as number]))

    const aliases = await loadEntityAliases(supabase, creatorId)
    const rows = await loadEntityCommentRows(supabase, creatorId)
    const agg = aggregateEntities(rows, aliases)
    const todo = agg.entities.filter(e => {
      const prev = storedBy.get(e.key)
      if (prev === undefined) return true
      // force: re-embed everything, e.g. after the context format changes.
      if (options.force || e.mentions >= prev * 2) return true
      report.unchanged++
      return false
    })
    if (todo.length === 0) return report

    const contexts = todo.map(e =>
      buildEntityContext(
        e.entity,
        rows.filter(r => r.entities.some(x => entityKey(resolveEntity(x, aliases)) === e.key))
      )
    )
    const vectors = await generateEmbeddings(contexts, 'document')
    const { error: upsertError } = await supabase.from('entity_embeddings').upsert(
      todo.map((e, i) => ({
        creator_id: creatorId,
        entity_key: e.key,
        entity_name: e.entity,
        context: contexts[i],
        mention_count: e.mentions,
        embedding: toVectorLiteral(vectors[i]),
        embedded_at: new Date().toISOString(),
      })),
      { onConflict: 'creator_id,entity_key' }
    )
    if (upsertError) return { ...report, error: upsertError.message }
    for (const e of todo) (storedBy.has(e.key) ? report.refreshed : report.embedded).push(e.entity)
  } catch (err) {
    logError('knowledgeEmbeddings.entities', err, { creator_id: creatorId })
    report.error = err instanceof Error ? err.message : String(err)
  }
  return report
}

/** Embeds every filled-in profile field; re-embeds changed ones, removes cleared ones. */
export async function syncProfileFactEmbeddings(supabase: SupabaseClient, creatorId: string): Promise<SyncReport> {
  const report: SyncReport = { embedded: [], refreshed: [], removed: [], unchanged: 0 }
  try {
    const { data: stored, error } = await supabase.from('profile_fact_embeddings').select('id, source, field_key, content').eq('creator_id', creatorId)
    if (error) return missingTable(error.code) ? { ...report, skipped: 'migration 45 not applied' } : { ...report, error: error.message }

    const [{ data: creator }, { data: custom }] = await Promise.all([
      supabase.from('creators').select(FIXED_PROFILE_FIELDS.map(f => f.column).join(', ')).eq('id', creatorId).maybeSingle(),
      supabase.from('custom_profile_fields').select('field_key, field_label, field_value').eq('creator_id', creatorId),
    ])
    const want: Array<{ source: 'fixed' | 'custom'; field_key: string; field_label: string; content: string }> = []
    for (const f of FIXED_PROFILE_FIELDS) {
      const v = ((creator as Record<string, string | null> | null)?.[f.column] ?? '').trim()
      if (v) want.push({ source: 'fixed', field_key: f.column, field_label: f.label, content: `${f.label}: ${v}` })
    }
    for (const f of custom ?? []) {
      const v = ((f.field_value as string | null) ?? '').trim()
      if (v) want.push({ source: 'custom', field_key: f.field_key as string, field_label: f.field_label as string, content: `${f.field_label}: ${v}` })
    }

    const key = (s: string, k: string) => `${s}:${k}`
    const storedBy = new Map((stored ?? []).map(r => [key(r.source as string, r.field_key as string), r]))
    const changed = want.filter(w => {
      const prev = storedBy.get(key(w.source, w.field_key))
      if (prev && prev.content === w.content) { report.unchanged++; return false }
      return true
    })
    if (changed.length) {
      const vectors = await generateEmbeddings(changed.map(c => c.content), 'document')
      const { error: upsertError } = await supabase.from('profile_fact_embeddings').upsert(
        changed.map((c, i) => ({ creator_id: creatorId, ...c, embedding: toVectorLiteral(vectors[i]), embedded_at: new Date().toISOString() })),
        { onConflict: 'creator_id,source,field_key' }
      )
      if (upsertError) return { ...report, error: upsertError.message }
      for (const c of changed) (storedBy.has(key(c.source, c.field_key)) ? report.refreshed : report.embedded).push(c.field_label)
    }
    const wanted = new Set(want.map(w => key(w.source, w.field_key)))
    const stale = (stored ?? []).filter(r => !wanted.has(key(r.source as string, r.field_key as string)))
    if (stale.length) {
      await supabase.from('profile_fact_embeddings').delete().in('id', stale.map(r => r.id as string))
      report.removed = stale.map(r => r.field_key as string)
    }
  } catch (err) {
    logError('knowledgeEmbeddings.facts', err, { creator_id: creatorId })
    report.error = err instanceof Error ? err.message : String(err)
  }
  return report
}

/** Both syncs, for the daily job and after analysis. Never throws. */
export async function syncKnowledgeEmbeddings(supabase: SupabaseClient, creatorId: string) {
  const [entities, facts] = await Promise.all([syncEntityEmbeddings(supabase, creatorId), syncProfileFactEmbeddings(supabase, creatorId)])
  return { entities, facts }
}

export type EntityMatch = { entity: string; key: string; mentions: number; context: string; similarity: number }
export type FactMatch = { source: string; field_key: string; field_label: string; content: string; similarity: number }

/** Entities ranked by meaning against `query`. [] if unavailable. */
export async function matchEntities(supabase: SupabaseClient, creatorId: string, query: string, limit = 5): Promise<EntityMatch[]> {
  try {
    const { data, error } = await supabase.from('entity_embeddings').select('entity_key, entity_name, context, mention_count, embedding').eq('creator_id', creatorId)
    if (error) { if (!missingTable(error.code)) logWarn('knowledgeEmbeddings.matchEntities', error.message, { creator_id: creatorId }); return [] }
    if (!data?.length) return []
    const q = await generateEmbedding(query, 'query')
    return data
      .map(r => ({ entity: r.entity_name as string, key: r.entity_key as string, mentions: r.mention_count as number, context: r.context as string, similarity: Math.round(cosine(q, parseVector(r.embedding)) * 1000) / 1000 }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
  } catch (err) {
    logError('knowledgeEmbeddings.matchEntities', err, { creator_id: creatorId })
    return []
  }
}

/** Profile facts ranked by meaning against `query`. [] if unavailable. */
export async function matchProfileFacts(supabase: SupabaseClient, creatorId: string, query: string, limit = 3): Promise<FactMatch[]> {
  try {
    const { data, error } = await supabase.from('profile_fact_embeddings').select('source, field_key, field_label, content, embedding').eq('creator_id', creatorId)
    if (error) { if (!missingTable(error.code)) logWarn('knowledgeEmbeddings.matchFacts', error.message, { creator_id: creatorId }); return [] }
    if (!data?.length) return []
    const q = await generateEmbedding(query, 'query')
    return data
      .map(r => ({ source: r.source as string, field_key: r.field_key as string, field_label: r.field_label as string, content: r.content as string, similarity: Math.round(cosine(q, parseVector(r.embedding)) * 1000) / 1000 }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
  } catch (err) {
    logError('knowledgeEmbeddings.matchFacts', err, { creator_id: creatorId })
    return []
  }
}
