import { SupabaseClient } from '@supabase/supabase-js'

const BATCH_SIZE = 200
const PAGE_SIZE = 1000

export type FetchInBatchesOptions = {
  table: string
  select: string
  inColumn: string
  inValues: string[]
  /**
   * Extra equality filters applied server-side alongside the `in` clause, so a
   * narrowing filter never has to happen in JS after over-fetching.
   */
  eq?: Record<string, string>
  /**
   * By default a failed batch is logged and skipped, which returns a PARTIAL list
   * that looks complete to the caller. Pass true where silently dropping rows
   * would be worse than showing an error.
   */
  throwOnError?: boolean
}

/**
 * Fetches rows whose `inColumn` is one of `inValues`, chunking the `in` list so the
 * request URL stays under Supabase's length limit (a single .in() with several
 * hundred ids fails outright with a Bad Request).
 *
 * Each chunk is itself paged, because Supabase caps a single response at 1000 rows
 * — without this, a chunk matching more than 1000 rows would silently truncate.
 */
export async function fetchInBatches<T>(
  supabase: SupabaseClient,
  options: FetchInBatchesOptions
): Promise<T[]> {
  const allResults: T[] = []

  for (let i = 0; i < options.inValues.length; i += BATCH_SIZE) {
    const batch = options.inValues.slice(i, i + BATCH_SIZE)

    let offset = 0
    let hasMore = true

    while (hasMore) {
      let query = supabase
        .from(options.table)
        .select(options.select)
        .in(options.inColumn, batch)

      for (const [column, value] of Object.entries(options.eq || {})) {
        query = query.eq(column, value)
      }

      const { data, error } = await query.range(offset, offset + PAGE_SIZE - 1)

      if (error) {
        console.log(`fetchInBatches error on ${options.table}:`, JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
        if (options.throwOnError) {
          throw new Error(`fetchInBatches failed on ${options.table}: ${error.message}`)
        }
        break
      }

      if (data && data.length > 0) {
        allResults.push(...(data as T[]))
        offset += PAGE_SIZE
      }

      if (!data || data.length < PAGE_SIZE) {
        hasMore = false
      }
    }
  }

  return allResults
}
