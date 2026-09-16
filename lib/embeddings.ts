import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Voyage's general-purpose embedding model. voyage-4-large scores higher but has
 * under half the throughput (3M vs 8M tokens/min on tier 1) at a higher price;
 * for short audience comments, voyage-4 is the balanced default.
 */
export const EMBEDDING_MODEL = 'voyage-4'

/**
 * Must match `vector(1024)` in migration 20240101000019. Confirmed from a live
 * voyage-4 response. Sent explicitly as output_dimension rather than relying on
 * the model default, so a default change upstream can't silently produce vectors
 * the column rejects.
 */
export const EMBEDDING_DIMENSION = 1024

/**
 * This project's key was issued through MongoDB Atlas. Atlas keys are rejected
 * by api.voyageai.com with a 403 ("MongoDB Atlas API keys work with MongoDB
 * endpoints"), so the MongoDB endpoint is the default. A key created directly
 * on voyageai.com would need VOYAGE_API_BASE_URL=https://api.voyageai.com.
 */
const DEFAULT_BASE_URL = 'https://ai.mongodb.com'

/** API hard limit is 1000 inputs per request; 100 keeps each request small and retries cheap. */
const MAX_INPUTS_PER_REQUEST = 100

/**
 * voyage-4 allows 320K tokens per request. Tokens are budgeted by character
 * count, which over-counts for English (roughly 4 chars per token) but stays
 * safe for scripts that tokenize close to one token per character.
 */
const MAX_CHARS_PER_REQUEST = 300_000

const MAX_ATTEMPTS = 6

/**
 * Client-side pacing limits, applied PER MODEL (voyage-4 and rerank-2.5 each get
 * their own budget, matching how Voyage publishes its limits).
 *
 * The defaults are Voyage's no-payment-method floor ("reduced rate limits of 3 RPM
 * and 10K TPM", quoted from a 429 on 2026-09-14). They're conservative on purpose:
 * too low only slows things down, too high turns into 429s. This account was
 * re-measured on 2026-09-15 and accepted 24 concurrent requests (12 embeddings +
 * 12 reranks) without a 429, so set the real tier's numbers via env, e.g. tier 1:
 *   VOYAGE_RPM_LIMIT=2000  VOYAGE_TPM_LIMIT=8000000
 */
function rateLimits() {
  const rpm = Number(process.env.VOYAGE_RPM_LIMIT) || 3
  const tpm = Number(process.env.VOYAGE_TPM_LIMIT) || 10_000
  return { rpm, tpm }
}

const WINDOW_MS = 60_000
/** Margin on top of the computed spacing, for clock skew between us and the API. */
const PACING_BUFFER_MS = 500
/** Chars per token assumed when estimating a batch before sending it — deliberately pessimistic. */
const CHARS_PER_TOKEN_ESTIMATE = 3

/**
 * Module-level on purpose: every caller in this process — the backfill loop, or
 * several searches in one server instance — shares one budget per model. Separate
 * serverless instances can't see each other's usage; the 429 backoff below is the
 * backstop for that case.
 */
type LimiterState = { lastRequestAt: number; recentUsage: Array<{ at: number; tokens: number }> }
const limiters = new Map<string, LimiterState>()

function limiterFor(model: string): LimiterState {
  let state = limiters.get(model)
  if (!state) {
    state = { lastRequestAt: 0, recentUsage: [] }
    limiters.set(model, state)
  }
  return state
}

export type EmbeddingInputType = 'document' | 'query'

export type EmbeddingRequestOptions = {
  /**
   * Longest the rate limiter may make this call wait. Background jobs leave it
   * unset and wait as long as needed; an interactive caller (a search inside a
   * chat reply) sets a small value and gets EmbeddingUnavailableError instead of
   * stalling the response for 20+ seconds.
   */
  maxWaitMs?: number
  /** Defaults to MAX_ATTEMPTS. Interactive callers use 1: better to degrade now than retry for minutes. */
  maxAttempts?: number
}

/** Thrown when an embedding can't be produced within the caller's limits. */
export class EmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmbeddingUnavailableError'
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function estimateTokens(texts: string[]) {
  return Math.ceil(texts.reduce((sum, t) => sum + t.length, 0) / CHARS_PER_TOKEN_ESTIMATE)
}

/**
 * Waits until sending `estimatedTokens` more would respect both limits:
 *  - RPM: requests evenly spaced at least 60s / RPM apart (20.5s at 3 RPM), rather
 *    than a burst of three followed by a minute of 429s.
 *  - TPM: tokens actually used in the last 60s (from each response's usage
 *    field) plus this batch's estimate stay within the per-minute cap.
 */
async function waitForRateLimit(state: LimiterState, estimatedTokens: number, maxWaitMs?: number) {
  const { rpm, tpm } = rateLimits()

  for (;;) {
    const now = Date.now()
    while (state.recentUsage.length > 0 && now - state.recentUsage[0].at >= WINDOW_MS) {
      state.recentUsage.shift()
    }

    const spacingWait = state.lastRequestAt + Math.ceil(WINDOW_MS / rpm) + PACING_BUFFER_MS - now

    const usedTokens = state.recentUsage.reduce((sum, u) => sum + u.tokens, 0)
    // If the window must drain to fit this batch, wait for the oldest entry to age out.
    const tokenWait =
      state.recentUsage.length > 0 && usedTokens + estimatedTokens > tpm
        ? state.recentUsage[0].at + WINDOW_MS + PACING_BUFFER_MS - now
        : 0

    const wait = Math.max(spacingWait, tokenWait, 0)
    if (wait === 0) return
    if (maxWaitMs !== undefined && wait > maxWaitMs) {
      throw new EmbeddingUnavailableError(
        `Voyage rate limit: next request allowed in ${Math.ceil(wait / 1000)}s (limit ${rpm} RPM / ${tpm} TPM)`
      )
    }
    await sleep(wait)
  }
}

/**
 * One paced, retried POST to the Voyage API, shared by embeddings and reranking.
 *
 * Every attempt waits for that model's rate limiter first. A 429 is retried after
 * a full RPM interval (and a whole minute if it repeats); 5xx and network
 * failures back off exponentially. Any other 4xx — a bad key, a malformed
 * request — throws immediately, because retrying cannot fix it.
 */
async function voyagePost<T extends { usage?: { total_tokens?: number } }>(
  path: string,
  model: string,
  body: Record<string, unknown>,
  estimatedTokens: number,
  options: EmbeddingRequestOptions
): Promise<T> {
  const apiKey = process.env.VOYAGE_API_KEY
  if (!apiKey) {
    throw new EmbeddingUnavailableError('VOYAGE_API_KEY is not set')
  }
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS
  const baseUrl = process.env.VOYAGE_API_BASE_URL || DEFAULT_BASE_URL
  const state = limiterFor(model)

  for (let attempt = 1; ; attempt++) {
    await waitForRateLimit(state, estimatedTokens, options.maxWaitMs)
    // Stamped at send time: the API counts a request when it arrives, whatever
    // the outcome, so a 429 or a failure still occupies its slot.
    state.lastRequestAt = Date.now()

    let response: Response
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...body, model }),
      })
    } catch (err) {
      if (attempt >= maxAttempts) throw err
      await sleep(backoffMs(attempt))
      continue
    }

    if (response.ok) {
      const parsed = (await response.json()) as T
      // Real usage, not the estimate, is what the TPM window tracks from here on.
      state.recentUsage.push({ at: state.lastRequestAt, tokens: parsed.usage?.total_tokens ?? estimatedTokens })
      return parsed
    }

    const retryable = response.status === 429 || response.status >= 500
    const detail = (await response.text()).slice(0, 300)

    if (!retryable || attempt >= maxAttempts) {
      const message = `Voyage ${path} request failed (${response.status}): ${detail}`
      // A 429 the caller chose not to wait out is "unavailable", not a bug.
      throw response.status === 429 ? new EmbeddingUnavailableError(message) : new Error(message)
    }

    const retryAfterSeconds = Number(response.headers.get('retry-after'))
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      await sleep(retryAfterSeconds * 1000)
    } else if (response.status === 429) {
      // Short exponential retries (1s, 2s, 4s…) are useless against a per-minute
      // cap — they just collect more 429s. The loop's waitForRateLimit already
      // spaces the retry a full RPM interval after this attempt. A second 429 in
      // a row means the window is still full (another server instance using the
      // same key, or the token cap), so wait out a whole minute on top.
      console.warn(`Voyage rate limit hit on ${model} (attempt ${attempt}); waiting before retrying`)
      if (attempt >= 2) await sleep(WINDOW_MS)
    } else {
      await sleep(backoffMs(attempt))
    }
  }
}

/** Embeds a batch of texts in one API call, returning vectors in input order. */
async function embedBatch(
  texts: string[],
  inputType: EmbeddingInputType,
  options: EmbeddingRequestOptions = {}
): Promise<number[][]> {
  const body = await voyagePost<{
    data: Array<{ embedding: number[]; index: number }>
    usage?: { total_tokens?: number }
  }>(
    '/v1/embeddings',
    EMBEDDING_MODEL,
    {
      input: texts,
      // 'document' for stored comments; a similarity search embeds its search text
      // with 'query'. Voyage tunes each side differently.
      input_type: inputType,
      output_dimension: EMBEDDING_DIMENSION,
    },
    estimateTokens(texts),
    options
  )

  // Order by the API's index field rather than trusting array order.
  const vectors: number[][] = new Array(texts.length)
  for (const item of body.data) {
    vectors[item.index] = item.embedding
  }

  for (let i = 0; i < texts.length; i++) {
    if (!vectors[i] || vectors[i].length !== EMBEDDING_DIMENSION) {
      throw new Error(
        `Voyage returned ${vectors[i] ? vectors[i].length : 'no'} dimensions for input ${i}, expected ${EMBEDDING_DIMENSION}`
      )
    }
  }
  return vectors
}

function backoffMs(attempt: number) {
  return 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250)
}

/**
 * Voyage's reranker. Chosen by measurement on this project's comments: for
 * "expensive", precision@10 was 6/10 with reciprocal rank fusion, 8/10 with
 * rerank-2.5, 7/10 with rerank-2.5 plus an instruction prefix (at twice the
 * tokens) and 6/10 with rerank-3; for "delivery", rerank-2.5 put all five
 * genuinely relevant comments in the top five, where fusion had a greeting at #5.
 */
export const RERANK_MODEL = 'rerank-2.5'

export type RerankResult = { index: number; relevance_score: number }

/**
 * Scores `documents` for relevance to `query`, best first. `index` refers back to
 * the position in `documents`.
 */
export async function rerankDocuments(
  query: string,
  documents: string[],
  options: EmbeddingRequestOptions = {}
): Promise<RerankResult[]> {
  if (documents.length === 0) return []

  // Voyage counts rerank tokens as query tokens x documents + document tokens.
  const queryTokens = Math.ceil(query.length / CHARS_PER_TOKEN_ESTIMATE)
  const estimatedTokens = queryTokens * documents.length + estimateTokens(documents)

  const body = await voyagePost<{ data: RerankResult[]; usage?: { total_tokens?: number } }>(
    '/v1/rerank',
    RERANK_MODEL,
    { query, documents },
    estimatedTokens,
    options
  )

  const seen = new Set<number>()
  for (const item of body.data) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= documents.length || seen.has(item.index)) {
      throw new Error(`Voyage rerank returned an invalid index: ${item.index}`)
    }
    if (typeof item.relevance_score !== 'number' || !Number.isFinite(item.relevance_score)) {
      throw new Error(`Voyage rerank returned an invalid score for index ${item.index}`)
    }
    seen.add(item.index)
  }
  if (seen.size !== documents.length) {
    throw new Error(`Voyage rerank scored ${seen.size} of ${documents.length} documents`)
  }

  return [...body.data].sort((a, b) => b.relevance_score - a.relevance_score)
}

/** Embeds a single text. */
export async function generateEmbedding(
  text: string,
  inputType: EmbeddingInputType = 'document',
  options: EmbeddingRequestOptions = {}
): Promise<number[]> {
  const [vector] = await embedBatch([text], inputType, options)
  return vector
}

/**
 * Embeds many texts, splitting into requests that respect Voyage's per-request
 * input and token limits. Returns vectors in the same order as `texts`.
 */
export async function generateEmbeddings(
  texts: string[],
  inputType: EmbeddingInputType = 'document'
): Promise<number[][]> {
  const results: number[][] = []

  let batch: string[] = []
  let batchChars = 0

  const flush = async () => {
    if (batch.length === 0) return
    results.push(...(await embedBatch(batch, inputType)))
    batch = []
    batchChars = 0
  }

  // A batch must fit inside one minute's token allowance as well as the
  // per-request limit; at 10K TPM that caps a request at ~30K characters.
  const maxChars = Math.min(MAX_CHARS_PER_REQUEST, rateLimits().tpm * CHARS_PER_TOKEN_ESTIMATE)

  for (const text of texts) {
    if (batch.length >= MAX_INPUTS_PER_REQUEST || (batch.length > 0 && batchChars + text.length > maxChars)) {
      await flush()
    }
    batch.push(text)
    batchChars += text.length
  }
  await flush()

  return results
}

/**
 * pgvector's text literal. Sent as a string rather than a JSON array so the
 * value reaches Postgres in exactly the form the vector type parses.
 */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`
}

export type EmbedProgress = { embedded: number; total: number }

export type EmbedResult = {
  total: number
  embedded: number
  /** Blank comments: nothing meaningful to embed, so they stay null. */
  skipped: number
  failed: number
}

/** Comments are read in pages of this many rows. */
const PAGE_SIZE = 500
/** Parallel single-row updates. Each is one small PostgREST call. */
const UPDATE_CONCURRENCY = 8

/**
 * Finds comments with no embedding yet — optionally only one post's — embeds them
 * and stores the vectors. Shared by the backfill script and the ingestion
 * pipeline, so there is one definition of "pending" and one write path.
 *
 * Pages with an id cursor rather than an offset. Rows leave the "embedding is
 * null" set as they are written, so an offset would skip rows; and blank comments
 * that are deliberately never embedded would otherwise be re-read forever.
 *
 * Throws if the embeddings API fails (a bad key should stop a backfill, not
 * loop). Individual row-update failures are counted and the run continues.
 */
export async function embedPendingComments(
  supabase: SupabaseClient,
  options: { postId?: string; onProgress?: (progress: EmbedProgress) => void } = {}
): Promise<EmbedResult> {
  const { postId, onProgress } = options

  // A one-row read first, because it reports errors properly. The count below is
  // a HEAD request, and a failed HEAD request has no body — Supabase surfaces it
  // as an error with an empty message, which would hide causes like the
  // embedding column not existing yet (Postgres 42703).
  let probe = supabase.from('comments').select('id').is('embedding', null).limit(1)
  if (postId) probe = probe.eq('post_id', postId)
  const { error: probeError } = await probe
  if (probeError) {
    const hint = probeError.code === '42703' ? ' — run migration 20240101000019_add_comment_embeddings.sql' : ''
    throw new Error(`Could not read pending comments: ${probeError.message}${hint}`)
  }

  let countQuery = supabase
    .from('comments')
    .select('id', { count: 'exact', head: true })
    .is('embedding', null)
  if (postId) countQuery = countQuery.eq('post_id', postId)

  const { count, error: countError } = await countQuery
  if (countError) {
    throw new Error(`Could not count pending comments: ${countError.message}`)
  }

  const result: EmbedResult = { total: count ?? 0, embedded: 0, skipped: 0, failed: 0 }
  if (result.total === 0) return result

  let cursor: string | null = null

  for (;;) {
    let pageQuery = supabase
      .from('comments')
      .select('id, text')
      .is('embedding', null)
      .order('id', { ascending: true })
      .limit(PAGE_SIZE)
    if (postId) pageQuery = pageQuery.eq('post_id', postId)
    if (cursor) pageQuery = pageQuery.gt('id', cursor)

    const { data: page, error: pageError } = await pageQuery
    if (pageError) {
      throw new Error(`Could not read pending comments: ${pageError.message}`)
    }
    if (!page || page.length === 0) break

    cursor = page[page.length - 1].id

    const embeddable = page.filter(row => typeof row.text === 'string' && row.text.trim().length > 0)
    result.skipped += page.length - embeddable.length

    if (embeddable.length > 0) {
      const vectors = await generateEmbeddings(embeddable.map(row => row.text as string), 'document')

      for (let i = 0; i < embeddable.length; i += UPDATE_CONCURRENCY) {
        const slice = embeddable.slice(i, i + UPDATE_CONCURRENCY)
        const outcomes = await Promise.all(
          slice.map((row, j) =>
            supabase
              .from('comments')
              .update({ embedding: toVectorLiteral(vectors[i + j]) })
              .eq('id', row.id)
          )
        )

        for (const { error } of outcomes) {
          if (error) {
            result.failed++
            console.error('Comment embedding update error:', error.message)
          } else {
            result.embedded++
          }
        }

        onProgress?.({ embedded: result.embedded, total: result.total })
      }
    }

    if (page.length < PAGE_SIZE) break
  }

  return result
}

/**
 * Pipeline entry point: embeds a post's newly ingested comments without ever
 * affecting the ingestion or analysis that called it. Logs and returns on any
 * failure — including the column not existing yet because the migration hasn't
 * been run, which must not break analysis.
 */
export async function embedPostCommentsSafely(supabase: SupabaseClient, postId: string): Promise<void> {
  try {
    const result = await embedPendingComments(supabase, { postId })
    if (result.failed > 0) {
      console.error(`Embeddings for post ${postId}: ${result.failed} of ${result.total} updates failed`)
    }
  } catch (err) {
    console.error(`Embeddings skipped for post ${postId}:`, err instanceof Error ? err.message : err)
  }
}
