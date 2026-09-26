import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Named entities in comments — brands, companies, competitors, products and
 * organizations mentioned BY NAME ("Safaricom", "M-Pesa", "iPhone").
 *
 * Normalization happens twice, deliberately:
 *  1. At extraction: the model is told to return one canonical name per entity
 *     (ENTITY_EXTRACTION_RULES), so storage is already mostly clean.
 *  2. At aggregation: entityKey() folds whatever variation still slips through
 *     (casing, punctuation, "Safaricom Kenya", "Safaricom PLC") onto one key, and
 *     the most-used spelling of that key is the one shown.
 * So "Safaricom mentioned 47 times" is one row, not dozens of near-duplicates.
 *
 * Storage convention (comment_categories.entities, migration 41):
 *   NULL = never scanned for entities · [] = scanned, none mentioned.
 */

/** Most entities kept per comment; tangential mentions beyond this are noise. */
export const MAX_ENTITIES_PER_COMMENT = 3

/**
 * The extraction instructions, shared by categorization and the entities backfill
 * so both produce the same canonical names.
 */
export const ENTITY_EXTRACTION_RULES = `"entities": the brands, companies, competitors, products, apps, services or organizations the comment mentions BY NAME. Return 0 to ${MAX_ENTITIES_PER_COMMENT}, most central first, and an EMPTY array [] when there are none — most comments have none.
- Use ONE canonical name per entity: its official brand name with its official casing and spelling, the SAME way every time — a company known both with and without a suffix is always given its full official name (always "Figure AI", never just "Figure"). Always "Safaricom" — never "safaricom", "SAFARICOM", "Safaricom Kenya", "Safaricom PLC" or "saf". "M-Pesa" for mpesa / Mpesa / M pesa. "iPhone" for iphone / i-phone. "KCB" for KCB Bank / Kcb. Drop country suffixes, legal suffixes (Ltd, PLC, Inc) and slogans.
- Normalize spelling, but never substitute a related entity: a product stays that product ("i-phone" → "iPhone", NOT "Apple"). If a product and its maker are both named, list both ("iPhone", "Apple").
- A company and its product are DIFFERENT entities. Choose by what the comment is ABOUT — never by which name is more famous or more commonly used, and never swap one for the other. Example: "Snapchat" is the app itself — using it, its features, praise or complaints about the app, feature requests ("love Snapchat", "who uses snap anymore", "Meta copied Snapchat's stories"). "Snap" is the company — its stock ($SNAP), CEO and leadership, lawsuits, finances, strategy and business decisions such as its smart-glasses bet — even when the comment writes "Snapchat" ("Snapchat is being sued for securities fraud" → "Snap"). For a company and its OWN product, give exactly ONE of the two — whichever the comment is mainly about — never both.
- Only real, specific named entities. NOT generic words ("the bank", "my phone", "the government"), NOT people (no individuals, guests, hosts or commenters), NOT places or countries, NOT the video's own title or channel, NOT hashtags or @handles.
- Only entities the comment is actually about or clearly refers to — skip passing, tangential mentions.`

// "ai", "labs", "technologies" were added after real comments produced both
// "Figure" and "Figure AI" for the same company. A single-token name ("OpenAI") is
// never affected, and a suffix alone ("AI") is kept.
const TRAILING_SUFFIXES = new Set(['kenya', 'ke', 'ltd', 'limited', 'plc', 'inc', 'llc', 'co', 'corp', 'corporation', 'company', 'group', 'official', 'ai', 'labs', 'technologies', 'tech'])

/**
 * The merge key for an entity name: case-, accent- and punctuation-insensitive,
 * with trailing country/legal suffixes dropped — but only when another word comes
 * before them and it isn't "of", so "Kenya Power" and "Central Bank of Kenya" keep
 * their meaning while "Safaricom Kenya" and "Safaricom PLC" become "safaricom".
 */
export function entityKey(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  while (words.length > 1 && TRAILING_SUFFIXES.has(words[words.length - 1]) && words[words.length - 2] !== 'of') words.pop()
  return words.join('')
}

/** Cleans the model's array: trimmed, de-duplicated by key, capped. Non-arrays -> []. */
export function normalizeEntities(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const name = item.replace(/\s+/g, ' ').trim().replace(/^[@#]+/, '')
    const key = entityKey(name)
    if (!name || !key || seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length === MAX_ENTITIES_PER_COMMENT) break
  }
  return out
}

/**
 * A creator's own aliases (entity_aliases, migration 42): alias key -> canonical
 * name. Empty unless the creator has chosen to merge names — nothing is merged by
 * default. See loadEntityAliases.
 */
export type EntityAliases = Map<string, string>

/** Builds the lookup from stored rows; the first row for a key wins. */
export function buildEntityAliases(rows: Array<{ alias_name: string; canonical_name: string }>): EntityAliases {
  const map: EntityAliases = new Map()
  for (const r of rows) {
    const key = entityKey(r.alias_name)
    if (key && entityKey(r.canonical_name) && !map.has(key)) map.set(key, r.canonical_name.trim())
  }
  return map
}

/**
 * The name an entity counts as for this creator: its alias target if one is set,
 * followed through chains (A->B, B->C) with a guard against cycles.
 */
export function resolveEntity(name: string, aliases?: EntityAliases): string {
  if (!aliases?.size) return name
  let current = name
  const seen = new Set<string>()
  for (;;) {
    const key = entityKey(current)
    if (seen.has(key)) return current
    seen.add(key)
    const next = aliases.get(key)
    if (!next) return current
    current = next
  }
}

export type EntityCount = {
  /** The most-used spelling among the merged variants. */
  entity: string
  key: string
  /** Comments mentioning it (each comment counts once per entity). */
  mentions: number
  /** Every spelling that was merged into this entity, with counts. */
  variants: Record<string, number>
}

/**
 * Mention counts per entity across a set of comments, merged by entityKey().
 * Rows with entities NULL (never scanned) are skipped; `scanned` reports coverage.
 */
export function aggregateEntities(rows: Array<{ entities?: string[] | null }>, aliases?: EntityAliases): {
  entities: EntityCount[]
  scanned: number
  unscanned: number
  withAnyEntity: number
} {
  const byKey = new Map<string, EntityCount>()
  let scanned = 0
  let withAnyEntity = 0
  for (const row of rows) {
    if (!Array.isArray(row.entities)) continue
    scanned++
    const keys = new Set<string>()
    for (const raw of row.entities) {
      // An aliased name counts under its canonical entity; its original spelling is
      // still recorded in `variants`, so the merge stays visible.
      const canonical = resolveEntity(raw, aliases)
      const key = entityKey(canonical)
      if (!key || keys.has(key)) continue
      keys.add(key)
      const e = byKey.get(key) ?? { entity: canonical, key, mentions: 0, variants: {} }
      e.mentions++
      e.variants[raw] = (e.variants[raw] ?? 0) + 1
      byKey.set(key, e)
    }
    if (keys.size) withAnyEntity++
  }
  // Shown spelling: the most used; on a tie, prefer one with capitals (a brand's
  // real casing over "safaricom"), then the shortest ("Safaricom" over
  // "Safaricom Kenya"), then alphabetical for determinism.
  const hasCaps = (v: string) => (/[A-Z]/.test(v) ? 0 : 1)
  const canonicalNames = new Set(aliases ? [...aliases.values()].map(v => entityKey(v)) : [])
  for (const e of byKey.values()) {
    // A key the creator chose as an alias target keeps the name they wrote.
    if (canonicalNames.has(e.key)) {
      e.entity = [...aliases!.values()].find(v => entityKey(v) === e.key)!
      continue
    }
    e.entity = Object.entries(e.variants).sort(
      (a, b) => b[1] - a[1] || hasCaps(a[0]) - hasCaps(b[0]) || a[0].length - b[0].length || a[0].localeCompare(b[0])
    )[0][0]
  }
  return {
    entities: [...byKey.values()].sort((a, b) => b.mentions - a.mentions || a.entity.localeCompare(b.entity)),
    scanned,
    unscanned: rows.length - scanned,
    withAnyEntity,
  }
}

/**
 * Other entities whose key starts with this one's, or vice versa — "Snap" and
 * "Snapchat", "Muthokinju" and "Muthokinju Hardware". Deliberately NOT merged:
 * prefix matching also pairs unrelated names ("Meta" and "Metallica"), and a
 * company vs. its product is a judgment call. Surfaced instead, so a count is never
 * presented as complete while a likely-related entity sits beside it unmentioned.
 * Keys shorter than 4 characters never match.
 */
export function relatedEntities(target: EntityCount, all: EntityCount[]): EntityCount[] {
  return all.filter(
    e => e.key !== target.key && Math.min(e.key.length, target.key.length) >= 4 && (e.key.startsWith(target.key) || target.key.startsWith(e.key))
  )
}

/** Whether a comment's stored entities include `name`, compared by key. */
export function mentionsEntity(entities: string[] | null | undefined, name: string, aliases?: EntityAliases): boolean {
  if (!Array.isArray(entities)) return false
  const key = entityKey(resolveEntity(name, aliases))
  return Boolean(key) && entities.some(e => entityKey(resolveEntity(e, aliases)) === key)
}

let aliasTableAvailable = true

/**
 * A creator's aliases. `supabase` should be the service client and `creatorId`
 * session-derived. Degrades to "no aliases" if migration 42 hasn't run or the read
 * fails — aliases only ever merge, so their absence never hides data.
 */
export async function loadEntityAliases(
  supabase: SupabaseClient,
  creatorId: string
): Promise<EntityAliases> {
  if (!aliasTableAvailable) return new Map()
  const { data, error } = await supabase
    .from('entity_aliases')
    .select('alias_name, canonical_name, created_at')
    .eq('creator_id', creatorId)
    .order('created_at', { ascending: true })
  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') aliasTableAvailable = false
    return new Map()
  }
  return buildEntityAliases((data ?? []) as Array<{ alias_name: string; canonical_name: string }>)
}
