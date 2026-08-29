import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { fetchInBatches } from '@/lib/supabase-helpers'

export async function POST(request: NextRequest) {
  try {
    const { creator_id, question, post_id } = await request.json()

    if (!creator_id || !question) {
      return NextResponse.json(
        { error: 'Missing creator_id or question' },
        { status: 400 }
      )
    }

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

    const { data: posts, error: postsError } = await supabase
      .from('posts')
      .select('id, title')
      .eq('creator_id', creator_id)

    if (postsError) {
      console.error('Posts fetch error:', JSON.stringify(postsError, Object.getOwnPropertyNames(postsError), 2))
      return NextResponse.json(
        { error: 'Failed to fetch posts' },
        { status: 500 }
      )
    }

    const postList = posts || []
    const postIds = postList.map(p => p.id)

    let comments: Array<{ id: string; text: string; post_id: string }> = []
    let commentCategories: Array<{ comment_id: string; category: string; topic: string | null }> = []

    if (postIds.length > 0) {
      let commentQuery = supabase
        .from('comments')
        .select('id, text, post_id')

      if (post_id) {
        commentQuery = commentQuery.eq('post_id', post_id)
      } else {
        commentQuery = commentQuery.in('post_id', postIds)
      }

      const { data: commentRows, error: commentsError } = await commentQuery

      if (commentsError) {
        console.error('Comments fetch error:', JSON.stringify(commentsError, Object.getOwnPropertyNames(commentsError), 2))
        return NextResponse.json(
          { error: 'Failed to fetch comments' },
          { status: 500 }
        )
      }

      comments = commentRows || []

      const commentIds = comments.map(c => c.id)

      if (commentIds.length > 0) {
        const categoryRows = await fetchInBatches<{ comment_id: string; category: string; topic: string | null }>(supabase, {
          table: 'comment_categories',
          select: 'comment_id, category, topic',
          inColumn: 'comment_id',
          inValues: commentIds,
        })

        commentCategories = categoryRows
      }
    }

    const commentsMap = new Map(comments.map(c => [c.id, c]))
    const categoriesMap = new Map(commentCategories.map(c => [c.comment_id, c]))

    const categorizedComments = commentCategories
      .filter(cat => commentsMap.has(cat.comment_id))
      .map(cat => ({
        category: cat.category,
        topic: cat.topic,
        text: commentsMap.get(cat.comment_id)!.text,
        postId: commentsMap.get(cat.comment_id)!.post_id,
      }))

    const categoryCounts: Record<string, number> = {}
    const topicCounts: Record<string, number> = {}

    for (const item of categorizedComments) {
      categoryCounts[item.category] = (categoryCounts[item.category] || 0) + 1
      if (item.topic) {
        topicCounts[item.topic] = (topicCounts[item.topic] || 0) + 1
      }
    }

    const topTopics = Object.entries(topicCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)

    const prioritized = categorizedComments.filter(
      c => c.category === 'purchase_intent' || c.category === 'complaint'
    )
    const others = categorizedComments.filter(
      c => c.category !== 'purchase_intent' && c.category !== 'complaint'
    )

    const sampleSize = 20
    const sample = [
      ...prioritized.slice(0, Math.min(prioritized.length, sampleSize)),
      ...others.slice(0, Math.max(0, sampleSize - Math.min(prioritized.length, sampleSize))),
    ].slice(0, sampleSize)

    const categoryCountsStr = Object.entries(categoryCounts)
      .map(([cat, count]) => `${cat}: ${count}`)
      .join(', ')

    const topTopicsStr = topTopics
      .map(([topic, count]) => `${topic}: ${count}`)
      .join(', ')

    const sampleStr = sample.map(c => `"${c.text}"`).join('\n')

    const prompt = `You are analyzing a creator's audience comments. Here is aggregated data: Category counts: ${categoryCountsStr}. Top topics with counts: ${topTopicsStr}. A sample of real comments: ${sampleStr}. Answer this question from the creator based on this data: "${question}". Be specific and reference actual numbers/patterns from the data. Keep the answer to 2-4 sentences, conversational, no markdown formatting.`

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)

    let response: Response
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      })
    } catch (fetchErr) {
      clearTimeout(timeoutId)
      if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
        console.error('Ask error: request timed out after 15s')
        return NextResponse.json(
          { error: 'Request timed out' },
          { status: 504 }
        )
      }
      throw fetchErr
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`)
    }

    const data = await response.json()
    const answer = data.content?.[0]?.text

    if (!answer) {
      throw new Error('Empty response from Anthropic')
    }

    return NextResponse.json({
      success: true,
      answer,
    })
  } catch (err) {
    console.error('Ask error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
