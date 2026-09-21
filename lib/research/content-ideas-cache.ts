import type { SupabaseClient } from '@supabase/supabase-js'
import type { ContentIdea } from '@/lib/research/content-ideas'
import { logWarn } from '@/lib/logger'

/** Ideas are regenerated at most once a day unless the creator asks. */
export const IDEAS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000

export type SignalCounts = {
  questions: number
  buying: number
  requests: number
  repeated: number
}

export type CachedIdeas = {
  ideas: ContentIdea[]
  signal_counts: SignalCounts
  generated_at: string
}

export function isFresh(cached: CachedIdeas, now = Date.now()) {
  return now - new Date(cached.generated_at).getTime() < IDEAS_CACHE_MAX_AGE_MS
}

/**
 * The creator's cached ideas, or null. A read error (including the table not
 * existing yet) is logged and treated as a cache miss, so the page still works by
 * generating fresh ideas.
 */
export async function loadCachedIdeas(supabase: SupabaseClient, creatorId: string): Promise<CachedIdeas | null> {
  const { data, error } = await supabase
    .from('content_ideas_cache')
    .select('ideas, signal_counts, generated_at')
    .eq('creator_id', creatorId)
    .maybeSingle()
  if (error) {
    logWarn('research.contentIdeasCache', 'Cache read failed; ideas will be regenerated', { creator_id: creatorId, code: error.code })
    return null
  }
  return (data as CachedIdeas | null) ?? null
}

/** Stores a successful generation. Callers must never pass a rejected result. */
export async function saveCachedIdeas(
  supabase: SupabaseClient,
  creatorId: string,
  ideas: ContentIdea[],
  signalCounts: SignalCounts
): Promise<string> {
  const generatedAt = new Date().toISOString()
  const { error } = await supabase.from('content_ideas_cache').upsert(
    {
      creator_id: creatorId,
      ideas,
      signal_counts: signalCounts,
      generated_at: generatedAt,
    },
    { onConflict: 'creator_id' }
  )
  if (error) logWarn('research.contentIdeasCache', 'Cache write failed; ideas were still returned', { creator_id: creatorId, code: error.code })
  return generatedAt
}
