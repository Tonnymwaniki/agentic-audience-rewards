import { createServiceClient } from '@/lib/supabase/service'

export type ProgressCallback = (count: number) => void

export async function generateDraftReply(commentText: string): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)

  try {
    const prompt = `You are drafting a short, professional reply from a content creator to an audience member who showed purchase intent or business interest. Their comment: '${commentText}'. Write a brief (2-3 sentence), warm, professional reply that acknowledges their interest and invites next steps. Respond with ONLY the reply text, no preamble.`

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
    const content = data.content?.[0]?.text

    if (!content) {
      throw new Error('Empty response from Anthropic')
    }

    return content.trim()
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function categorizeComments(
  comments: { id: string; text: string }[],
  onProgress?: ProgressCallback
) {
  const results: Array<{
    id: string
    category: string
    topic: string
    confidence: number
  }> = []

  const batchSize = 10

  for (let i = 0; i < comments.length; i += batchSize) {
    const batch = comments.slice(i, i + batchSize)
    const batchIds = new Set(batch.map(c => c.id))

    let batchResults = await processBatch(batch, batchIds, false)

    if (batchResults.length === 0) {
      batchResults = await processBatch(batch, batchIds, true)
    }

    if (batchResults.length === 0) {
      console.error('Categorize batch warning: zero valid results after retry, skipping batch')
    }

    results.push(...batchResults)
    onProgress?.(results.length)
  }

  return results
}

async function processBatch(
  batch: { id: string; text: string }[],
  batchIds: Set<string>,
  isRetry: boolean
) {
  const batchResults: Array<{
    id: string
    category: string
    topic: string
    confidence: number
  }> = []

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)

    const retrySuffix = isRetry
      ? '\n\nYour previous response was not valid JSON. Respond with ONLY the JSON array, nothing else.'
      : ''

    const prompt = `You are categorizing audience comments. For each comment, return its category (one of: question, praise, complaint, purchase_intent, spam, other) and a short topic tag. Treat Sheng/Swahili/English code-switched text as meaningful, not spam. Respond with ONLY a JSON array, no preamble, no markdown code fences, in this exact format: [{"id": "...", "category": "...", "topic": "...", "confidence": 0.0-1.0}]

Comments:
${JSON.stringify(batch)}${retrySuffix}`

    let response: Response
    try {
      response = await fetch(
        'https://api.anthropic.com/v1/messages',
        {
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
        }
      )
    } catch (fetchErr) {
      clearTimeout(timeoutId)
      if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
        console.error('Categorize batch error: request timed out after 15s')
      } else {
        console.error('Categorize batch error:', JSON.stringify(fetchErr, Object.getOwnPropertyNames(fetchErr), 2))
      }
      return batchResults
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`)
    }

    const data = await response.json()
    const content = data.content?.[0]?.text

    if (!content) {
      throw new Error('Empty response from Anthropic')
    }

    const match = content.match(/\[[\s\S]*\]/)
    if (!match) {
      throw new Error('No JSON array found in response')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(match[0])
    } catch (parseErr) {
      console.error('Categorize batch parse error:', JSON.stringify(parseErr, Object.getOwnPropertyNames(parseErr), 2))
      return batchResults
    }

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (
          typeof item === 'object' &&
          item !== null &&
          typeof item.id === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id) &&
          batchIds.has(item.id)
        ) {
          batchResults.push({
            id: item.id,
            category: String(item.category),
            topic: String(item.topic),
            confidence: typeof item.confidence === 'number' ? item.confidence : 0,
          })
        } else {
          console.error('Categorize batch warning: skipping invalid result', JSON.stringify(item, Object.getOwnPropertyNames(item), 2))
        }
      }
    }
  } catch (err) {
    console.error('Categorize batch error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
  }

  return batchResults
}

export async function categorizePost(post_id: string, onProgress?: ProgressCallback) {
  const supabase = createServiceClient()

  const { data: comments, error: commentsError } = await supabase
    .from('comments')
    .select('id, text')
    .eq('post_id', post_id)

  if (commentsError) {
    console.error('Fetch comments error:', JSON.stringify(commentsError, Object.getOwnPropertyNames(commentsError), 2))
    throw new Error('Failed to fetch comments')
  }

  if (!comments || comments.length === 0) {
    return { success: true, categorized: 0 }
  }

  const { data: existingCategories, error: categoriesError } = await supabase
    .from('comment_categories')
    .select('comment_id')

  if (categoriesError) {
    console.error('Fetch categories error:', JSON.stringify(categoriesError, Object.getOwnPropertyNames(categoriesError), 2))
    throw new Error('Failed to fetch existing categories')
  }

  const categorizedIds = new Set(
    existingCategories?.map(c => c.comment_id) || []
  )
  const uncategorized = comments.filter(c => !categorizedIds.has(c.id))

  if (uncategorized.length === 0) {
    return { success: true, categorized: 0 }
  }

  const categorized = await categorizeComments(uncategorized, onProgress)

  if (categorized.length === 0) {
    return { success: true, categorized: 0 }
  }

  const upsertData = categorized.map(c => ({
    comment_id: c.id,
    category: c.category,
    topic: c.topic,
    confidence: c.confidence,
  }))

  const { error: upsertError } = await supabase
    .from('comment_categories')
    .upsert(upsertData, { onConflict: 'comment_id' })

  if (upsertError) {
    console.error('Upsert categories error:', JSON.stringify(upsertError, Object.getOwnPropertyNames(upsertError), 2))
    throw new Error('Failed to upsert categories')
  }

  const uncategorizedTextMap = new Map(uncategorized.map(c => [c.id, c.text]))
  const purchaseIntents = categorized.filter(c => c.category === 'purchase_intent')

  for (const comment of purchaseIntents) {
    const text = uncategorizedTextMap.get(comment.id)
    if (!text) continue

    try {
      const draftReply = await generateDraftReply(text)
      await supabase
        .from('comment_categories')
        .update({ draft_reply: draftReply })
        .eq('comment_id', comment.id)
    } catch (err) {
      console.error('Draft reply error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    }
  }

  return { success: true, categorized: categorized.length }
}
