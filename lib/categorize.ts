import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

export type ProgressCallback = (count: number) => void

const DRAFT_REPLY_INSTRUCTIONS: Record<string, string> = {
  purchase_intent:
    'Write a brief (2-3 sentence), warm, professional reply that acknowledges their interest and invites next steps.',
  question:
    "Write a brief, helpful, direct answer or acknowledgment to this question, in the creator's voice, 2-3 sentences.",
  complaint:
    'Write a brief, empathetic, professional response acknowledging this concern, 2-3 sentences, without being defensive.',
}

export type BusinessProfile = {
  business_phone: string | null
  business_whatsapp: string | null
  business_location: string | null
  business_hours: string | null
  business_website: string | null
  delivery_info: string | null
}

export const BUSINESS_PROFILE_COLUMNS =
  'business_phone, business_whatsapp, business_location, business_hours, business_website, delivery_info'

// Categories where real business facts are likely to be what the person actually
// wants. Complaints deliberately stay out of this — their drafted replies are
// meant to acknowledge a concern, not quote opening hours at someone.
const PROFILE_AWARE_CATEGORIES = new Set(['question', 'purchase_intent'])

// Builds the profile context from ONLY the fields the creator has actually filled
// in, so the model is never told about a field that's blank. Returns '' when the
// profile is missing or entirely empty, leaving the original prompt untouched.
function buildProfileContext(profile: BusinessProfile | null | undefined): string {
  if (!profile) return ''

  const parts: string[] = []
  if (profile.business_phone) parts.push(`phone: ${profile.business_phone}`)
  if (profile.business_whatsapp) parts.push(`WhatsApp: ${profile.business_whatsapp}`)
  if (profile.business_location) parts.push(`location: ${profile.business_location}`)
  if (profile.business_hours) parts.push(`hours: ${profile.business_hours}`)
  if (profile.business_website) parts.push(`website: ${profile.business_website}`)
  if (profile.delivery_info) parts.push(`delivery: ${profile.delivery_info}`)

  if (parts.length === 0) return ''

  return ` The business's real, verified details — ${parts.join('; ')}. If the customer's question directly matches one of these (asking for contact, location, hours, delivery), include the ACTUAL real answer in your drafted reply rather than a generic "please reach out" response. Only state details listed above — never invent, guess, or approximate any detail that isn't listed, and don't imply one exists. If the question doesn't match any of this profile data, draft a reply as before.`
}

/** One past correction: what the agent drafted, and what the creator actually sent. */
export type StyleExample = {
  draft: string
  final: string
}

export const MAX_STYLE_EXAMPLES = 5
/** Long edits are usually a rewrite of the substance, not a style signal; and five
 *  of them would crowd out the actual comment being replied to. */
const STYLE_EXAMPLE_MAX_CHARS = 400

/**
 * The creator's most recent edited replies, newest first, for use as few-shot style
 * examples.
 *
 * Scoped through the join chain comment_categories → comments → posts.creator_id
 * with `!inner`, so the database returns only this creator's rows — another
 * creator's edit history is never fetched, not merely filtered out afterwards.
 *
 * Returns [] on any error: style calibration is a nice-to-have, and a failure here
 * must not stop a draft from being written.
 */
export async function loadStyleExamples(
  supabase: SupabaseClient,
  creatorId: string,
  limit: number = MAX_STYLE_EXAMPLES
): Promise<StyleExample[]> {
  const { data, error } = await supabase
    .from('comment_categories')
    .select('draft_reply, final_reply_text, draft_reply_approved_at, comments!inner ( posts!inner ( creator_id ) )')
    .eq('comments.posts.creator_id', creatorId)
    .eq('reply_was_edited', true)
    .not('final_reply_text', 'is', null)
    .not('draft_reply', 'is', null)
    .order('draft_reply_approved_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('Style examples fetch error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
    return []
  }

  type Row = { draft_reply: string | null; final_reply_text: string | null }

  return ((data || []) as unknown as Row[])
    .map((row): StyleExample => ({
      draft: row.draft_reply?.trim() || '',
      final: row.final_reply_text?.trim() || '',
    }))
    .filter(
      (example: StyleExample) =>
        example.draft.length > 0 &&
        example.final.length > 0 &&
        // A row where the two are identical carries no signal about anything the
        // creator changed, whatever the stored flag says.
        example.draft !== example.final &&
        example.draft.length <= STYLE_EXAMPLE_MAX_CHARS &&
        example.final.length <= STYLE_EXAMPLE_MAX_CHARS
    )
}

// Few-shot block showing how this creator has previously rewritten drafts. Returns
// '' when there are no examples, so a new creator's prompt is byte-for-byte what it
// was before this feature existed — no "0 examples", no empty heading.
function buildStyleContext(examples: StyleExample[] | null | undefined): string {
  if (!examples || examples.length === 0) return ''

  const rendered = examples
    .map(
      (example, i) =>
        `Example ${i + 1} — AI drafted: '${example.draft}' → Creator actually sent: '${example.final}'`
    )
    .join('\n')

  return `\n\nHere's how this creator has previously adjusted AI-drafted replies to better match their voice — learn from the pattern of changes:\n${rendered}\nMatch this creator's tone, phrasing style, and any consistent adjustments they tend to make, based on these examples. Do not copy the specific facts from these examples — only the voice.`
}

export async function generateDraftReply(
  commentText: string,
  category: string,
  profile?: BusinessProfile | null,
  styleExamples?: StyleExample[] | null
): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)

  try {
    const instruction = DRAFT_REPLY_INSTRUCTIONS[category] ?? DRAFT_REPLY_INSTRUCTIONS.purchase_intent
    const profileContext = PROFILE_AWARE_CATEGORIES.has(category) ? buildProfileContext(profile) : ''
    // Style applies to every category: how someone signs off or phrases things is
    // not specific to questions or purchase intent the way business facts are.
    const styleContext = buildStyleContext(styleExamples)
    const prompt = `You are drafting a short, professional reply from a content creator to an audience member. Their comment: '${commentText}'.${profileContext} ${instruction} Respond with ONLY the reply text, no preamble.${styleContext}`

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

// Cheap pre-check before spending a full draft-reply call on a question/complaint:
// skips drafting for casual/off-topic comments (upload schedule, chit-chat) so only
// genuine business inquiries get a reply drafted. Fails closed (treats errors as
// "not business") since a missed draft is a much smaller cost than a wrong one, and
// the caller's own try/catch still protects the rest of the categorization run.
export async function isBusinessRelevant(
  commentText: string,
  postTitle: string,
  postDescription: string
): Promise<boolean> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)

  try {
    const prompt = `This comment is a question on a video titled '${postTitle}' with description '${postDescription}'. Question: '${commentText}'. Is this a genuine business/customer inquiry (about products, pricing, delivery, availability, wholesale, collaboration, or the creator's actual work/services) or a casual/off-topic question (upload schedule, personal chit-chat, unrelated small talk)? Respond with ONLY 'business' or 'casual'.`

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`)
    }

    const data = await response.json()
    const content = data.content?.[0]?.text?.trim().toLowerCase()

    return content === 'business'
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.error('Relevance check error: request timed out after 15s')
    } else {
      console.error('Relevance check error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    }
    return false
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
  const draftableCategories = new Set(['purchase_intent', 'question', 'complaint'])
  // purchase_intent is inherently business-relevant by definition and skips the
  // check; question and complaint get the relevance check first since both can be
  // casual (a joking complaint, an off-topic question) rather than genuine business.
  const relevanceCheckCategories = new Set(['question', 'complaint'])
  const draftable = categorized.filter(c => draftableCategories.has(c.category))

  let postTitle = ''
  let postDescription = ''
  let businessProfile: BusinessProfile | null = null
  let styleExamples: StyleExample[] = []

  // One post fetch covers both needs: title/description for the relevance check,
  // and creator_id so the business profile can be looked up below.
  if (draftable.length > 0) {
    const { data: post, error: postFetchError } = await supabase
      .from('posts')
      .select('title, content, creator_id')
      .eq('id', post_id)
      .single()

    if (postFetchError) {
      console.error('Fetch post metadata error:', JSON.stringify(postFetchError, Object.getOwnPropertyNames(postFetchError), 2))
    } else if (post) {
      postTitle = post.title || ''
      postDescription = post.content || ''

      // Once per post, not per comment. Unlike the business profile this applies to
      // every draftable category, since voice isn't category-specific.
      if (post.creator_id) {
        styleExamples = await loadStyleExamples(supabase, post.creator_id)
        if (styleExamples.length > 0) {
          console.log(`Categorize: applying ${styleExamples.length} style example(s) from past edits.`)
        }
      }

      // Fetched once per run, not per comment — and only when there's actually a
      // question or purchase_intent draft that could use it.
      if (post.creator_id && draftable.some(c => PROFILE_AWARE_CATEGORIES.has(c.category))) {
        const { data: creator, error: profileError } = await supabase
          .from('creators')
          .select(BUSINESS_PROFILE_COLUMNS)
          .eq('id', post.creator_id)
          .single()

        if (profileError) {
          console.error('Fetch business profile error:', JSON.stringify(profileError, Object.getOwnPropertyNames(profileError), 2))
        } else if (creator) {
          businessProfile = creator as unknown as BusinessProfile
        }
      }
    }
  }

  for (const comment of draftable) {
    const text = uncategorizedTextMap.get(comment.id)
    if (!text) continue

    try {
      if (relevanceCheckCategories.has(comment.category)) {
        const isRelevant = await isBusinessRelevant(text, postTitle, postDescription)
        if (!isRelevant) continue
      }

      const draftReply = await generateDraftReply(text, comment.category, businessProfile, styleExamples)
      await supabase
        .from('comment_categories')
        .update({ draft_reply: draftReply, draft_reply_created_at: new Date().toISOString() })
        .eq('comment_id', comment.id)
    } catch (err) {
      console.error('Draft reply error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    }
  }

  return { success: true, categorized: categorized.length }
}
