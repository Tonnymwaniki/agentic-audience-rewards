import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { fetchVideoMeta, fetchVideoComments } from '@/lib/youtube'

export async function POST(request: NextRequest) {
  try {
    const { creator_id, youtube_url } = await request.json()

    if (!creator_id || !youtube_url) {
      return NextResponse.json(
        { error: 'Missing creator_id or youtube_url' },
        { status: 400 }
      )
    }

    const videoId = parseYouTubeVideoId(youtube_url)
    if (!videoId) {
      return NextResponse.json(
        { error: 'Invalid YouTube URL' },
        { status: 400 }
      )
    }

    const [meta, comments] = await Promise.all([
      fetchVideoMeta(videoId),
      fetchVideoComments(videoId),
    ])

    const cookieStore = await cookies()

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll() {},
        },
      }
    )

    const { data: platform, error: platformError } = await supabase
      .from('platforms')
      .select('id')
      .eq('name', 'youtube')
      .single()

    if (platformError || !platform) {
      return NextResponse.json(
        { error: 'YouTube platform not found in platforms table' },
        { status: 500 }
      )
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
      console.error('Post upsert error:', JSON.stringify(postError, null, 2))
      return NextResponse.json(
        { error: 'Failed to upsert post' },
        { status: 500 }
      )
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

    return NextResponse.json({
      success: true,
      postId,
      commentsIngested,
    })
  } catch (err) {
    console.error('Ingest error:', JSON.stringify(err, null, 2))
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
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
