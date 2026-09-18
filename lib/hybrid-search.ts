import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { generateEmbedding, rerankDocuments, toVectorLiteral, EmbeddingUnavailableError } from '@/lib/embeddings'
import type { Sentiment } from '@/lib/trending'
import type { CommentLanguage, CommentEmotion, CommentSentiment } from '@/lib/categorize'

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

/**
 * How many fused candidates go to the reranker. Enough headroom below the fused
 * top-20 that a relevant comment fusion ranked ~#30 can still be promoted — the
 * measured rerank-2.5 gain on "expensive" came from comments at fusion ranks 11-40
 * ("how much can ... cost", "we cant afford it") — while staying ~700 tokens.
 */
export const RERANK_CANDIDATES = 40

export type MatchSignal = 'keyword' | 'semantic'

export type HybridSearchResult = {
  id: string
  text: string
  post_id: string
  posted_at: string | null
  author: string
  category: string | null
  /** Detected language, when categorization stored one. */
  language: string | null
  /** The classifier's own sentiment, when stored; null for older comments. */
  sentiment: string | null
  /** The comment's primary emotion, when stored. */
  emotion: string | null
  /** Which signal(s) found this comment. */
  matched_by: MatchSignal[]
  /** Cosine similarity to the query, when the semantic signal found it. */
  similarity: number | null
  /** Reciprocal-rank-fusion score; higher is better. */
  score: number
  /** Reranker relevance for the query (0-1), when reranking ran. */
  relevance: number | null
}

export type HybridSearchResponse = {
  results: HybridSearchResult[]
  /** Comments whose words match the query — an honest count, unlike top-N semantic results. */
  keyword_match_count: number
  /** Why the semantic signal was skipped, when it was; the results are then keyword-only. */
  semantic_unavailable: string | null
  /** Which ordering the results are in: the reranker's, or fusion's as a fallback. */
  ranking: 'rerank' | 'rrf'
  /** Why reranking was skipped, when it was. */
  rerank_unavailable: string | null
}

export type HybridSearchOptions = {
  postId?: string
  category?: string
  /** Inclusive lower bound on the comment's posted_at (ISO timestamp). */
  postedFrom?: string
  /** EXCLUSIVE upper bound on the comment's posted_at (ISO timestamp). */
  postedBefore?: string
  /** The comment's classified sentiment, falling back to the category-derived one. */
  sentiment?: Sentiment | CommentSentiment
  /** The comment's primary emotion. */
  emotion?: CommentEmotion
  /** Exact match on the language detected during categorization. */
  language?: CommentLanguage
  supabase?: SupabaseClient
}

/**
 * The filter arguments shared by all three search SQL functions.
 *
 * The date and sentiment arguments are only sent when set. Calls that don't use
 * them then match both the current functions and the older five-argument ones
 * from migration 20240101000020, so filter-free search keeps working if migration
 * 23 hasn't been run; a filtered call against the old functions fails, and the
 * caller falls back to a search that applies the filters itself.
 */
function filterArgs(creatorId: string, limit: number, options: HybridSearchOptions) {
  return {
    p_creator_id: creatorId,
    p_limit: limit,
    p_post_id: options.postId ?? null,
    p_category: options.category ?? null,
    ...(options.postedFrom ? { p_posted_from: options.postedFrom } : {}),
    ...(options.postedBefore ? { p_posted_before: options.postedBefore } : {}),
    ...(options.sentiment ? { p_sentiment: options.sentiment } : {}),
    ...(options.language ? { p_language: options.language } : {}),
    ...(options.emotion ? { p_emotion: options.emotion } : {}),
  }
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
 * Comment text as the reranker should read it. YouTube returns HTML-encoded text
 * ("didn&#39;t", "<br>", timestamp links), which is noise to a relevance model.
 */
export function textForReranking(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

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
 * vector similarity, fused with reciprocal rank fusion to pick candidates, then
 * reordered by Voyage's reranker. If reranking can't run, fusion's order stands
 * and `rerank_unavailable` says why.
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
  const filters = filterArgs(creatorId, CANDIDATE_POOL, options)

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

  const candidates = fuseByReciprocalRank(semantic, keyword, Math.max(limit, RERANK_CANDIDATES))
  const response: HybridSearchResponse = {
    results: [],
    keyword_match_count: keywordList.length > 0 ? Number(keywordList[0].total_matches) : 0,
    semantic_unavailable: semanticUnavailable,
    ranking: 'rrf',
    rerank_unavailable: null,
  }
  if (candidates.length === 0) return response

  const byId = await loadCommentDetails(
    supabase,
    candidates.map(r => r.id)
  )
  const loaded: HybridSearchResult[] = []
  for (const hit of candidates) {
    const row = byId.get(hit.id)
    if (!row) continue
    loaded.push({
      ...row,
      matched_by: hit.matched_by,
      similarity: hit.similarity,
      score: hit.score,
      relevance: null,
    })
  }

  try {
    // The raw query, not the embedding template: a reranker reads query and
    // document together, and the plain query measured best (an instruction-style
    // query scored lower at twice the tokens).
    const reranked = await rerankDocuments(
      query,
      loaded.map(r => textForReranking(r.text)),
      { maxWaitMs: INTERACTIVE_EMBED_WAIT_MS, maxAttempts: 1 }
    )
    response.results = reranked.slice(0, limit).map(({ index, relevance_score }) => ({
      ...loaded[index],
      relevance: relevance_score,
    }))
    response.ranking = 'rerank'
  } catch (err) {
    // Fusion's order is a sound result on its own; reranking only refines it.
    response.results = loaded.slice(0, limit)
    response.rerank_unavailable =
      err instanceof EmbeddingUnavailableError ? err.message : `Rerank failed: ${err instanceof Error ? err.message : String(err)}`
  }

  return response
}

type CommentDetails = Pick<HybridSearchResult, 'id' | 'text' | 'post_id' | 'posted_at' | 'author' | 'category' | 'language' | 'sentiment' | 'emotion'>

// Each flips to false once the database reports the column missing (language:
// migration 20240101000024, sentiment/emotion: 20240101000026), so later loads skip
// it instead of failing every search.
let languageColumnAvailable = true
let sentimentColumnsAvailable = true

async function loadCommentDetails(supabase: SupabaseClient, ids: string[]): Promise<Map<string, CommentDetails>> {
  const select = () => {
    const extra = `${languageColumnAvailable ? ', language' : ''}${sentimentColumnsAvailable ? ', sentiment, emotion' : ''}`
    // Typed as string, not a literal: the select is assembled at runtime, and
    // Supabase's literal-type parser can't follow the conditional columns.
    const columns: string = `id, text, post_id, posted_at, audience_members ( display_name ), comment_categories ( category${extra} )`
    return supabase.from('comments').select(columns).in('id', ids)
  }
  let { data, error } = await select()
  for (let attempt = 0; attempt < 2 && error; attempt++) {
    if (languageColumnAvailable && /language/.test(error.message ?? '')) languageColumnAvailable = false
    else if (sentimentColumnsAvailable && /(sentiment|emotion)/.test(error.message ?? '')) sentimentColumnsAvailable = false
    else break
    ;({ data, error } = await select())
  }
  if (error) {
    throw new Error(`Could not load search result details: ${error.message}`)
  }
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>
  return new Map(
    rows.map(row => [
      row.id as string,
      {
        id: row.id as string,
        text: row.text as string,
        post_id: row.post_id as string,
        posted_at: (row.posted_at as string | null) ?? null,
        author: (row.audience_members as unknown as { display_name: string } | null)?.display_name || 'Unknown',
        category: (row.comment_categories as unknown as { category: string } | null)?.category ?? null,
        language: (row.comment_categories as unknown as { language?: string | null } | null)?.language ?? null,
        sentiment: (row.comment_categories as unknown as { sentiment?: string | null } | null)?.sentiment ?? null,
        emotion: (row.comment_categories as unknown as { emotion?: string | null } | null)?.emotion ?? null,
      },
    ])
  )
}

export type FilteredCommentsResponse = {
  results: CommentDetails[]
  /** Every comment matching the filters, not just the ones returned. */
  total_matches: number
}

/**
 * Comments matching filters alone, newest first — for questions with no search
 * words, like "what negative comments came in during the last 2 weeks?".
 *
 * Same trust model as hybridSearchComments: `creatorId` must be session-derived.
 * Throws HybridSearchUnavailableError when the SQL function is missing (migration
 * 20240101000023 not run), so the caller can fall back.
 */
export async function listFilteredComments(
  creatorId: string,
  limit: number = 20,
  options: HybridSearchOptions = {}
): Promise<FilteredCommentsResponse> {
  const supabase = options.supabase ?? createServiceClient()
  const { data, error } = await supabase.rpc('search_comments_filtered', filterArgs(creatorId, limit, options))
  if (error) {
    throw new HybridSearchUnavailableError(`search_comments_filtered failed: ${error.message}`)
  }
  const rows = (data as Array<{ id: string; total_matches: number }>) ?? []
  if (rows.length === 0) return { results: [], total_matches: 0 }

  const byId = await loadCommentDetails(
    supabase,
    rows.map(r => r.id)
  )
  return {
    // Keep the SQL function's newest-first order.
    results: rows.map(r => byId.get(r.id)).filter((r): r is CommentDetails => !!r),
    total_matches: Number(rows[0].total_matches),
  }
}
