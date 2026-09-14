import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { generateEmbedding, toVectorLiteral, EmbeddingUnavailableError } from '@/lib/embeddings'

/**
 * Candidates fetched from each signal before fusing. Also the bound that makes
 * reciprocal rank fusion keep its promise that a comment found by BOTH signals
 * outranks any comment found by only one: the weakest double match scores
 * 2 / (RRF_K + CANDIDATE_POOL) = 2/110, above the strongest single match,
 * 1 / (RRF_K + 1) = 1/61. That holds for any pool below RRF_K + 2.
 */
export const CANDIDATE_POOL = 50

/** The standard RRF constant: damps the gap between rank 1 and rank 2 so neither signal dominates. */
export const RRF_K = 60

/**
 * Wraps the query before embedding it. A bare word is a weak embedding query:
 * measured on this project's comments, "expensive" alone put generic short
 * replies ("nice one", "Interesting") on top and the literal "quite expensive"
 * comment at #26, while this wrapper lifted precision@10 from 1/10 to 6/10 and
 * left descriptive queries unchanged (8/10, 9/10 before and after). Keyword search
 * still uses the raw query.
 */
export function semanticQueryText(query: string): string {
  return `A viewer comment about: ${query}`
}

/**
 * How long a search will wait on the embeddings rate limiter. This runs inside a
 * chat reply, so when the limit is hit, a keyword-only result now beats a hybrid
 * result 20 seconds later.
 */
const INTERACTIVE_EMBED_WAIT_MS = 2_500

export type MatchSignal = 'keyword' | 'semantic'

export type HybridSearchResult = {
  id: string
  text: string
  post_id: string
  posted_at: string | null
  author: string
  category: string | null
  /** Which signal(s) found this comment. */
  matched_by: MatchSignal[]
  /** Cosine similarity to the query, when the semantic signal found it. */
  similarity: number | null
  /** Fused score; higher is better. */
  score: number
}

export type HybridSearchResponse = {
  results: HybridSearchResult[]
  /** Comments whose words match the query — an honest count, unlike top-N semantic results. */
  keyword_match_count: number
  /** Why the semantic signal was skipped, when it was; the results are then keyword-only. */
  semantic_unavailable: string | null
}

export type HybridSearchOptions = {
  postId?: string
  category?: string
  supabase?: SupabaseClient
}

/**
 * Thrown when the hybrid search SQL functions aren't available — typically
 * because migration 20240101000020 hasn't been run. Callers fall back to their
 * previous search rather than failing.
 */
export class HybridSearchUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HybridSearchUnavailableError'
  }
}

type RankedCandidate = { id: string; similarity?: number }

/**
 * Reciprocal rank fusion. Each list contributes 1 / (RRF_K + rank) for every
 * comment it contains, and the sums are sorted. Ranks, not raw scores, are fused,
 * because cosine similarity and ts_rank are on unrelated scales.
 *
 * Pure, so the ordering rules can be tested without a database.
 */
export function fuseByReciprocalRank(
  semantic: RankedCandidate[],
  keyword: RankedCandidate[],
  limit: number
): Array<{ id: string; score: number; matched_by: MatchSignal[]; similarity: number | null }> {
  const fused = new Map<string, { score: number; matched_by: MatchSignal[]; similarity: number | null }>()

  const add = (list: RankedCandidate[], signal: MatchSignal) => {
    list.forEach((candidate, index) => {
      const entry = fused.get(candidate.id) ?? { score: 0, matched_by: [], similarity: null }
      entry.score += 1 / (RRF_K + index + 1)
      if (!entry.matched_by.includes(signal)) entry.matched_by.push(signal)
      if (candidate.similarity !== undefined) entry.similarity = candidate.similarity
      fused.set(candidate.id, entry)
    })
  }

  // Keyword first so matched_by reads ['keyword', 'semantic'] consistently.
  add(keyword, 'keyword')
  add(semantic, 'semantic')

  return [...fused.entries()]
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit)
}

/**
 * Hybrid search over one creator's comments: full-text keyword matching and
 * vector similarity, fused with reciprocal rank fusion.
 *
 * `creatorId` must come from the authenticated session — the SQL functions trust
 * it, which is why they're callable only with the service-role key.
 *
 * Degrades rather than fails: if the semantic half can't run (rate limit, no API
 * key, SQL error), results are keyword-only and `semantic_unavailable` says why.
 * Only a failure of the keyword half — typically the migration not having been
 * run — throws HybridSearchUnavailableError, so the caller can use its previous
 * search.
 */
export async function hybridSearchComments(
  query: string,
  creatorId: string,
  limit: number = 20,
  options: HybridSearchOptions = {}
): Promise<HybridSearchResponse> {
  const supabase = options.supabase ?? createServiceClient()
  const filters = {
    p_creator_id: creatorId,
    p_limit: CANDIDATE_POOL,
    p_post_id: options.postId ?? null,
    p_category: options.category ?? null,
  }

  // Supabase query builders are lazy — nothing is sent until .then() is called —
  // so calling it here is what actually starts keyword search in parallel with
  // generating the query embedding.
  const keywordPromise = supabase.rpc('search_comments_keyword', { ...filters, p_query: query }).then(result => result)

  let semanticUnavailable: string | null = null
  let semantic: RankedCandidate[] = []

  try {
    const queryEmbedding = await generateEmbedding(semanticQueryText(query), 'query', {
      maxWaitMs: INTERACTIVE_EMBED_WAIT_MS,
      maxAttempts: 1,
    })

    const { data, error } = await supabase.rpc('search_comments_semantic', {
      ...filters,
      p_query_embedding: toVectorLiteral(queryEmbedding),
    })
    if (error) {
      // Keyword search is the baseline; losing the semantic half degrades the
      // result rather than failing it.
      semanticUnavailable = `Semantic search failed: ${error.message}`
      console.error('search_comments_semantic error:', error.message)
    } else {
      semantic = (data as Array<{ id: string; similarity: number }>).map(row => ({
        id: row.id,
        similarity: row.similarity,
      }))
    }
  } catch (err) {
    // Anything that stops the query being embedded leaves keyword search intact.
    semanticUnavailable =
      err instanceof EmbeddingUnavailableError ? err.message : `Embedding failed: ${err instanceof Error ? err.message : String(err)}`
  }

  const { data: keywordRows, error: keywordError } = await keywordPromise
  if (keywordError) {
    throw new HybridSearchUnavailableError(`search_comments_keyword failed: ${keywordError.message}`)
  }
  const keywordList = (keywordRows as Array<{ id: string; total_matches: number }>) ?? []
  const keyword: RankedCandidate[] = keywordList.map(row => ({ id: row.id }))

  const ranked = fuseByReciprocalRank(semantic, keyword, limit)
  const response: HybridSearchResponse = {
    results: [],
    keyword_match_count: keywordList.length > 0 ? Number(keywordList[0].total_matches) : 0,
    semantic_unavailable: semanticUnavailable,
  }
  if (ranked.length === 0) return response

  const { data: details, error: detailsError } = await supabase
    .from('comments')
    .select('id, text, post_id, posted_at, audience_members ( display_name ), comment_categories ( category )')
    .in(
      'id',
      ranked.map(r => r.id)
    )
  if (detailsError) {
    throw new Error(`Could not load search result details: ${detailsError.message}`)
  }

  const byId = new Map((details ?? []).map(row => [row.id as string, row]))
  for (const hit of ranked) {
    const row = byId.get(hit.id)
    if (!row) continue
    response.results.push({
      id: hit.id,
      text: row.text as string,
      post_id: row.post_id as string,
      posted_at: (row.posted_at as string | null) ?? null,
      author: (row.audience_members as unknown as { display_name: string } | null)?.display_name || 'Unknown',
      category: (row.comment_categories as unknown as { category: string } | null)?.category ?? null,
      matched_by: hit.matched_by,
      similarity: hit.similarity,
      score: hit.score,
    })
  }

  return response
}
