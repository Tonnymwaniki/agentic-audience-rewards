import { SupabaseClient } from '@supabase/supabase-js'

export async function fetchInBatches<T>(
  supabase: SupabaseClient,
  options: { table: string; select: string; inColumn: string; inValues: string[] }
): Promise<T[]> {
  const batchSize = 200
  const allResults: T[] = []

  for (let i = 0; i < options.inValues.length; i += batchSize) {
    const batch = options.inValues.slice(i, i + batchSize)
    const { data, error } = await supabase
      .from(options.table)
      .select(options.select)
      .in(options.inColumn, batch)

    if (error) {
      console.log(`fetchInBatches error on ${options.table}:`, JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
      continue
    }
    if (data) allResults.push(...(data as T[]))
  }

  return allResults
}
