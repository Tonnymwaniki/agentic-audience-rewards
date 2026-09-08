/**
 * Comments a human has to answer themselves.
 *
 * This sits ABOVE the confidence system rather than beside it: confidence says how
 * sure the agent is about a draft, escalation says no draft should exist at all.
 * A high-confidence draft on a legal threat is precisely the outcome to prevent, so
 * escalation is checked first and wins unconditionally.
 */
export type EscalationType = 'legal_threat' | 'hostility' | 'sensitive_liability' | 'crisis'

export const ESCALATION_TYPES: EscalationType[] = [
  'legal_threat',
  'hostility',
  'sensitive_liability',
  'crisis',
]

/**
 * Creator-facing wording.
 *
 * Deliberately plain. The label a creator sees is never "CRISIS DETECTED" or
 * similar — for the crisis category especially, dramatising it helps nobody and
 * risks the creator reacting to the label rather than reading the person's actual
 * words. Every label describes what to DO, not how alarming the system thinks it is.
 */
export const ESCALATION_LABELS: Record<EscalationType, string> = {
  legal_threat: 'Mentions legal action',
  hostility: 'Hostile or harassing',
  sensitive_liability: 'Sensitive topic',
  crisis: 'Personal situation',
}

/** One shared explanation, so every surface says the same thing. */
export const ESCALATION_NOTE =
  "This needs your direct response — we didn't draft a reply given the nature of this comment."

export function normalizeEscalation(raw: unknown): EscalationType | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().toLowerCase()
  if (value === 'none' || value === 'null' || value === '') return null
  return (ESCALATION_TYPES as string[]).includes(value) ? (value as EscalationType) : null
}

const ESCALATION_PROMPT = `You are screening a single audience comment to decide whether a content creator must answer it personally, rather than having an AI draft a reply for them.

Flag the comment if it involves any of:
- "legal_threat": mentions a lawyer, suing, legal action, reporting to authorities, or similar.
- "hostility": genuine hostility, abuse or harassment aimed at the creator or another person — beyond ordinary criticism or an annoyed complaint.
- "sensitive_liability": asks for or asserts medical/health claims, financial or investment advice, or raises a safety/injury issue, where a wrong answer could cause real harm.
- "crisis": the person describes self-harm, suicidal feelings, or a serious personal crisis.

Do NOT flag ordinary negative feedback. "This is overpriced", "delivery was late", "I didn't like this video" and similar are normal complaints that a drafted reply handles fine.

Comment: '''COMMENT'''

Respond with ONLY valid JSON, no preamble: {"escalation": "legal_threat" | "hostility" | "sensitive_liability" | "crisis" | null}`

export type EscalationResult = {
  escalation: EscalationType | null
  /** True when the check itself failed, so the caller can skip drafting anyway. */
  checkFailed: boolean
}

/**
 * One cheap classification call per comment, run only where a draft would otherwise
 * be written.
 *
 * FAILS SAFE, and the two failure directions are deliberately different:
 *   - the check errors or times out  -> checkFailed, no flag, and the caller skips
 *     drafting. Better to leave a comment undrafted than to auto-reply to something
 *     that might be a legal threat.
 *   - the check errors               -> escalation stays null rather than being set
 *     to a guess, because labelling a routine complaint a "legal threat" in the
 *     creator's UI on the back of a network blip is its own kind of wrong.
 */
export async function detectEscalation(commentText: string): Promise<EscalationResult> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000)

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 64,
        messages: [{ role: 'user', content: ESCALATION_PROMPT.replace('COMMENT', commentText) }],
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`)
    }

    const data = await response.json()
    const content = data.content?.[0]?.text
    if (!content) throw new Error('Empty response from Anthropic')

    const match = content.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('No JSON object found in response')

    const parsed = JSON.parse(match[0])
    return { escalation: normalizeEscalation(parsed.escalation), checkFailed: false }
  } catch (err) {
    console.error('Escalation check error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return { escalation: null, checkFailed: true }
  } finally {
    clearTimeout(timeoutId)
  }
}
