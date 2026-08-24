export async function categorizeComments(
  comments: { id: string; text: string }[]
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
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'openrouter/free',
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
      throw new Error(`OpenRouter API error: ${response.status}`)
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content

    if (!content) {
      throw new Error('Empty response from OpenRouter')
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
