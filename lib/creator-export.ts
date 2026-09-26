import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchInBatches } from '@/lib/supabase-helpers'

/**
 * Builds the "Download my data" payload: everything this creator owns, and
 * nothing anyone else does. Every query is filtered by `creatorId` or by ids
 * already derived from it, so there is no path by which another creator's rows
 * can enter the file.
 *
 * Two deliberate exclusions:
 *
 *  - `comments.embedding` and `comments.text_search` — machine representations
 *    of the comment text that is already included, running to thousands of
 *    floats per row. They would dominate the file size while telling the creator
 *    nothing they can read.
 *  - `reward_events.claim_token` — the bearer secret that lets someone claim a
 *    reward. It is the creator's row, but a downloaded file is a copy that
 *    escapes the app's control, and a leaked token is a claimable reward. The
 *    event is exported with its status and transaction hash; the secret is not.
 */

const PAGE_SIZE = 1000

async function pageAll<T>(
  supabase: SupabaseClient,
  table: string,
  select: string,
  column: string,
  value: string
): Promise<T[]> {
  const rows: T[] = []
  let offset = 0

  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .eq(column, value)
      .range(offset, offset + PAGE_SIZE - 1)

    if (error) throw new Error(`Export failed reading ${table}: ${error.message}`)
    if (!data || data.length === 0) break

    rows.push(...(data as T[]))
    if (data.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  return rows
}

export async function buildCreatorExport(
  supabase: SupabaseClient,
  creatorId: string,
  userEmail: string | null
): Promise<Record<string, unknown>> {
  const { data: profile, error: profileError } = await supabase
    .from('creators')
    .select('*')
    .eq('id', creatorId)
    .maybeSingle()

  if (profileError) throw new Error(`Export failed reading profile: ${profileError.message}`)

  const posts = await pageAll<{ id: string }>(
    supabase,
    'posts',
    'id, platform_id, external_post_id, title, posted_at, ingested_at, analysis_status, comments_total, comments_categorized, members_evaluated, members_total, like_count, view_count, duration_seconds, youtube_category',
    'creator_id',
    creatorId
  )

  const members = await pageAll<{ id: string }>(
    supabase,
    'audience_members',
    'id, platform_id, external_id, display_name, wallet_address, reward_status, profile_summary, profile_updated_at, segment, level',
    'creator_id',
    creatorId
  )

  const postIds = posts.map(p => p.id)
  const memberIds = members.map(m => m.id)

  const comments = postIds.length
    ? await fetchInBatches<{ id: string }>(supabase, {
        table: 'comments',
        select: 'id, post_id, external_comment_id, audience_member_id, text, posted_at, ingested_at, like_count, parent_comment_id, reply_count',
        inColumn: 'post_id',
        inValues: postIds,
        throwOnError: true,
      })
    : []

  const categorizations = comments.length
    ? await fetchInBatches(supabase, {
        table: 'comment_categories',
        select: 'comment_id, category, topic, confidence, created_at, draft_reply, draft_reply_approved_at, final_reply_text, reply_was_edited, escalation_flag, language, sentiment, emotion, topics',
        inColumn: 'comment_id',
        inValues: comments.map(c => c.id),
        throwOnError: true,
      })
    : []

  const rewardEvents = memberIds.length
    ? await fetchInBatches(supabase, {
        table: 'reward_events',
        select: 'id, audience_member_id, post_id, reason, tx_hash, token, status, created_at, confidence',
        inColumn: 'audience_member_id',
        inValues: memberIds,
        throwOnError: true,
      })
    : []

  const conversations = await pageAll<{ id: string }>(
    supabase,
    'research_conversations',
    'id, title, created_at, updated_at',
    'creator_id',
    creatorId
  )

  const messages = conversations.length
    ? await fetchInBatches(supabase, {
        table: 'research_messages',
        select: 'id, conversation_id, role, content, created_at',
        inColumn: 'conversation_id',
        inValues: conversations.map(c => c.id),
        throwOnError: true,
      })
    : []

  const customFields = await pageAll(
    supabase,
    'custom_profile_fields',
    'field_key, field_label, field_value, generated_at',
    'creator_id',
    creatorId
  )

  const channelVideos = await pageAll(
    supabase,
    'channel_videos',
    'video_id, title, published_at, post_id, discovered_at',
    'creator_id',
    creatorId
  )

  const statsSnapshots = await pageAll(
    supabase,
    'channel_stats_snapshots',
    'subscriber_count, channel_view_count, recorded_at',
    'creator_id',
    creatorId
  )

  // The creator's own entity-merge settings (migration 42). Tolerates the table not
  // existing yet, so an export never fails for a migration that hasn't been run.
  let entityAliases: unknown[] = []
  try {
    entityAliases = await pageAll(supabase, 'entity_aliases', 'alias_name, canonical_name, created_at', 'creator_id', creatorId)
  } catch (err) {
    if (!/entity_aliases/.test(String(err)) || !/(PGRST205|does not exist|schema cache)/i.test(String(err))) throw err
  }

  return {
    export_version: 1,
    generated_at: new Date().toISOString(),
    account: { creator_id: creatorId, email: userEmail },
    notes: {
      excluded:
        'Comment embeddings and full-text search vectors are omitted (machine representations of text already included here). Reward claim tokens are omitted because they are bearer secrets that can be used to claim a reward.',
    },
    counts: {
      posts: posts.length,
      comments: comments.length,
      comment_categorizations: categorizations.length,
      audience_members: members.length,
      reward_events: rewardEvents.length,
      research_conversations: conversations.length,
      research_messages: messages.length,
      custom_profile_fields: customFields.length,
      channel_videos: channelVideos.length,
      channel_stats_snapshots: statsSnapshots.length,
      entity_aliases: entityAliases.length,
    },
    profile,
    custom_profile_fields: customFields,
    entity_aliases: entityAliases,
    posts,
    comments,
    comment_categorizations: categorizations,
    audience_members: members,
    reward_events: rewardEvents,
    research_conversations: conversations,
    research_messages: messages,
    channel_videos: channelVideos,
    channel_stats_snapshots: statsSnapshots,
  }
}
