import { createServiceClient } from '@/lib/supabase/service'

export async function updateAudienceProfile(audience_member_id: string) {
  console.log("AUDIENCE MEMORY: starting for member", audience_member_id)

  const supabase = createServiceClient()
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)

  try {
    const { data: comments, error: commentsError } = await supabase
      .from('comments')
      .select('text, comment_categories (category, topic)')
      .eq('audience_member_id', audience_member_id)

    if (commentsError) {
      throw commentsError
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

    const prompt = `Summarize this audience member's engagement pattern in 2-3 sentences: what topics they care about, their tone, and any notable behavior (loyal, business-interested, skeptical, etc.). Their comments: ${JSON.stringify(commentSummaries)}. Respond with ONLY the summary text, no preamble.`

    const response = await fetch('https://api.anthropic.com/v1/messages', {
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
      throw updateError
    }

    console.log("AUDIENCE MEMORY: successfully saved profile for", audience_member_id)

    return { success: true, updated: true, summary }
  } catch (error) {
    console.error("AUDIENCE MEMORY ERROR:", JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
    return { success: false, updated: false }
  } finally {
    clearTimeout(timeoutId)
  }
}
