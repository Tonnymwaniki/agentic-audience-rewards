import type { toolSuggestContentIdeas } from '@/lib/research/engine'
import { plainText } from '@/lib/plain-text'
import { logWarn } from '@/lib/logger'

type IdeaSignalsData = Awaited<ReturnType<typeof toolSuggestContentIdeas>>

export type SignalKind = 'repeated' | 'content_request' | 'question' | 'purchase_intent' | 'topic'

export type Signal = {
  /** S1, S2, … — what the model cites, so it never has to reproduce comment text. */
  id: string
  kind: SignalKind
  text: string
  detail: string
}

export type ContentIdea = {
  number: number
  title: string
  description: string
  signals: Signal[]
}

const MODEL = 'claude-haiku-4-5-20251001'

/**
 * Flattens the suggest_content_ideas output — the exact data the chat tool gives
 * the model — into numbered signals.
 */
export function numberSignals(data: IdeaSignalsData): Signal[] {
  const signals: Omit<Signal, 'id'>[] = [
    ...data.trending_comments.map(g => ({
      kind: 'repeated' as const,
      text: plainText(g.text),
      detail: `posted ${g.count}× by ${g.unique_people} different people`,
    })),
    ...data.content_requests.map(q => ({
      kind: 'content_request' as const,
      text: plainText(q.text),
      detail: `on "${q.video}"`,
    })),
    ...data.audience_questions.map(q => ({
      kind: 'question' as const,
      text: plainText(q.text),
      detail: `on "${q.video}"`,
    })),
    ...data.purchase_intent_signals.map(q => ({
      kind: 'purchase_intent' as const,
      text: plainText(q.text),
      detail: `on "${q.video}"`,
    })),
    ...data.top_topics.map(t => ({
      kind: 'topic' as const,
      text: t.name.replace(/_/g, ' '),
      detail: `${t.count} comments`,
    })),
  ]
  return signals.map((signal, i) => ({ id: `S${i + 1}`, ...signal }))
}

const KIND_LABEL: Record<SignalKind, string> = {
  repeated: 'repeated comment',
  content_request: 'content request',
  question: 'audience question',
  purchase_intent: 'buying signal',
  topic: 'common topic',
}

export function signalKindLabel(kind: SignalKind) {
  return KIND_LABEL[kind]
}

/** Shown for every failed or untrustworthy generation, whatever the cause. */
export const IDEAS_FAILED_MESSAGE = 'Something went wrong generating ideas — please try again'

/**
 * A real generation reads dozens of signals and writes 3-5 ideas; that takes
 * several seconds. An answer faster than this didn't do that work, whatever it
 * contains.
 */
export const MIN_GENERATION_MS = 2_000
export const MIN_IDEAS = 3

export type IdeasResult = {
  ideas: ContentIdea[]
  error: string | null
  /** Why the result was rejected — for logs and tests, never shown to the creator. */
  failure: string | null
  elapsedMs: number
}

/**
 * Turns signals into 3-5 content ideas with one model call.
 *
 * Grounding is enforced in code, not trusted: the model cites signals by id, each
 * id is looked up in the list it was given, unknown ids are dropped, and an idea
 * left with no real signal is dropped too. What the page shows under "Based on" is
 * therefore always real comment text, never text the model wrote.
 *
 * The result is also checked for plausibility, and rejected as a whole — never
 * partially shown — if the call finished in under MIN_GENERATION_MS or fewer than
 * MIN_IDEAS grounded ideas survived. Either one means something went wrong
 * upstream, and a thin or instant answer must not be presented as trustworthy.
 *
 * Never throws; on any failure returns no ideas and IDEAS_FAILED_MESSAGE.
 */
export async function synthesizeContentIdeas(
  signals: Signal[],
  { timeoutMs = 25_000, minDurationMs = MIN_GENERATION_MS, minIdeas = MIN_IDEAS } = {}
): Promise<IdeasResult> {
  if (signals.length === 0) return { ideas: [], error: null, failure: null, elapsedMs: 0 }

  const list = signals.map(s => `${s.id} [${KIND_LABEL[s.kind]}] "${s.text}" (${s.detail})`).join('\n')
  const prompt = `You are helping a content creator decide what to make next, using real signals from their audience's comments.

AUDIENCE SIGNALS:
${list}

Suggest 3 to 5 concrete content ideas this audience is actually asking for. Each idea must come from the signals above: cite 1 to 3 signal ids that justify it. Prefer ideas backed by content requests, questions, buying signals or things several people repeat over generic praise. Don't invent facts that aren't in the signals.

Respond with ONLY valid JSON:
{"ideas": [{"title": "short, specific video idea", "description": "one or two sentences: what the video covers and why this audience wants it", "signal_ids": ["S1"]}]}`

  const startedAt = Date.now()
  const fail = (failure: string): IdeasResult => {
    const elapsedMs = Date.now() - startedAt
    logWarn('research.contentIdeas', 'Idea generation rejected; no ideas returned', { failure, elapsed_ms: elapsedMs })
    return { ideas: [], error: IDEAS_FAILED_MESSAGE, failure, elapsedMs }
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Anthropic API error: ${response.status}`)

    const data = await response.json()
    const text: string | undefined = data.content?.[0]?.text
    const match = text?.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('No JSON in response')
    const parsed = JSON.parse(match[0])

    const byId = new Map(signals.map(s => [s.id, s]))
    const ideas: ContentIdea[] = []
    for (const raw of Array.isArray(parsed.ideas) ? parsed.ideas : []) {
      if (typeof raw?.title !== 'string' || typeof raw?.description !== 'string') continue
      const ids: unknown[] = Array.isArray(raw.signal_ids) ? raw.signal_ids : []
      const cited: Signal[] = []
      for (const id of ids) {
        const signal = typeof id === 'string' ? byId.get(id.trim()) : undefined
        if (signal && !cited.some(c => c.id === signal.id)) cited.push(signal)
      }
      const unique = cited.slice(0, 3)
      if (unique.length === 0) continue
      ideas.push({
        number: ideas.length + 1,
        title: raw.title.trim(),
        description: raw.description.trim(),
        signals: unique,
      })
      if (ideas.length === 5) break
    }
    const elapsedMs = Date.now() - startedAt
    if (elapsedMs < minDurationMs) {
      return fail(`response completed in ${elapsedMs}ms, under the ${minDurationMs}ms minimum`)
    }
    if (ideas.length < minIdeas) {
      const returned = Array.isArray(parsed.ideas) ? parsed.ideas.length : 0
      return fail(`only ${ideas.length} grounded ideas (model returned ${returned}), under the minimum of ${minIdeas}`)
    }
    return { ideas, error: null, failure: null, elapsedMs }
  } catch (err) {
    return fail(err instanceof Error && err.name === 'AbortError' ? 'timed out' : err instanceof Error ? err.message : String(err))
  } finally {
    clearTimeout(timeoutId)
  }
}
