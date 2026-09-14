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

export type EmbeddingInputType = 'document' | 'query'

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Embeds a batch of texts in one API call, returning vectors in input order.
 *
 * Retries 429s, 5xx and network failures with exponential backoff (1s, 2s, 4s…
 * plus jitter), as Voyage's rate-limit docs recommend. Any other 4xx — a bad key,
 * a malformed request — throws immediately, because retrying cannot fix it.
 */
async function embedBatch(texts: string[], inputType: EmbeddingInputType): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY
  if (!apiKey) {
    throw new Error('VOYAGE_API_KEY is not set')
  }

  const baseUrl = process.env.VOYAGE_API_BASE_URL || DEFAULT_BASE_URL

  for (let attempt = 1; ; attempt++) {
    let response: Response
    try {
      response = await fetch(`${baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: texts,
          model: EMBEDDING_MODEL,
          // 'document' for stored comments; a later similarity search should embed
          // its search text with 'query'. Voyage tunes each side differently.
          input_type: inputType,
          output_dimension: EMBEDDING_DIMENSION,
        }),
      })
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err
      await sleep(backoffMs(attempt))
      continue
    }

    if (response.ok) {
      const body = (await response.json()) as {
        data: Array<{ embedding: number[]; index: number }>
      }

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

    const retryable = response.status === 429 || response.status >= 500
    const detail = (await response.text()).slice(0, 300)

    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new Error(`Voyage embeddings request failed (${response.status}): ${detail}`)
    }

    const retryAfterSeconds = Number(response.headers.get('retry-after'))
    await sleep(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : backoffMs(attempt))
  }
}

function backoffMs(attempt: number) {
  return 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250)
}

/** Embeds a single text. */
export async function generateEmbedding(
  text: string,
  inputType: EmbeddingInputType = 'document'
): Promise<number[]> {
  const [vector] = await embedBatch([text], inputType)
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

  for (const text of texts) {
    if (batch.length >= MAX_INPUTS_PER_REQUEST || (batch.length > 0 && batchChars + text.length > MAX_CHARS_PER_REQUEST)) {
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
function toVectorLiteral(vector: number[]): string {
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
