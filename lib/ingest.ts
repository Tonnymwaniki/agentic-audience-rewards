import { createServiceClient } from '@/lib/supabase/service'
import { fetchVideoMeta, fetchVideoComments } from '@/lib/youtube'

export async function ingestYouTubeVideo(creator_id: string, youtube_url: string) {
  const videoId = parseYouTubeVideoId(youtube_url)
  if (!videoId) {
    throw new Error('Invalid YouTube URL')
  }

  const [meta, comments] = await Promise.all([
    fetchVideoMeta(videoId),
    fetchVideoComments(videoId),
  ])

  const supabase = createServiceClient()

  const { data: platform, error: platformError } = await supabase
    .from('platforms')
    .select('id')
    .eq('name', 'youtube')
    .single()

  if (platformError || !platform) {
    throw new Error('YouTube platform not found in platforms table')
  }

  const { data: post, error: postError } = await supabase
    .from('posts')
    .upsert(
      {
        platform_id: platform.id,
        creator_id,
        external_post_id: videoId,
        title: meta.title,
        content: meta.description,
      },
      {
        onConflict: 'platform_id, external_post_id',
      }
    )
    .select('id')
    .single()

  if (postError || !post) {
    throw new Error('Failed to upsert post')
  }

  const postId = post.id
  let commentsIngested = 0

  for (const comment of comments) {
    const { data: member, error: memberError } = await supabase
      .from('audience_members')
      .upsert(
        {
          platform_id: platform.id,
          external_id: comment.authorChannelId,
          display_name: comment.authorDisplayName,
          creator_id,
        },
        {
          onConflict: 'platform_id, external_id, creator_id',
        }
      )
      .select('id')
      .single()

    if (memberError || !member) {
      console.error('Member upsert error:', JSON.stringify(memberError, null, 2))
      continue
    }

    const { error: commentError } = await supabase
      .from('comments')
      .upsert(
        {
          post_id: postId,
          external_comment_id: comment.externalCommentId,
          audience_member_id: member.id,
          text: comment.text,
          posted_at: comment.publishedAt,
        },
        {
          onConflict: 'post_id, external_comment_id',
        }
      )

    if (commentError) {
      console.error('Comment upsert error:', JSON.stringify(commentError, null, 2))
    } else {
      commentsIngested++
    }
  }

  return { success: true, postId, commentsIngested }
}

function parseYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url)

    if (
      parsed.hostname === 'www.youtube.com' ||
      parsed.hostname === 'm.youtube.com'
    ) {
      return parsed.searchParams.get('v')
    }

    if (parsed.hostname === 'youtu.be') {
      return parsed.pathname.slice(1).split('/')[0] || null
    }

    return null
  } catch {
    return null
  }
}
