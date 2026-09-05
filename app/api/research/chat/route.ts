import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { fetchInBatches } from '@/lib/supabase-helpers'

function normalizeText(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ')
}

export async function POST(request: NextRequest) {
  try {
    const { creator_id, message, conversation_history } = await request.json()

    if (!creator_id || !message) {
      return NextResponse.json({ error: 'Missing creator_id or message' }, { status: 400 })
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

    // Unlike /api/ask, this route verifies the caller actually owns creator_id
    // before handing back aggregated audience data.
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { data: creator } = await supabase
      .from('creators')
      .select('id')
      .eq('id', creator_id)
      .eq('user_id', user.id)
      .single()

    if (!creator) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { data: posts, error: postsError } = await supabase
      .from('posts')
      .select('id, title')
      .eq('creator_id', creator_id)

    if (postsError) {
      console.error('Research posts fetch error:', JSON.stringify(postsError, Object.getOwnPropertyNames(postsError), 2))
      return NextResponse.json({ error: 'Failed to fetch posts' }, { status: 500 })
    }

    const postList = posts || []
    const postIds = postList.map(p => p.id)
    const postMap = new Map(postList.map(p => [p.id, p.title]))

    const comments: Array<{ id: string; text: string; post_id: string; audience_member_id: string | null }> = []

    if (postIds.length > 0) {
      let offset = 0
      const batchSize = 1000
      let hasMore = true

      while (hasMore) {
        const { data: batch, error: commentsError } = await supabase
          .from('comments')
          .select('id, text, post_id, audience_member_id')
          .in('post_id', postIds)
          .range(offset, offset + batchSize - 1)

        if (commentsError) {
          console.error('Research comments fetch error:', JSON.stringify(commentsError, Object.getOwnPropertyNames(commentsError), 2))
          break
        }

        if (batch && batch.length > 0) {
          comments.push(...batch)
          offset += batchSize
        }

        if (!batch || batch.length < batchSize) {
          hasMore = false
        }
      }
    }

    const commentIds = comments.map(c => c.id)

    let commentCategories: Array<{ comment_id: string; category: string; topic: string | null }> = []

    if (commentIds.length > 0) {
      commentCategories = await fetchInBatches<{ comment_id: string; category: string; topic: string | null }>(supabase, {
        table: 'comment_categories',
        select: 'comment_id, category, topic',
        inColumn: 'comment_id',
        inValues: commentIds,
      })
    }

    const commentsMap = new Map(comments.map(c => [c.id, c]))
    const categorizedComments = commentCategories
      .filter(cat => commentsMap.has(cat.comment_id))
      .map(cat => ({
        category: cat.category,
        topic: cat.topic,
        text: commentsMap.get(cat.comment_id)!.text,
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

    const prioritized = categorizedComments.filter(c => c.category === 'purchase_intent' || c.category === 'complaint')
    const others = categorizedComments.filter(c => c.category !== 'purchase_intent' && c.category !== 'complaint')

    const sampleSize = 20
    const sample = [
      ...prioritized.slice(0, Math.min(prioritized.length, sampleSize)),
      ...others.slice(0, Math.max(0, sampleSize - Math.min(prioritized.length, sampleSize))),
    ].slice(0, sampleSize)

    // --- Repeated/trending comment groups — same normalize-and-group approach as
    // the Repeated Comments page, but correctly scoped to this creator's own
    // comments (the original page has no creator_id filter at all) ---
    const normalizedGroups = new Map<string, Array<{ text: string; postId: string; audienceMemberId: string | null }>>()
    for (const comment of comments) {
      const key = normalizeText(comment.text)
      const existing = normalizedGroups.get(key) || []
      existing.push({ text: comment.text, postId: comment.post_id, audienceMemberId: comment.audience_member_id })
      normalizedGroups.set(key, existing)
    }

    const repeatedGroups: Array<{ text: string; count: number; uniquePeople: number; videoTitles: string[] }> = []
    for (const entries of normalizedGroups.values()) {
      const uniqueMembers = new Set(entries.map(e => e.audienceMemberId).filter(Boolean))
      if (uniqueMembers.size < 2) continue

      const videoTitles = Array.from(new Set(entries.map(e => postMap.get(e.postId) || 'Untitled video')))
      repeatedGroups.push({ text: entries[0].text, count: entries.length, uniquePeople: uniqueMembers.size, videoTitles })
    }
    repeatedGroups.sort((a, b) => b.count - a.count)
    const topRepeated = repeatedGroups.slice(0, 10)

    // --- Audience profile summaries, where available ---
    const { data: profiledMembers, error: profilesError } = await supabase
      .from('audience_members')
      .select('display_name, profile_summary')
      .eq('creator_id', creator_id)
      .not('profile_summary', 'is', null)
      .limit(20)

    if (profilesError) {
      console.error('Research profiles fetch error:', JSON.stringify(profilesError, Object.getOwnPropertyNames(profilesError), 2))
    }

    const categoryCountsStr = Object.entries(categoryCounts).map(([cat, count]) => `${cat}: ${count}`).join(', ') || 'none yet'
    const topTopicsStr = topTopics.map(([topic, count]) => `${topic}: ${count}`).join(', ') || 'none yet'
    const sampleStr = sample.map(c => `"${c.text}"`).join('\n') || 'none yet'
    const repeatedStr = topRepeated.length > 0
      ? topRepeated.map(g => `"${g.text}" (said by ${g.uniquePeople} different people, ${g.count} times total, on: ${g.videoTitles.join(', ')})`).join('\n')
      : 'none found'
    const profilesStr = (profiledMembers || []).length > 0
      ? (profiledMembers || []).map(m => `${m.display_name}: ${m.profile_summary}`).join('\n')
      : 'none built up yet'

    const systemPrompt = `You are an audience research assistant helping a content creator understand their audience. You have this aggregated data about their comments across all their videos:

Category counts: ${categoryCountsStr}
Top topics (with mention counts): ${topTopicsStr}
Repeated/trending comments (the same thing said by multiple different people): ${repeatedStr}
What we know about specific engaged audience members: ${profilesStr}
A sample of real comments: ${sampleStr}

Have a natural, conversational multi-turn discussion with the creator. Reference specific numbers and patterns from this data where relevant. Keep answers concise (2-5 sentences), no markdown formatting.`

    const history: Array<{ role: string; content: string }> = Array.isArray(conversation_history)
      ? conversation_history
          .filter((m: unknown): m is { role: string; content: string } =>
            !!m &&
            typeof m === 'object' &&
            ((m as Record<string, unknown>).role === 'user' || (m as Record<string, unknown>).role === 'assistant') &&
            typeof (m as Record<string, unknown>).content === 'string'
          )
          .slice(-20)
      : []

    const anthropicMessages = [
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ]

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 20000)

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
          system: systemPrompt,
          messages: anthropicMessages,
        }),
        signal: controller.signal,
      })
    } catch (fetchErr) {
      clearTimeout(timeoutId)
      if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
        console.error('Research chat error: request timed out after 20s')
        return NextResponse.json({ error: 'Request timed out' }, { status: 504 })
      }
      throw fetchErr
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`)
    }

    const data = await response.json()
    const reply = data.content?.[0]?.text

    if (!reply) {
      throw new Error('Empty response from Anthropic')
    }

    return NextResponse.json({ success: true, reply })
  } catch (err) {
    console.error('Research chat error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
