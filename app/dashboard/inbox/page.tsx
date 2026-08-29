import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { fetchInBatches } from '@/lib/supabase-helpers'
import PageHeader from '@/components/PageHeader'

export const dynamic = 'force-dynamic'

export default async function InboxPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: creator, error: creatorError } = await supabase
    .from('creators')
    .select('id')
    .eq('user_id', user.id)
    .single()

  if (creatorError || !creator) {
    redirect('/login')
  }

  const { data: posts, error: postsError } = await supabase
    .from('posts')
    .select('id, title, ingested_at')
    .eq('creator_id', creator.id)
    .order('ingested_at', { ascending: false })

  if (postsError) {
    console.error('Posts fetch error:', JSON.stringify(postsError, Object.getOwnPropertyNames(postsError), 2))
    return (
      <div className="p-6">
        <p className="text-red-500">Failed to load posts</p>
      </div>
    )
  }

  const postList = posts || []
  const postIds = postList.map(p => p.id)

  console.log("MY VIDEOS DEBUG - total posts:", postList.length, "postIds:", postIds)

  let totalCounts: Record<string, number> = {}
  let categorizedCounts: Record<string, number> = {}

  if (postIds.length > 0) {
    const allCommentRows: Array<{ id: string; post_id: string }> = []
    let offset = 0
    const batchSize = 1000
    let hasMore = true

    while (hasMore) {
      const { data: batch, error: commentsError } = await supabase
        .from('comments')
        .select('id, post_id')
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

    const commentRows = allCommentRows

    console.log("MY VIDEOS DEBUG - total commentRows:", commentRows.length)

    const commentIds = commentRows.map(c => c.id)

    for (const row of commentRows) {
      totalCounts[row.post_id] = (totalCounts[row.post_id] || 0) + 1
    }

    const debugPostIds = ['ba59207a-99a6-4e5c-b155-60de5da84e92', 'ddd5fe06-5fc8-49e6-8588-6b444ce4dcf3']
    for (const postId of debugPostIds) {
      const commentCount = commentRows.filter(c => c.post_id === postId).length
      console.log("MY VIDEOS DEBUG - post:", postId, "commentCount query result:", commentCount)
    }

    if (commentIds.length > 0) {
      const categoryRows = await fetchInBatches<{ comment_id: string }>(supabase, {
        table: 'comment_categories',
        select: 'comment_id',
        inColumn: 'comment_id',
        inValues: commentIds,
      })

      const categorizedIds = new Set((categoryRows || []).map(c => c.comment_id))

      console.log('Inbox debug - commentIds sample:', commentIds.slice(0, 5))
      console.log('Inbox debug - categoryRows sample:', categoryRows?.slice(0, 5))
      console.log('Inbox debug - categorizedIds set size:', categorizedIds.size)
      console.log('Inbox debug - matches:', commentIds.filter(id => categorizedIds.has(id)).length)

      for (const row of commentRows || []) {
        if (categorizedIds.has(row.id)) {
          categorizedCounts[row.post_id] = (categorizedCounts[row.post_id] || 0) + 1
        }
      }
    }
  }

  return (
    <div>
      <PageHeader title="My Videos" />

      {postList.length === 0 ? (
        <p className="text-text-muted">No videos yet. Connect a channel or paste a single video link to get started.</p>
      ) : (
        <ul className="space-y-3">
          {postList.map(post => {
            const total = totalCounts[post.id] || 0
            const categorized = categorizedCounts[post.id] || 0

             return (
               <li key={post.id} className="card">
                 <Link href={`/dashboard/inbox/${post.id}`} className="block">
                   <h2 className="font-body font-medium text-text-primary">{post.title}</h2>
                   <p className="mt-1 text-sm text-text-muted">
                     {total > 0 ? `${categorized}/${total} categorized` : '0 comments'}
                   </p>
                 </Link>
               </li>
             )
          })}
        </ul>
      )}
    </div>
  )
}
