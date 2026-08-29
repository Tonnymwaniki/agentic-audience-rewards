import { createServiceClient } from '@/lib/supabase/service'
import { fetchInBatches } from '@/lib/supabase-helpers'
import Link from 'next/link'
import Avatar from '@/components/Avatar'
import PageHeader from '@/components/PageHeader'

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
}

export default async function RepeatedCommentsPage() {
  const supabase = createServiceClient()

  const { data: posts, error: postsError } = await supabase
    .from('posts')
    .select('id')
    .order('ingested_at', { ascending: false })

  if (postsError) {
    console.error('Posts fetch error:', JSON.stringify(postsError, Object.getOwnPropertyNames(postsError), 2))
    return (
      <div className="p-6">
        <p className="text-red-500">Failed to load posts</p>
      </div>
    )
  }

  const postIds = (posts || []).map(p => p.id)

  if (postIds.length === 0) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <PageHeader title="Repeated Comments" backHref="/dashboard/inbox" backLabel="My Videos" />
        <p className="text-text-muted">No videos yet.</p>
      </div>
    )
  }

  const allCommentRows: Array<{ id: string; text: string; audience_member_id: string; post_id: string }> = []
  let offset = 0
  const batchSize = 1000
  let hasMore = true

  while (hasMore) {
    const { data: batch, error: commentsError } = await supabase
      .from('comments')
      .select('id, text, audience_member_id, post_id')
      .in('post_id', postIds)
      .range(offset, offset + batchSize - 1)

    if (commentsError) {
      console.error('Comments paginated fetch error:', JSON.stringify(commentsError, Object.getOwnPropertyNames(commentsError), 2))
      break
    }

    if (batch && batch.length > 0) {
      allCommentRows.push(...batch)
      offset += batchSize
    }

    if (!batch || batch.length < batchSize) {
      hasMore = false
    }
  }

  const normalizedMap = new Map<string, Array<{ id: string; audienceMemberId: string; postId: string }>>()

  for (const comment of allCommentRows) {
    const key = normalizeText(comment.text)
    const existing = normalizedMap.get(key) || []
    existing.push({ id: comment.id, audienceMemberId: comment.audience_member_id, postId: comment.post_id })
    normalizedMap.set(key, existing)
  }

  const repeatedGroups: Array<{
    normalizedText: string
    originalText: string
    count: number
    uniqueMembers: Set<string>
    commentIds: string[]
    memberPostIds: Map<string, string>
  }> = []

  for (const [normalizedText, entries] of normalizedMap.entries()) {
    if (entries.length < 2) continue

    const uniqueMembers = new Set(entries.map(e => e.audienceMemberId).filter((id): id is string => Boolean(id)))
    if (uniqueMembers.size < 2) continue

    const originalText = allCommentRows.find(c => normalizeText(c.text) === normalizedText)?.text || normalizedText
    const memberPostIds = new Map(entries.filter(e => e.audienceMemberId).map(e => [e.audienceMemberId, e.postId]))

    repeatedGroups.push({
      normalizedText,
      originalText,
      count: entries.length,
      uniqueMembers,
      commentIds: entries.map(e => e.id),
      memberPostIds,
    })
  }

  repeatedGroups.sort((a, b) => b.count - a.count)

  const memberIds = Array.from(new Set(
    allCommentRows
      .map(c => c.audience_member_id)
      .filter((id): id is string => Boolean(id))
  ))

  const audienceMembers = await fetchInBatches<{ id: string; display_name: string }>(supabase, {
    table: 'audience_members',
    select: 'id, display_name',
    inColumn: 'id',
    inValues: memberIds,
  })

  if (memberIds.length > 0 && (audienceMembers || []).length === 0) {
    console.log("REPEATED AUDIENCE MEMBERS ERROR: fetched 0 rows for", memberIds.length, "member IDs")
  }

  const memberMap = new Map((audienceMembers || []).map(m => [m.id, m.display_name || 'Unknown']))

  console.log("REPEATED DEBUG - memberIds count:", memberIds.length)
  console.log("REPEATED DEBUG - audienceMembers count:", audienceMembers?.length || 0)
  console.log("REPEATED DEBUG - sample audienceMembers:", JSON.stringify(audienceMembers?.slice(0, 3), null, 2))
  console.log("REPEATED DEBUG - sample memberMap entries:", Array.from(memberMap.entries()).slice(0, 3))
  console.log("REPEATED DEBUG - repeatedGroups count:", repeatedGroups.length)
  if (repeatedGroups.length > 0) {
    const firstGroup = repeatedGroups[0]
    console.log("REPEATED DEBUG - first group uniqueMembers:", Array.from(firstGroup.uniqueMembers))
    console.log("REPEATED DEBUG - first group memberPostIds:", Array.from(firstGroup.memberPostIds.entries()))
    const exampleMemberId = Array.from(firstGroup.uniqueMembers)[0]
    console.log("REPEATED DEBUG - example lookup for memberId:", exampleMemberId, "=>", memberMap.get(exampleMemberId))
  }

  const postIdsSet = new Set(allCommentRows.map(c => c.post_id))
  const { data: postsData } = await supabase
    .from('posts')
    .select('id, title')
    .in('id', Array.from(postIdsSet))
  const postMap = new Map((postsData || []).map(p => [p.id, p.title]))

  return (
    <div className="mx-auto max-w-3xl p-6">
      <PageHeader title="Repeated Comments" backHref="/dashboard/inbox" backLabel="My Videos" />

      {repeatedGroups.length === 0 ? (
        <p className="text-text-muted">No repeated comments found across different audience members.</p>
      ) : (
        <div className="space-y-6">
          {repeatedGroups.map((group, index) => (
            <div key={index} className="card">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <p className="font-body font-medium text-sm text-text-primary">
                    &ldquo;{group.originalText}&rdquo;
                  </p>
                  <p className="mt-1 text-xs text-text-muted">
                    Repeated {group.count} times across {group.uniqueMembers.size} people
                  </p>
                </div>
                <span className="badge badge-purchase_intent">
                  Repeated {group.count}x
                </span>
              </div>

              <div className="mt-4 space-y-2">
                {Array.from(group.uniqueMembers).map(memberId => {
                  const displayName = memberMap.get(memberId) || 'Unknown'
                  const postId = group.memberPostIds.get(memberId)
                  const postTitle = postId ? postMap.get(postId) : null
                  return (
                    <div key={memberId} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <Avatar name={displayName} size={24} />
                        <span className="text-text-primary">{displayName}</span>
                      </div>
                      {postTitle && (
                        <Link href={`/dashboard/inbox/${postId}`} className="text-xs text-text-muted underline hover:text-text-primary">
                          {postTitle}
                        </Link>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
