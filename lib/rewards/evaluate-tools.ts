import type { SupabaseClient } from '@supabase/supabase-js'

// Two narrow lookups the reward decision can request before committing. Deliberately
// not the sixteen the Research chat has: this runs once PER PERSON inside a batch, so
// every extra round trip multiplies across the whole run.

export const REWARD_TOOLS = [
  {
    name: 'get_person_full_history',
    description:
      "This person's complete comment history across ALL of this creator's videos, not just the one being evaluated. Use this when the signals you were given look borderline, or when the evaluation is scoped to a single video and you want to know whether this person engages consistently elsewhere. Returns per-video comment counts, categories, and sample text.",
    input_schema: {
      type: 'object' as const,
      properties: {
        audience_member_id: {
          type: 'string',
          description: 'The audience member to look up. Use the id given in the signals.',
        },
      },
      required: ['audience_member_id'],
    },
  },
  {
    name: 'get_similar_rewarded_people',
    description:
      'A sample of people this creator has already rewarded, with the reason each was recognized. Use this to calibrate your bar against real precedent for this creator rather than deciding in a vacuum — especially when you are unsure whether this person clears it.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
]

export type PersonHistory = {
  total_comments: number
  distinct_videos: number
  per_video: Array<{ video: string; comments: number; categories: string[] }>
  sample_comments: string[]
  note?: string
}

/**
 * Every comment this person has left on any of THIS creator's posts.
 *
 * Creator scoping is enforced by resolving the creator's post ids first and
 * constraining the query to them — a member id supplied by the model can never
 * reach another creator's comments, even if it were somehow wrong.
 */
export async function getPersonFullHistory(
  supabase: SupabaseClient,
  creatorPostIds: string[],
  postTitles: Map<string, string>,
  audienceMemberId: string
): Promise<PersonHistory> {
  if (creatorPostIds.length === 0) {
    return { total_comments: 0, distinct_videos: 0, per_video: [], sample_comments: [] }
  }

  const { data: comments, error } = await supabase
    .from('comments')
    .select('id, post_id, text')
    .eq('audience_member_id', audienceMemberId)
    .in('post_id', creatorPostIds)
    .limit(200)

  if (error) {
    console.error('Reward tool history error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
    return { total_comments: 0, distinct_videos: 0, per_video: [], sample_comments: [], note: 'lookup failed' }
  }

  const rows = comments || []
  if (rows.length === 0) {
    return { total_comments: 0, distinct_videos: 0, per_video: [], sample_comments: [] }
  }

  const { data: categories } = await supabase
    .from('comment_categories')
    .select('comment_id, category')
    .in('comment_id', rows.map(c => c.id))

  const categoryByComment = new Map((categories || []).map(c => [c.comment_id, c.category]))

  const byPost = new Map<string, { comments: number; categories: Set<string> }>()
  for (const row of rows) {
    const entry = byPost.get(row.post_id) || { comments: 0, categories: new Set<string>() }
    entry.comments++
    const category = categoryByComment.get(row.id)
    if (category) entry.categories.add(category)
    byPost.set(row.post_id, entry)
  }

  return {
    total_comments: rows.length,
    distinct_videos: byPost.size,
    per_video: Array.from(byPost.entries())
      .sort((a, b) => b[1].comments - a[1].comments)
      .slice(0, 10)
      .map(([postId, entry]) => ({
        video: postTitles.get(postId) || 'Untitled video',
        comments: entry.comments,
        categories: Array.from(entry.categories),
      })),
    // Longest first: a person's most substantive comments say more about whether
    // the engagement is genuine than whichever three happen to be newest.
    sample_comments: rows
      .map(c => c.text)
      .sort((a, b) => b.length - a.length)
      .slice(0, 5)
      .map(text => (text.length > 240 ? `${text.slice(0, 240)}…` : text)),
  }
}

export type RewardedPrecedent = {
  count: number
  examples: Array<{ person: string; reason: string }>
}

/**
 * People this creator has already rewarded, with the stated reason.
 *
 * Scoped by resolving the creator's own audience members first, so precedent from
 * another creator can never leak in.
 */
export async function getSimilarRewardedPeople(
  supabase: SupabaseClient,
  creatorMemberIds: string[],
  limit = 5
): Promise<RewardedPrecedent> {
  if (creatorMemberIds.length === 0) return { count: 0, examples: [] }

  const { data, error } = await supabase
    .from('reward_events')
    .select('reason, created_at, audience_members ( display_name )')
    .in('audience_member_id', creatorMemberIds.slice(0, 200))
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('Reward tool precedent error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
    return { count: 0, examples: [] }
  }

  const rows = data || []
  return {
    count: rows.length,
    examples: rows.map(row => ({
      person: (row.audience_members as unknown as { display_name: string } | null)?.display_name || 'Someone',
      reason: row.reason,
    })),
  }
}
