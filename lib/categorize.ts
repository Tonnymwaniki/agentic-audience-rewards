import type { SupabaseClient } from '@supabase/supabase-js'
import { ENTITY_EXTRACTION_RULES, normalizeEntities } from '@/lib/entities'
import { loadCustomProfileFields, customFieldsToContext, type CustomProfileField } from '@/lib/custom-profile-fields'
import { applyFactStatusesForDrafts, loadFactStatuses } from '@/lib/profile-fact-status'
import { createServiceClient } from '@/lib/supabase/service'
import { fetchInBatches } from '@/lib/supabase-helpers'
import { normalizeConfidence, CONFIDENCE_PROMPT_GUIDANCE, type Confidence } from '@/lib/confidence'
import { normalizeEscalation, type EscalationType } from '@/lib/escalation'
import { logError, logWarn, logInfo } from '@/lib/logger'
import { checkPostVerification } from '@/lib/channel-verification'
import { recordAiUsage } from '@/lib/ai-usage'

export type ProgressCallback = (count: number) => void

/**
 * Swahili and Sheng are ONE value. Detection that tried to separate them was about
 * 50% accurate on this audience's comments across two prompts and a majority vote,
 * and the line is debatable even for a human reviewer — so the data can't support a
 * filter that distinguishes them. null means no detectable language (emoji, names,
 * timestamps, links, or another language entirely).
 */
export type CommentLanguage = 'english' | 'swahili_sheng' | 'mixed'
export const COMMENT_LANGUAGES: readonly CommentLanguage[] = ['english', 'swahili_sheng', 'mixed']

/**
 * The model's language value, or null for anything outside the three (including
 * "none"). The retired 'swahili' and 'sheng' values map to 'swahili_sheng', so an
 * old-style answer can never store a value the filter no longer accepts.
 */
export function normalizeLanguage(value: unknown): CommentLanguage | null {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (v === 'swahili' || v === 'sheng') return 'swahili_sheng'
  return (COMMENT_LANGUAGES as readonly string[]).includes(v) ? (v as CommentLanguage) : null
}

/** The classifier's own sentiment judgment, independent of the intent category. */
export type CommentSentiment = 'positive' | 'negative' | 'neutral' | 'mixed'
export const COMMENT_SENTIMENTS: readonly CommentSentiment[] = ['positive', 'negative', 'neutral', 'mixed']

/** The single strongest emotion in a comment; 'none' when it carries no real feeling. */
export type CommentEmotion =
  | 'anger'
  | 'joy'
  | 'sadness'
  | 'frustration'
  | 'excitement'
  | 'confusion'
  | 'sarcasm'
  | 'disappointment'
  | 'admiration'
  | 'fear'
  | 'none'
export const COMMENT_EMOTIONS: readonly CommentEmotion[] = [
  'anger',
  'joy',
  'sadness',
  'frustration',
  'excitement',
  'confusion',
  'sarcasm',
  'disappointment',
  'admiration',
  'fear',
  'none',
]

export function normalizeSentiment(value: unknown): CommentSentiment | null {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (COMMENT_SENTIMENTS as readonly string[]).includes(v) ? (v as CommentSentiment) : null
}

export function normalizeEmotion(value: unknown): CommentEmotion | null {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if ((COMMENT_EMOTIONS as readonly string[]).includes(v)) return v as CommentEmotion
  // Logged rather than silently dropped: an invented value ("skepticism") means the
  // comment ends up with no emotion at all, which is invisible in the data.
  if (v) console.warn(`Categorize: unrecognised emotion ${JSON.stringify(v)} — storing none`)
  return v ? 'none' : null
}

/** Most topics one comment can be tagged with. */
export const MAX_TOPICS_PER_COMMENT = 3

/**
 * The comment's topics, trimmed, lower-cased, de-duplicated and capped. A comment
 * about price AND delivery keeps both; `topic` below stays the first one.
 */
export function normalizeTopics(value: unknown, fallback?: unknown): string[] {
  const raw = Array.isArray(value) ? value : [fallback]
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const topic = item.trim().toLowerCase().replace(/\s+/g, '_')
    if (topic && !seen.has(topic)) seen.add(topic)
    if (seen.size === MAX_TOPICS_PER_COMMENT) break
  }
  return [...seen]
}

export type CategorizedComment = {
  id: string
  category: string
  /** The primary topic: topics[0], kept for anything reading a single topic. */
  topic: string
  /** Every topic the comment covers, most important first. */
  topics: string[]
  confidence: number
  /** Detected in the same call as the category; null when there's no language to detect. */
  language: CommentLanguage | null
  /** The classifier's own sentiment, not derived from the category. */
  sentiment: CommentSentiment | null
  /** The single strongest emotion, or 'none'. */
  emotion: CommentEmotion | null
  /**
   * Named brands/companies/products/organizations, canonical names (lib/entities).
   * [] = scanned, none mentioned; null = the model omitted the key (not scanned).
   */
  entities: string[] | null
  /** null = screened and clean, OR not screened — see escalationScreened. */
  escalation: EscalationType | null
  /** False when the model omitted the escalation key entirely. */
  escalationScreened: boolean
}

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
function buildProfileContext(
  profile: BusinessProfile | null | undefined,
  customFields: string[] = [],
  uncertainFacts: string[] = []
): string {
  // Profile facts customers are currently disputing (lib/profile-fact-status.ts):
  // offered as context, explicitly NOT as fact, so a draft never asserts a value
  // several people are saying is wrong.
  const uncertainNote = uncertainFacts.length
    ? ` UNCERTAIN details — customers have recently reported something different, so do NOT state these as fact: ${uncertainFacts.join('; ')}. If the question is about one of these, say you'll confirm the current details rather than quoting either version.`
    : ''
  if (!profile && customFields.length === 0) return uncertainNote

  const parts: string[] = []
  if (profile?.business_phone) parts.push(`phone: ${profile.business_phone}`)
  if (profile?.business_whatsapp) parts.push(`WhatsApp: ${profile.business_whatsapp}`)
  if (profile?.business_location) parts.push(`location: ${profile.business_location}`)
  if (profile?.business_hours) parts.push(`hours: ${profile.business_hours}`)
  if (profile?.business_website) parts.push(`website: ${profile.business_website}`)
  if (profile?.delivery_info) parts.push(`delivery: ${profile.delivery_info}`)

  // The creator's AI-suggested fields, already "Label: value" and already filtered
  // to the ones they actually filled in. Added to the same list on purpose: the
  // model should treat "Wholesale minimum order" exactly as it treats "hours" —
  // a real verified fact it may quote, and must not invent.
  for (const pair of customFields) parts.push(pair)

  if (parts.length === 0) return uncertainNote

  return `${uncertainNote} The business's real, verified details — ${parts.join('; ')}. If the customer's question directly matches one of these (asking for contact, location, hours, delivery), include the ACTUAL real answer in your drafted reply rather than a generic "please reach out" response. Only state details listed above — never invent, guess, or approximate any detail that isn't listed, and don't imply one exists. If the question doesn't match any of this profile data, draft a reply as before.`
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
    logError('categorize.loadStyleExamples', error, { creator_id: creatorId })
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

export type DraftReplyResult = {
  text: string
  /** null when the model omitted it or returned something unrecognised. */
  confidence: Confidence | null
}

/**
 * One retry, so a single dropped connection or momentary Anthropic hiccup doesn't
 * turn into a silently-missing draft on a genuine question. Not a loop: a second
 * consecutive failure is much more likely to be a real outage than bad luck, and
 * retrying indefinitely would just make one bad comment stall a whole batch.
 */
export async function generateDraftReply(
  commentText: string,
  category: string,
  profile?: BusinessProfile | null,
  styleExamples?: StyleExample[] | null,
  customFields?: string[] | null,
  uncertainFacts?: string[] | null,
  usageCtx?: { supabase: SupabaseClient; creatorId: string; postId?: string | null } | null
): Promise<DraftReplyResult> {
  try {
    return await generateDraftReplyOnce(commentText, category, profile, styleExamples, customFields, uncertainFacts, usageCtx)
  } catch (err) {
    logWarn('categorize.generateDraftReply', 'First attempt failed; retrying once', {
      category,
      reason: err instanceof Error ? err.message : String(err),
    })
    return generateDraftReplyOnce(commentText, category, profile, styleExamples, customFields, uncertainFacts, usageCtx)
  }
}

async function generateDraftReplyOnce(
  commentText: string,
  category: string,
  profile?: BusinessProfile | null,
  styleExamples?: StyleExample[] | null,
  customFields?: string[] | null,
  /** Contradicted profile facts, from applyFactStatusesForDrafts — never stated as fact. */
  uncertainFacts?: string[] | null,
  /** For AI-spend attribution (lib/ai-usage.ts) — optional so tests/direct calls don't need it. */
  usageCtx?: { supabase: SupabaseClient; creatorId: string; postId?: string | null } | null
): Promise<DraftReplyResult> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)

  try {
    const instruction = DRAFT_REPLY_INSTRUCTIONS[category] ?? DRAFT_REPLY_INSTRUCTIONS.purchase_intent
    const profileContext = PROFILE_AWARE_CATEGORIES.has(category)
      ? buildProfileContext(profile, customFields ?? [], uncertainFacts ?? [])
      : ''
    // Style applies to every category: how someone signs off or phrases things is
    // not specific to questions or purchase intent the way business facts are.
    const styleContext = buildStyleContext(styleExamples)
    // JSON rather than bare text now, so the model can report how sure it is about
    // the reply alongside the reply itself.
    const prompt = `You are drafting a short, professional reply from a content creator to an audience member. Their comment: '${commentText}'.${profileContext} ${instruction}${styleContext}

Respond with ONLY valid JSON, no preamble: {"reply": "the reply text", "confidence": "high" or "medium" or "low"}

On confidence: ${CONFIDENCE_PROMPT_GUIDANCE} For a drafted reply, "high" means the comment is unambiguous and you have the facts needed to answer it; "low" means you had to guess at what they meant or answered without the details that would make the reply accurate.`

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

    if (usageCtx) {
      recordAiUsage(usageCtx.supabase, {
        creatorId: usageCtx.creatorId,
        feature: 'draft_reply',
        model: 'claude-haiku-4-5-20251001',
        usage: data.usage,
        postId: usageCtx.postId,
      })
    }

    if (!content) {
      throw new Error('Empty response from Anthropic')
    }

    // Falls back to the raw text when the model ignores the JSON instruction — a
    // usable reply with no confidence beats discarding the draft entirely.
    const match = content.match(/\{[\s\S]*\}/)
    if (!match) {
      return { text: content.trim(), confidence: null }
    }

    try {
      const parsed = JSON.parse(match[0])
      const text = typeof parsed.reply === 'string' ? parsed.reply.trim() : ''
      if (!text) return { text: content.trim(), confidence: null }
      return { text, confidence: normalizeConfidence(parsed.confidence) }
    } catch {
      return { text: content.trim(), confidence: null }
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

export type RelevanceResult = {
  relevant: boolean
  /** True when the check itself errored/timed out, so `relevant: false` was a
   * fail-closed default rather than an actual "this is casual" judgment — callers
   * use this to record draft_skip_reason accurately instead of both cases looking
   * like the same intentional filter. */
  checkFailed: boolean
}

// Cheap pre-check before spending a full draft-reply call on a question/complaint:
// skips drafting for casual/off-topic comments (upload schedule, chit-chat) so only
// genuine business inquiries get a reply drafted. Fails closed (treats errors as
// "not business") since a missed draft is a much smaller cost than a wrong one, and
// the caller's own try/catch still protects the rest of the categorization run.
export async function isBusinessRelevant(
  commentText: string,
  postTitle: string,
  postDescription: string,
  usageCtx?: { supabase: SupabaseClient; creatorId: string; postId?: string | null } | null
): Promise<RelevanceResult> {
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

    if (usageCtx) {
      recordAiUsage(usageCtx.supabase, {
        creatorId: usageCtx.creatorId,
        feature: 'business_relevance',
        model: 'claude-haiku-4-5-20251001',
        usage: data.usage,
        postId: usageCtx.postId,
      })
    }

    return { relevant: content === 'business', checkFailed: false }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      logWarn('categorize.isBusinessRelevant', 'Relevance check timed out after 15s', { post_title: postTitle })
    } else {
      logError('categorize.isBusinessRelevant', err, { post_title: postTitle })
    }
    return { relevant: false, checkFailed: true }
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function categorizeComments(
  comments: { id: string; text: string }[],
  onProgress?: ProgressCallback,
  usageCtx?: { supabase: SupabaseClient; creatorId: string; postId?: string | null } | null
) {
  const results: Array<CategorizedComment> = []

  const batchSize = 10

  for (let i = 0; i < comments.length; i += batchSize) {
    const batch = comments.slice(i, i + batchSize)
    const batchIds = new Set(batch.map(c => c.id))

    let batchResults = await processBatch(batch, batchIds, false, usageCtx)

    if (batchResults.length === 0) {
      batchResults = await processBatch(batch, batchIds, true, usageCtx)
    }

    if (batchResults.length === 0) {
      logWarn('categorize.batch', 'Zero valid results after retry; skipping batch', { batch_size: batch.length })
    }

    results.push(...batchResults)
    onProgress?.(results.length)
  }

  return results
}

async function processBatch(
  batch: { id: string; text: string }[],
  batchIds: Set<string>,
  isRetry: boolean,
  usageCtx?: { supabase: SupabaseClient; creatorId: string; postId?: string | null } | null
) {
  const batchResults: Array<CategorizedComment> = []

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)

    const retrySuffix = isRetry
      ? '\n\nYour previous response was not valid JSON. Respond with ONLY the JSON array, nothing else.'
      : ''

    const prompt = `You are categorizing audience comments. For each comment, return its category and its topics. Treat Sheng/Swahili/English code-switched text as meaningful, not spam.

Categories — pick exactly one:
- "purchase_intent": GENUINE COMMERCIAL interest in the creator's business. The person wants to buy a product or service, asks about price, cost, stock or how to order, wants delivery of something they intend to buy, or wants to buy wholesale to resell. Asking for a phone or WhatsApp number in order to buy counts. Direction matters: someone asking the creator to sell or supply THEM ("can you sell me stock", "I want to buy in bulk") is purchase_intent; someone offering the creator THEIR OWN services, skills, supplies or a collaboration is NOT purchase_intent — that is content_request.
- "content_request": asks the creator to MAKE CONTENT — more videos like this, a specific topic, a part 2, a particular guest ("bring X on", "interview Y"), or the return of a show or format. Also use content_request when someone OFFERS to work with or for the creator: joining their team, pitching freelance services or skills, offering to supply the creator's business, proposing a collaboration or partnership, or asking to connect for work. This is NOT purchase_intent, however eager or demanding it sounds: "bring Unitree's CEO", "we want more of this", "bring back the Wicked Edition" are content_request.
- "question": asks something they want answered that is not a buying question — about the video's subject, the creator, or how to do something themselves. Asking the creator for advice, guidance or help with their OWN plans ("I am starting my own business, can you guide me") is question, not purchase_intent or content_request.
- "praise": compliments, thanks, appreciation or encouragement.
- "complaint": criticism or a negative experience.
- "spam": unrelated promotion, scams or bot links.
- "other": anything else.

Separately, and INDEPENDENTLY of the category, assess whether the comment needs the creator to answer it personally rather than having an AI draft a reply. Set "escalation" to one of:
- "legal_threat": mentions a lawyer, suing, legal action, reporting to authorities, or similar.
- "hostility": genuine hostility, abuse or harassment aimed at the creator or another person — beyond ordinary criticism or an annoyed complaint.
- "sensitive_liability": asks for or asserts medical/health claims, financial or investment advice, or raises a safety/injury issue, where a wrong answer could cause real harm.
- "crisis": the person describes self-harm, suicidal feelings, or a serious personal crisis.
- null: none of the above.

Judge escalation on the comment's meaning, not its category. A comment can be "praise" or "other" and still need personal attention. Do NOT escalate ordinary negative feedback — "this is overpriced", "delivery was late", "I did not like this video" are normal complaints. Include the "escalation" key on EVERY item, using null when nothing applies.

Give each comment 1 to 3 "topics": short snake_case tags for what it is about, most important first. Use more than one ONLY when the comment genuinely covers more than one thing — "great video but delivery was slow" is ["video_quality", "delivery"], while "loved this episode" is just ["content_quality"]. Do not pad the list.

Also judge each comment's "sentiment" — how the person feels, which is INDEPENDENT of the category above. Do not map it from the category: a "question" can be negative ("why is this so expensive?"), a "praise" can be mixed ("great episode but the audio was rough"), a "complaint" can be neutral in tone, and sarcasm is usually negative however positive the words look.
- "positive": pleased, appreciative, enthusiastic, encouraging.
- "negative": unhappy, critical, angry, disappointed, dismissive.
- "neutral": factual, informational or conversational, with no real feeling either way.
- "mixed": genuinely carries BOTH positive and negative feeling (praise with a real complaint attached).

Also give each comment's single primary "emotion" — the strongest one present, not a list. Use EXACTLY one of these words and never invent another: "anger", "joy", "sadness", "frustration", "excitement", "confusion", "sarcasm", "disappointment", "admiration", "fear", "none". Choose the emotion the words actually show, not the one the topic might suggest. Guidance for the common cases: flatly contradicting or correcting the creator or a guest is "frustration" (or "anger" if hostile); a rhetorical jab or mock-innocent question ("is he okay?") is "sarcasm"; wanting something that didn't happen is "disappointment"; genuinely not understanding is "confusion"; and "none" is right for a plain question, a bare statement or a link. If the feeling you see isn't in the list, pick the closest listed word, or "none".

Also give each comment's "language" — the language it is WRITTEN in, not its topic. Judge the WHOLE comment, including its last sentences. Names, @handles, place names, brands and show titles are not words in any language — ignore them.
- "english": entirely English.
- "swahili_sheng": Swahili and/or Sheng (the Nairobi street slang built on Swahili) — ONE value; do not try to tell the two apart. Formal or everyday Swahili, casual spellings ("Saaasa", "buana"), Sheng words ("manze", "msee", "noma", "doh", "zii") and single English loanwords inside a Swahili/Sheng sentence ("Hiyo ni misandry sio feminism") are all "swahili_sheng".
- "mixed": contains at least one whole English phrase or sentence AND at least one Swahili or Sheng phrase or sentence (e.g. "Create another channel ya wadau ya kuleta hizi updates man", or a long English comment ending in a Swahili sentence). This takes precedence: a mostly-Swahili/Sheng comment that also has a full English sentence is "mixed".
- null: no words to judge (emoji only) or another language entirely.

Also give each comment its ${ENTITY_EXTRACTION_RULES}

Respond with ONLY a JSON array, no preamble, no markdown code fences, in this exact format: [{"id": "...", "category": "...", "topics": ["..."], "confidence": 0.0-1.0, "escalation": null, "language": "english", "sentiment": "positive", "emotion": "admiration", "entities": []}]

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
            // Room for the language, sentiment, emotion and entities fields on all 10 items.
            max_tokens: 2200,
            messages: [{ role: 'user', content: prompt }],
          }),
          signal: controller.signal,
        }
      )
    } catch (fetchErr) {
      clearTimeout(timeoutId)
      if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
        logWarn('categorize.batch', 'Batch request timed out after 15s', { batch_size: batch.length, is_retry: isRetry })
      } else {
        logError('categorize.batch', fetchErr, { batch_size: batch.length, is_retry: isRetry, stage: 'fetch' })
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

    if (usageCtx) {
      recordAiUsage(usageCtx.supabase, {
        creatorId: usageCtx.creatorId,
        feature: 'categorize',
        model: 'claude-haiku-4-5-20251001',
        usage: data.usage,
        postId: usageCtx.postId,
      })
    }

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
      logError('categorize.batch', parseErr, { batch_size: batch.length, is_retry: isRetry, stage: 'parse_model_output' })
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
          // `escalationScreened` is the batched equivalent of the standalone
          // check's `checkFailed`. A model that silently drops the key must not be
          // read as "nothing to escalate" — that would lose the safety check without
          // anyone noticing. Present-and-null means screened and clean; absent means
          // unscreened, and downstream skips drafting without setting a flag.
          const escalationScreened = Object.prototype.hasOwnProperty.call(item, 'escalation')

          batchResults.push({
            id: item.id,
            category: String(item.category),
            topic: normalizeTopics(item.topics, item.topic)[0] ?? String(item.topic ?? ''),
            topics: normalizeTopics(item.topics, item.topic),
            confidence: typeof item.confidence === 'number' ? item.confidence : 0,
            language: normalizeLanguage(item.language),
            sentiment: normalizeSentiment(item.sentiment),
            emotion: normalizeEmotion(item.emotion),
            // Absent key = not scanned (NULL), so coverage stays honest.
            entities: Object.prototype.hasOwnProperty.call(item, 'entities') ? normalizeEntities(item.entities) : null,
            escalation: normalizeEscalation(item.escalation),
            escalationScreened,
          })
        } else {
          logWarn('categorize.batch', 'Skipping invalid result from the model', { is_retry: isRetry, item })
        }
      }
    }
  } catch (err) {
    logError('categorize.batch', err, { batch_size: batch.length, is_retry: isRetry })
  }

  return batchResults
}

export async function categorizePost(post_id: string, onProgress?: ProgressCallback) {
  const supabase = createServiceClient()

  // owner_replied_at (migration 55) may not exist yet on this database — tried
  // first, dropped on the specific "column does not exist" error rather than
  // failing the whole categorization run.
  let ownerReplyColumnAvailable = true
  let comments: Array<{ id: string; text: string; owner_replied_at?: string | null }> | null = null
  let commentsError: { code?: string; message?: string } | null = null
  {
    const result = await supabase.from('comments').select('id, text, owner_replied_at').eq('post_id', post_id)
    comments = result.data
    commentsError = result.error
    if (commentsError && (commentsError.code === 'PGRST204' || commentsError.code === '42703') && (commentsError.message ?? '').includes('owner_replied_at')) {
      ownerReplyColumnAvailable = false
      const fallback = await supabase.from('comments').select('id, text').eq('post_id', post_id)
      comments = fallback.data
      commentsError = fallback.error
    }
  }

  if (commentsError) {
    logError('categorize.categorizePost', commentsError, { post_id, stage: 'fetch_comments' })
    throw new Error('Failed to fetch comments')
  }

  if (!comments || comments.length === 0) {
    return { success: true, categorized: 0 }
  }

  // Comments the channel owner has already personally replied to (migration 55) —
  // computed at ingest time from data already fetched, no LLM/API call involved.
  // These never need a drafted reply, whatever category the model assigns them.
  const ownerRepliedIds = ownerReplyColumnAvailable ? new Set(comments.filter(c => c.owner_replied_at).map(c => c.id)) : new Set<string>()

  // BUG FIX: this used to run with no filter at all, so on any database with more
  // than Supabase's default 1000-row response cap in comment_categories (true of
  // any real production account), it silently returned an arbitrary 1000 rows out
  // of the WHOLE TABLE across every creator — not this post's comments. Comments
  // that already had a category but fell outside that 1000 looked "uncategorized"
  // here, got reprocessed, and their category/topics/draft could be silently
  // overwritten. fetchInBatches scopes this correctly to this post's own comment
  // ids, chunking the `in` list and paging each chunk so it holds even for videos
  // with thousands of comments.
  const existingCategories = await fetchInBatches<{ comment_id: string }>(supabase, {
    table: 'comment_categories',
    select: 'comment_id',
    inColumn: 'comment_id',
    inValues: comments.map(c => c.id),
    throwOnError: true,
  }).catch(err => {
    logError('categorize.categorizePost', err, { post_id, stage: 'fetch_existing_categories' })
    throw new Error('Failed to fetch existing categories')
  })

  const categorizedIds = new Set(existingCategories.map(c => c.comment_id))
  const uncategorized = comments.filter(c => !categorizedIds.has(c.id))

  if (uncategorized.length === 0) {
    return { success: true, categorized: 0 }
  }

  // Fetched early and reused for AI-spend attribution (lib/ai-usage.ts) even when
  // there's nothing draftable below — categorization itself is the single biggest
  // per-comment cost, so it must be attributed whether or not any comment ends up
  // getting a drafted reply.
  const { data: postForUsage } = await supabase.from('posts').select('creator_id').eq('id', post_id).maybeSingle()
  const usageCreatorId = postForUsage?.creator_id ?? null
  const usageCtx = usageCreatorId ? { supabase, creatorId: usageCreatorId, postId: post_id } : null

  const categorized = await categorizeComments(uncategorized, onProgress, usageCtx)

  if (categorized.length === 0) {
    return { success: true, categorized: 0 }
  }

  const upsertData = categorized.map(c => ({
    comment_id: c.id,
    category: c.category,
    topic: c.topic,
    topics: c.topics,
    confidence: c.confidence,
    // Written for EVERY comment now, not only draftable ones — which is the point
    // of folding this into the batch: crisis language in a 'praise' or 'other'
    // comment is flagged too.
    escalation_flag: c.escalation,
    language: c.language,
    sentiment: c.sentiment,
    emotion: c.emotion,
    entities: c.entities,
    // Explicitly NULL: the column was created with DEFAULT now() (migration 7), so
    // omitting it stamped a "draft created" time on every categorized comment,
    // drafted or not — 94% of rows carried a draft timestamp with no draft. The
    // timestamp is written only below, alongside an actual draft. These are always
    // new rows (only uncategorized comments reach this upsert), so nothing real is
    // cleared. Migration 39 drops the default as well.
    draft_reply_created_at: null,
  }))

  let { error: upsertError } = await supabase
    .from('comment_categories')
    .upsert(upsertData, { onConflict: 'comment_id' })
  // Columns added by later migrations (language: 24; sentiment/emotion: 26). Until
  // each exists, keep categorizing without it rather than failing every analysis.
  const optionalColumns = ['language', 'sentiment', 'emotion', 'topics', 'entities'] as const
  const dropped: string[] = []
  for (let attempt = 0; attempt < optionalColumns.length && upsertError; attempt++) {
    const missing = optionalColumns.find(
      c => (upsertError!.code === 'PGRST204' || upsertError!.code === '42703') && (upsertError!.message ?? '').includes(c) && !dropped.includes(c)
    )
    if (!missing) break
    dropped.push(missing)
    console.warn(`comment_categories.${missing} does not exist yet; saving categories without it`)
    ;({ error: upsertError } = await supabase
      .from('comment_categories')
      .upsert(
        upsertData.map(row => {
          const copy: Record<string, unknown> = { ...row }
          dropped.forEach(c => delete copy[c])
          return copy
        }),
        { onConflict: 'comment_id' }
      ))
  }

  if (upsertError) {
    logError('categorize.categorizePost', upsertError, { post_id, stage: 'upsert_categories' })
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
  let postCreatorId: string | null = null
  let businessProfile: BusinessProfile | null = null
  let styleExamples: StyleExample[] = []
  let customFieldContext: string[] = []
  let loadedCustomFields: CustomProfileField[] = []

  // One post fetch covers both needs: title/description for the relevance check,
  // and creator_id so the business profile can be looked up below.
  if (draftable.length > 0) {
    const { data: post, error: postFetchError } = await supabase
      .from('posts')
      .select('title, content, creator_id')
      .eq('id', post_id)
      .single()

    if (postFetchError) {
      logError('categorize.categorizePost', postFetchError, { post_id, stage: 'fetch_post_metadata' })
    } else if (post) {
      postTitle = post.title || ''
      postDescription = post.content || ''
      postCreatorId = post.creator_id || null

      // Once per post, not per comment. Unlike the business profile this applies to
      // every draftable category, since voice isn't category-specific.
      if (post.creator_id) {
        styleExamples = await loadStyleExamples(supabase, post.creator_id)
      }

      // Fetched once per run, not per comment — and only when there's actually a
      // question or purchase_intent draft that could use it.
      // Fetched once per run like the profile itself, and for the same categories:
      // a complaint's reply should not be quoting the creator's price list.
      if (post.creator_id && draftable.some(c => PROFILE_AWARE_CATEGORIES.has(c.category))) {
        const fields = await loadCustomProfileFields(supabase, post.creator_id)
        loadedCustomFields = fields
        customFieldContext = customFieldsToContext(fields)
      }

      if (post.creator_id && draftable.some(c => PROFILE_AWARE_CATEGORIES.has(c.category))) {
        const { data: creator, error: profileError } = await supabase
          .from('creators')
          .select(BUSINESS_PROFILE_COLUMNS)
          .eq('id', post.creator_id)
          .single()

        if (profileError) {
          logError('categorize.categorizePost', profileError, { post_id, creator_id: post.creator_id, stage: 'fetch_business_profile' })
        } else if (creator) {
          businessProfile = creator as unknown as BusinessProfile
        }
      }
    }
  }

  // Everything that earns a notification inbox entry. Two kinds, matching what the
  // old Highlights page surfaced:
  //   - a comment that got a drafted reply and is waiting for approval
  //   - a comment flagged for escalation, which deliberately gets NO draft and
  //     needs the creator to answer personally
  // Collected here and written in one insert after the loop rather than one insert
  // per comment, which on a first analysis would be hundreds of round trips.
  // Resolved once per post, not per comment: every comment on a post shares its
  // channel, so this is one check for the whole loop.
  let draftingAllowed = false
  let skippedUnverified = 0
  if (postCreatorId) {
    const verification = await checkPostVerification(supabase, postCreatorId, post_id)
    draftingAllowed = verification.verified
    if (!draftingAllowed) {
      logInfo('categorize.categorizePost', 'Drafting disabled for this post: channel ownership not verified', {
        creator_id: postCreatorId,
        post_id,
        channel_id: verification.channelId,
        reason: verification.reason,
      })
    }
  }

  type SkipReason = 'unscreened' | 'not_business_relevant' | 'relevance_check_failed' | 'draft_generation_failed' | 'unverified_channel' | 'owner_already_replied'

  const notifiable: Array<{ commentId: string; category: string; text: string; skipReason?: SkipReason }> = []

  // comment_categories.draft_skip_reason (migration 53) may not exist yet on every
  // database — same self-healing pattern used throughout this codebase. Probed
  // once per run rather than per comment.
  let skipReasonColumnAvailable = true
  async function writeSkipReason(commentId: string, reason: SkipReason): Promise<void> {
    if (!skipReasonColumnAvailable) return
    const { error } = await supabase
      .from('comment_categories')
      .update({ draft_skip_reason: reason })
      .eq('comment_id', commentId)
    if (error && (error.code === 'PGRST204' || error.code === '42703')) {
      skipReasonColumnAvailable = false
      console.warn('comment_categories.draft_skip_reason does not exist yet; skip reasons will not be recorded (run the pending migration)')
    } else if (error) {
      logError('categorize.categorizePost', error, { post_id, comment_id: commentId, stage: 'write_skip_reason' })
    }
  }

  // Contradicted profile facts come out of the verified set and go in as uncertain.
  let uncertainFacts: string[] = []
  if (postCreatorId && (businessProfile || loadedCustomFields.length)) {
    const adjusted = applyFactStatusesForDrafts(businessProfile, loadedCustomFields, await loadFactStatuses(supabase, postCreatorId))
    businessProfile = adjusted.profile
    customFieldContext = customFieldsToContext(adjusted.customFields)
    uncertainFacts = adjusted.uncertain
  }

  // Drafting makes LLM calls per comment but writes nothing to posts, so a long
  // pass would look dead to stale-run detection (lib/analysis-staleness.ts).
  // Re-reporting the unchanged categorized count leaves the progress UI as it is
  // but refreshes the post's heartbeat; throttled so it isn't a write per comment.
  let lastHeartbeat = Date.now()
  const heartbeat = () => {
    if (Date.now() - lastHeartbeat < 30_000) return
    lastHeartbeat = Date.now()
    onProgress?.(categorized.length)
  }

  for (const comment of draftable) {
    heartbeat()
    const text = uncategorizedTextMap.get(comment.id)
    if (!text) continue

    try {
      // Already personally answered by the channel owner — checked before
      // escalation/relevance so an answered comment never triggers an LLM call or
      // a notification, and never falls through to whatever bucket the content
      // classifier happened to pick (the bug this was written to fix: these used
      // to be indistinguishable from a comment nobody has addressed).
      if (ownerRepliedIds.has(comment.id)) {
        await writeSkipReason(comment.id, 'owner_already_replied')
        continue
      }

      // Escalation was assessed in the categorization pass and already written to
      // escalation_flag, so no extra call here — just honour it. It still overrides
      // both the relevance check and drafting: a legal threat classified as a
      // "question" must not get a helpful auto-reply however confident the model is.
      if (comment.escalation) {
        // No draft, but this is the highest-priority thing in the inbox.
        notifiable.push({ commentId: comment.id, category: comment.category, text })
        continue
      }

      if (!comment.escalationScreened) {
        // The model omitted the escalation key for this item. No escalation_flag is
        // written — a malformed response must not label someone's complaint a legal
        // threat — but drafting is skipped anyway, because the safe failure here is
        // silence rather than an auto-reply to something unscreened. THIS USED TO BE
        // a console.warn and nothing else: the comment vanished from view exactly
        // like a genuinely off-topic one. It's now recorded and surfaced instead, so
        // an unscreened question shows up as "needs your reply" rather than looking
        // like a miss.
        await writeSkipReason(comment.id, 'unscreened')
        notifiable.push({ commentId: comment.id, category: comment.category, text, skipReason: 'unscreened' })
        continue
      }

      if (relevanceCheckCategories.has(comment.category)) {
        const relevance = await isBusinessRelevant(text, postTitle, postDescription, usageCtx)
        if (!relevance.relevant) {
          if (relevance.checkFailed) {
            // The check itself errored/timed out — "not relevant" here was a
            // fail-closed default, not a real judgment that this is casual chit-chat.
            // A genuine business question could be sitting behind this failure, so
            // it's surfaced rather than dropped.
            await writeSkipReason(comment.id, 'relevance_check_failed')
            notifiable.push({ commentId: comment.id, category: comment.category, text, skipReason: 'relevance_check_failed' })
          } else {
            // Working as designed: genuinely judged casual/off-topic. No notification
            // — surfacing every off-topic question would just be noise — but the
            // reason is still recorded so a creator who goes looking can see why.
            await writeSkipReason(comment.id, 'not_business_relevant')
          }
          continue
        }
      }

      // CAPABILITY GATE. Drafting is skipped outright rather than generated and
      // hidden: a draft speaks in the channel owner's voice to a real viewer, so
      // producing one for a channel nobody has proven they own is the thing to
      // avoid — not merely showing it. Skipping also saves the LLM call.
      // Categorization above has already run and is deliberately NOT gated.
      // Not pushed to `notifiable`: this is already surfaced at the channel level
      // via ChannelVerificationBanner, and would otherwise flood the inbox with one
      // entry per comment on every unverified channel a creator has researched.
      if (!draftingAllowed) {
        skippedUnverified++
        await writeSkipReason(comment.id, 'unverified_channel')
        continue
      }

      try {
        const draft = await generateDraftReply(text, comment.category, businessProfile, styleExamples, customFieldContext, uncertainFacts, usageCtx)
        await supabase
          .from('comment_categories')
          .update({
            draft_reply: draft.text,
            draft_confidence: draft.confidence,
            draft_reply_created_at: new Date().toISOString(),
          })
          .eq('comment_id', comment.id)

        notifiable.push({ commentId: comment.id, category: comment.category, text })
      } catch (draftErr) {
        // Both attempts (generateDraftReply already retries once) failed. THIS USED
        // TO be caught by the outer catch below with only a log line — the comment
        // then had no draft, no notification, and nothing distinguishing it from a
        // correctly-skipped one. Now it's recorded and still surfaced, so the
        // creator sees "needs your reply" instead of the question just disappearing.
        logError('categorize.categorizePost', draftErr, { post_id, comment_id: comment.id, stage: 'generate_draft_reply' })
        await writeSkipReason(comment.id, 'draft_generation_failed')
        notifiable.push({ commentId: comment.id, category: comment.category, text, skipReason: 'draft_generation_failed' })
      }
    } catch (err) {
      logError('categorize.categorizePost', err, { post_id, comment_id: comment.id, stage: 'draft_loop' })
    }
  }

  if (skippedUnverified > 0) {

    logInfo('categorize.categorizePost', 'Drafts skipped for unverified channel', {

      creator_id: postCreatorId, post_id, skipped_unverified: skippedUnverified,

    })

  }


  await createDraftNotifications(supabase, postCreatorId, postTitle, notifiable)

  return { success: true, categorized: categorized.length }
}

/**
 * Writes one notification per comment that now needs the creator's attention.
 *
 * This is the single place notifications are created for drafted or escalated
 * comments. The cron poller used to insert its own rows after calling
 * categorizePost, which double-notified once this moved here; it now relies on
 * this function, so every path that produces a draft — first analysis, manual
 * re-analysis, cron polling — produces the same inbox entry.
 *
 * Only comment_id is stored, not a copy of the draft: the inbox joins through to
 * comment_categories at render time, so an edited or regenerated draft shows its
 * current text rather than a stale snapshot.
 *
 * Never throws. A notification is an accessory to the draft that was already
 * written successfully — failing the whole analysis over one is the wrong trade.
 */
const SKIP_REASON_NOTIFICATION_LABELS: Record<string, string> = {
  unscreened: 'needs your reply — could not confirm it was safe to auto-reply',
  relevance_check_failed: 'needs your reply — the agent could not finish checking this one',
  draft_generation_failed: 'needs your reply — drafting failed for this one',
}

async function createDraftNotifications(
  supabase: SupabaseClient,
  creatorId: string | null,
  videoTitle: string,
  notifiable: Array<{ commentId: string; category: string; text: string; skipReason?: string }>
): Promise<void> {
  if (!creatorId || notifiable.length === 0) return

  try {
    // Re-drafting an existing comment (profile edits trigger a regeneration across
    // every video) must not add a second row for a comment already in the inbox.
    const { data: existing, error: existingError } = await supabase
      .from('notifications')
      .select('comment_id')
      .eq('creator_id', creatorId)
      .in('comment_id', notifiable.map(n => n.commentId))

    if (existingError) {
      logError('categorize.createDraftNotifications', existingError, { creator_id: creatorId, stage: 'dedupe_check' })
      return
    }

    const already = new Set((existing || []).map(row => row.comment_id))
    const rows = notifiable
      .filter(n => !already.has(n.commentId))
      .map(n => {
        const label = n.skipReason ? SKIP_REASON_NOTIFICATION_LABELS[n.skipReason] : null
        const heading = label
          ? `New ${n.category.replace(/_/g, ' ')} comment${videoTitle ? ` on ${videoTitle}` : ''} — ${label}`
          : `New ${n.category.replace(/_/g, ' ')} comment${videoTitle ? ` on ${videoTitle}` : ''}`
        return {
          creator_id: creatorId,
          comment_id: n.commentId,
          type: n.category,
          message: `${heading}: ${n.text.length > 100 ? n.text.slice(0, 100) + '…' : n.text}`,
        }
      })

    if (rows.length === 0) return

    const { error: insertError } = await supabase.from('notifications').insert(rows)
    if (insertError) {
      logError('categorize.createDraftNotifications', insertError, { creator_id: creatorId, stage: 'insert' })
      return
    }

    logInfo('categorize.createDraftNotifications', 'Draft notifications created', { creator_id: creatorId, created: rows.length })
  } catch (err) {
    logError('categorize.createDraftNotifications', err, { creator_id: creatorId })
  }
}
