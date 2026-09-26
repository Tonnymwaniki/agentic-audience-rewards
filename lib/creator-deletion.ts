import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Permanent deletion of one creator and everything hanging off them.
 *
 * The order below is not stylistic — it is the only order that works, derived
 * from the live foreign-key graph (read from the PostgREST schema, since the base
 * tables predate this repo's migrations and no CREATE TABLE for them exists here):
 *
 *   creators ─┬─ posts ──────────┬─ comments ── comment_categories
 *             │                  ├─ channel_videos.post_id
 *             │                  ├─ tracked_videos.post_id
 *             │                  └─ reward_events.post_id
 *             ├─ audience_members ┬─ comments.audience_member_id
 *             │                   └─ reward_events.audience_member_id
 *             ├─ research_conversations ── research_messages
 *             ├─ notifications (also → comments.id)
 *             ├─ channel_videos, tracked_videos, channel_stats_snapshots
 *             ├─ custom_profile_fields, audience_insights, content_ideas_cache
 *             └─ (creators row itself, then the auth user)
 *
 * Only `audience_insights` and `content_ideas_cache` declare ON DELETE CASCADE in
 * their migrations; everything else is a plain reference, so a parent deleted out
 * of order fails with 23503 rather than tidying itself up. Every step here throws
 * on error instead of continuing, because a half-finished delete that swallowed a
 * constraint violation is exactly how orphaned rows are created — a creator whose
 * `creators` row is gone but whose comments remain is unreachable and unfixable
 * through the app.
 *
 * Deliberately NOT wrapped in a transaction: PostgREST gives one HTTP request per
 * statement and there is no transaction handle to share across them. The ordering
 * compensates — every step removes rows that nothing left in the database points
 * at, so an interruption leaves a partially deleted but still self-consistent
 * account that re-running this function finishes off.
 */

/** `.in()` list length that keeps the request URL under PostgREST's limit. */
const CHUNK = 100

export type DeletionReport = Record<string, number>

async function deleteWhereIn(
  supabase: SupabaseClient,
  table: string,
  column: string,
  values: string[]
): Promise<number> {
  if (values.length === 0) return 0
  let total = 0

  for (let i = 0; i < values.length; i += CHUNK) {
    const { count, error } = await supabase
      .from(table)
      .delete({ count: 'exact' })
      .in(column, values.slice(i, i + CHUNK))

    if (error) {
      throw new Error(`Failed deleting ${table} by ${column}: ${error.message} (${error.code})`)
    }
    total += count ?? 0
  }

  return total
}

async function deleteWhereEq(
  supabase: SupabaseClient,
  table: string,
  column: string,
  value: string
): Promise<number> {
  const { count, error } = await supabase
    .from(table)
    .delete({ count: 'exact' })
    .eq(column, value)

  if (error) {
    throw new Error(`Failed deleting ${table} by ${column}: ${error.message} (${error.code})`)
  }

  return count ?? 0
}

/** Ids are needed up front: once the parent rows are gone the children can't be found. */
async function collectIds(
  supabase: SupabaseClient,
  table: string,
  column: string,
  value: string
): Promise<string[]> {
  const ids: string[] = []
  const pageSize = 1000
  let offset = 0

  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select('id')
      .eq(column, value)
      .range(offset, offset + pageSize - 1)

    if (error) throw new Error(`Failed listing ${table}: ${error.message}`)
    if (!data || data.length === 0) break

    ids.push(...data.map(row => (row as { id: string }).id))
    if (data.length < pageSize) break
    offset += pageSize
  }

  return ids
}

/** Comment ids for a set of posts, paged and chunked the same way. */
async function collectCommentIds(supabase: SupabaseClient, postIds: string[]): Promise<string[]> {
  const ids: string[] = []

  for (let i = 0; i < postIds.length; i += CHUNK) {
    const batch = postIds.slice(i, i + CHUNK)
    const pageSize = 1000
    let offset = 0

    for (;;) {
      const { data, error } = await supabase
        .from('comments')
        .select('id')
        .in('post_id', batch)
        .range(offset, offset + pageSize - 1)

      if (error) throw new Error(`Failed listing comments: ${error.message}`)
      if (!data || data.length === 0) break

      ids.push(...data.map(row => (row as { id: string }).id))
      if (data.length < pageSize) break
      offset += pageSize
    }
  }

  return ids
}

/**
 * Deletes every row belonging to `creatorId`, children first, and finally the
 * creator row itself. Returns per-table counts so the caller can log and verify
 * what actually went.
 *
 * Does NOT delete the auth user — that is a separate admin-API call the route
 * makes afterwards, so that a failure there leaves no data behind either way.
 */
export async function deleteCreatorData(
  supabase: SupabaseClient,
  creatorId: string
): Promise<DeletionReport> {
  const report: DeletionReport = {}

  const postIds = await collectIds(supabase, 'posts', 'creator_id', creatorId)
  const memberIds = await collectIds(supabase, 'audience_members', 'creator_id', creatorId)
  const conversationIds = await collectIds(supabase, 'research_conversations', 'creator_id', creatorId)
  const commentIds = await collectCommentIds(supabase, postIds)

  // --- Leaves first ---
  report.comment_categories = await deleteWhereIn(supabase, 'comment_categories', 'comment_id', commentIds)
  report.research_messages = await deleteWhereIn(supabase, 'research_messages', 'conversation_id', conversationIds)

  // Both parents of reward_events, so an event survives neither its member nor
  // its post being removed.
  report.reward_events = await deleteWhereIn(supabase, 'reward_events', 'audience_member_id', memberIds)
  report.reward_events += await deleteWhereIn(supabase, 'reward_events', 'post_id', postIds)

  // Before comments: notifications carry a comment_id.
  report.notifications = await deleteWhereEq(supabase, 'notifications', 'creator_id', creatorId)

  // Before posts AND before audience_members — comments reference both.
  // parent_comment_id is the one self-reference with ON DELETE CASCADE, so
  // replies disappear with the comment they answer.
  report.comments = await deleteWhereIn(supabase, 'comments', 'post_id', postIds)
  // Belt and braces: a comment attached to one of this creator's audience members
  // but to no post of theirs would otherwise block the audience_members delete.
  report.comments += await deleteWhereIn(supabase, 'comments', 'audience_member_id', memberIds)

  // --- Post references, before posts ---
  report.channel_videos = await deleteWhereEq(supabase, 'channel_videos', 'creator_id', creatorId)
  report.tracked_videos = await deleteWhereEq(supabase, 'tracked_videos', 'creator_id', creatorId)

  // --- Plain creator-owned tables ---
  report.custom_profile_fields = await deleteWhereEq(supabase, 'custom_profile_fields', 'creator_id', creatorId)
  report.channel_stats_snapshots = await deleteWhereEq(supabase, 'channel_stats_snapshots', 'creator_id', creatorId)
  report.audience_insights = await deleteWhereEq(supabase, 'audience_insights', 'creator_id', creatorId)
  report.content_ideas_cache = await deleteWhereEq(supabase, 'content_ideas_cache', 'creator_id', creatorId)
  report.research_conversations = await deleteWhereEq(supabase, 'research_conversations', 'creator_id', creatorId)

  // --- Parents last ---
  report.audience_members = await deleteWhereEq(supabase, 'audience_members', 'creator_id', creatorId)
  report.posts = await deleteWhereEq(supabase, 'posts', 'creator_id', creatorId)
  report.creators = await deleteWhereEq(supabase, 'creators', 'id', creatorId)

  return report
}

/**
 * Re-reads every creator-owned table after a delete and reports anything left.
 * Used by the delete route to confirm the cascade actually emptied the account
 * rather than trusting the counts it just produced.
 */
export async function findOrphanedRows(
  supabase: SupabaseClient,
  creatorId: string
): Promise<Record<string, number>> {
  const leftovers: Record<string, number> = {}

  const tables = [
    'posts',
    'audience_members',
    'channel_videos',
    'tracked_videos',
    'notifications',
    'custom_profile_fields',
    'channel_stats_snapshots',
    'audience_insights',
    'content_ideas_cache',
    'research_conversations',
    // Removed by ON DELETE CASCADE with the creator row (migration 42), so it has no
    // explicit delete above; still checked here so a failed cascade can't hide.
    'entity_aliases',
    // Also ON DELETE CASCADE (migration 43).
    'surfaced_insights',
    'creators',
  ]

  for (const table of tables) {
    const column = table === 'creators' ? 'id' : 'creator_id'
    const { count, error } = await supabase
      .from(table)
      .select('*', { count: 'exact', head: true })
      .eq(column, creatorId)

    if (error) {
      // A table that doesn't exist yet (its migration not run) holds nothing to
      // leave behind; any OTHER unreadable table can't be declared clean.
      if (error.code === 'PGRST205' || error.code === '42P01') continue
      leftovers[table] = -1
      continue
    }
    if ((count ?? 0) > 0) leftovers[table] = count ?? 0
  }

  return leftovers
}
