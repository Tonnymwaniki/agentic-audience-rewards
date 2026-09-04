import { createServiceClient } from '@/lib/supabase/service'

export async function updateAudienceProfile(audience_member_id: string) {
  const supabase = createServiceClient()

  const { data: comments, error: commentsError } = await supabase
    .from('comments')
    .select('text, comment_categories (category, topic)')
    .eq('audience_member_id', audience_member_id)

  if (commentsError) {
    console.error('Audience profile comments fetch error:', JSON.stringify(commentsError, Object.getOwnPropertyNames(commentsError), 2))
    throw new Error('Failed to fetch comments for audience profile')
  }

  if (!comments || comments.length < 2) {
    return { success: true, updated: false }
  }

  const commentSummaries = comments.map(c => {
    const category = c.comment_categories as unknown as { category: string; topic: string | null } | null
    return {
      text: c.text,
      category: category?.category || 'other',
      topic: category?.topic || null,
    }
  })

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)

  try {
    const prompt = `Summarize this audience member's engagement pattern in 2-3 sentences: what topics they care about, their tone, and any notable behavior (loyal, business-interested, skeptical, etc.). Their comments: ${JSON.stringify(commentSummaries)}. Respond with ONLY the summary text, no preamble.`

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
          max_tokens: 256,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      })
    } catch (fetchErr) {
      if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
        console.error('Audience profile error: request timed out after 15s')
      } else {
        console.error('Audience profile fetch error:', JSON.stringify(fetchErr, Object.getOwnPropertyNames(fetchErr), 2))
      }
      return { success: false, updated: false }
    }

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`)
    }

    const data = await response.json()
    const summary = data.content?.[0]?.text?.trim()

    if (!summary) {
      throw new Error('Empty response from Anthropic')
    }

    const { error: updateError } = await supabase
      .from('audience_members')
      .update({ profile_summary: summary, profile_updated_at: new Date().toISOString() })
      .eq('id', audience_member_id)

    if (updateError) {
      console.error('Audience profile update error:', JSON.stringify(updateError, Object.getOwnPropertyNames(updateError), 2))
      return { success: false, updated: false }
    }

    return { success: true, updated: true, summary }
  } catch (err) {
    console.error('Audience profile error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return { success: false, updated: false }
  } finally {
    clearTimeout(timeoutId)
  }
}
