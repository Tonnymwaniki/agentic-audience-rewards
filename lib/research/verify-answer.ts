/**
 * A fact-check of a Research chat answer against the evidence gathered in the
 * same turn, before the creator sees it.
 *
 * Built on the reward self-critique's lessons (lib/rewards/decide.ts): no tools,
 * fail to the ORIGINAL answer on any error, and a framing where standing is the
 * normal outcome.
 *
 * Those lessons were not enough on their own. The first version asked the model
 * for an overall "stands?" judgment plus a full rewritten answer, with the same
 * "do not manufacture a disagreement" wording that fixed the reward critique. On
 * real evidence it revised 9 of 9 SOUND answers (while catching 9 of 9 flawed
 * ones) — it faulted answers for not covering every part of the question, argued
 * about wording like "mostly", miscounted search results, and expanded answers
 * while "fixing" them. So this version is structural rather than tonal:
 *  - The model only labels individual factual claims (supported / contradicted /
 *    not_in_evidence), with an explicit list of things that are never problems.
 *    Whether the answer stands is decided here in code from those labels.
 *  - A fix is a minimal edit: an exact span from the draft plus its replacement.
 *    The code applies those edits, so a reviewer can remove a wrong number but can
 *    never rewrite, extend or restyle the rest of the answer.
 */

export type ToolCallDigest = {
  tool: string
  input: unknown
  output: unknown
}

export type AnswerVerification = {
  /** Whether the review ran at all. */
  checked: boolean
  /** Whether the answer shown differs from the first draft. */
  revised: boolean
  /** Claims the reviewer found contradicted by, or absent from, the evidence. */
  unsupported_claims: string[]
  /** How many of those claims had a fix that could be applied to the draft. */
  fixes_applied: number
  /** Proposed fixes refused because they rewrote or extended the answer instead of correcting it. */
  fixes_rejected: number
  /** Why the review didn't run, when it didn't. */
  skipped_reason: string | null
}

const MODEL = 'claude-haiku-4-5-20251001'
/** Per tool result and in total — the reviewer needs the evidence, not every row. */
const MAX_OUTPUT_CHARS = 6_000
const MAX_EVIDENCE_CHARS = 30_000

function digestEvidence(calls: ToolCallDigest[]): string {
  let used = 0
  const parts: string[] = []
  for (const call of calls) {
    let output = JSON.stringify(call.output)
    if (output.length > MAX_OUTPUT_CHARS) output = output.slice(0, MAX_OUTPUT_CHARS) + ' …[truncated]'
    const part = `TOOL ${call.tool}\nINPUT ${JSON.stringify(call.input)}\nRESULT ${output}`
    if (used + part.length > MAX_EVIDENCE_CHARS) {
      parts.push('[further tool results omitted for length]')
      break
    }
    parts.push(part)
    used += part.length
  }
  return parts.join('\n\n')
}

/** Answers with nothing to check: no tools were used and no figures are claimed. */
function hasNothingToVerify(answer: string, calls: ToolCallDigest[]): boolean {
  return calls.length === 0 && !/\d/.test(answer)
}

export function buildVerificationPrompt(question: string, answer: string, calls: ToolCallDigest[]): string {
  return `You are fact-checking an audience-research answer before a content creator sees it.

THE CREATOR'S QUESTION:
${question}

EVIDENCE GATHERED THIS TURN (tool calls and their results). This is the ONLY evidence the answer may rely on:
${calls.length > 0 ? digestEvidence(calls) : '(no tools were called)'}

DRAFT ANSWER:
${answer}

Go through the draft's FACTUAL CLAIMS: specific numbers or counts, quoted wording, named people, video titles, and what a cited comment [C#] or video [V#] is said to show. Give each one a verdict:
- "supported": the evidence states it or clearly implies it. A number copied from a tool's count field is supported. A fair paraphrase of a cited comment is supported.
- "contradicted": the evidence says something different — a wrong number, a quote that is not what the comment says, a citation whose comment says the opposite.
- "not_in_evidence": a specific fact that appears nowhere in the evidence.

Judge nothing else. These are NEVER problems: not answering every part of the question, leaving out other relevant evidence, choice of examples, emphasis or wording ("mostly", "rare", "a small signal") that a reasonable reader could take from the evidence, tone, suggestions, or offers to look further. Note that search_comments "count" is the number of comments containing the query's words; its results list also includes related comments, so a count and the number of results can legitimately differ. When search_comments ran with no query (search_mode "filter"), "count" is every comment matching filters_applied and the results are only the newest 20 of them. filters_applied gives the exact date window used: posted_before is exclusive, so a window ending "before 2026-09-18" covers comments through 2026-09-17. Most drafts are fully supported — finding nothing wrong is the normal result.

An objection must be grounded:
- "contradicted" requires "evidence_quote": text copied EXACTLY from the evidence above that conflicts with the claim. If you cannot copy evidence text that conflicts with it, the claim is not contradicted.
- "not_in_evidence" is only for a checkable specific — a number, a quotation, a name or a citation — that appears nowhere in the evidence. A characterisation or summary is never "not_in_evidence".

For each "contradicted" or "not_in_evidence" claim, give a minimal fix: "quote" copied EXACTLY from the draft (the shortest span containing the error) and "replacement" — corrected text using only the evidence, or "" to delete the span.

Respond with ONLY valid JSON:
{"claims": [{"claim": "...", "verdict": "supported", "evidence_quote": "", "quote": "", "replacement": ""}]}`
}

type ReviewedClaim = { claim: string; verdict: string; quote: string; replacement: string; evidence_quote?: string }

const FAILING_VERDICTS = new Set(['contradicted', 'not_in_evidence'])

function normaliseForMatch(text: string): string {
  return text
    .replace(/\\"/g, '"')
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** A specific that can actually be checked: a digit, a quotation, or a citation. */
const CHECKABLE_SPECIFIC = /\d|["\u201c\u201d]|\[[CV]\d+\]/

/**
 * Whether an objection is grounded, per the prompt's rules — enforced in code
 * because the reviewer does not reliably follow them. Measured: with span edits
 * and the minimal-fix guard alone, 4 of 9 sound answers were still edited, every
 * time over a characterisation ("a small signal", "only one comment") rather than
 * a checkable fact.
 */
export function isGroundedObjection(claim: ReviewedClaim, evidenceText: string): boolean {
  if (claim.verdict === 'contradicted') {
    const quoted = normaliseForMatch(claim.evidence_quote ?? '')
    return quoted.length >= 8 && normaliseForMatch(evidenceText).includes(quoted)
  }
  if (claim.verdict === 'not_in_evidence') {
    return CHECKABLE_SPECIFIC.test(claim.quote)
  }
  return false
}

/** Citation refs inside a piece of text, however they're written: [C3], (C3, V1), C3. */
function refsIn(text: string): Set<string> {
  return new Set(text.match(/\b[CV]\d+\b/g) ?? [])
}

/**
 * Whether a proposed fix is a real minimal correction. Measured failure this
 * guards against: asked for span edits, the reviewer still "fixed" a sound answer
 * by replacing its last few words with a whole new paragraph, and slipped in
 * citations the draft never made. A correction replaces a wrong number or quote
 * with a right one, or deletes it — so its replacement may be only modestly
 * longer than what it replaces, and may not cite anything the span didn't.
 */
export function isMinimalFix(quote: string, replacement: string): boolean {
  if (replacement.length > quote.length * 1.5 + 20) return false
  const allowed = refsIn(quote)
  for (const ref of refsIn(replacement)) {
    if (!allowed.has(ref)) return false
  }
  return true
}

/**
 * Applies span edits to the draft. Returns the edited text, how many edits were
 * applied, and how many were rejected as not minimal. A quote that isn't found
 * verbatim is skipped, never guessed at.
 */
export function applyClaimFixes(
  draft: string,
  claims: ReviewedClaim[]
): { text: string; applied: number; rejected: number } {
  let text = draft
  let applied = 0
  let rejected = 0
  for (const c of claims) {
    if (!FAILING_VERDICTS.has(c.verdict) || !c.quote) continue
    if (!isMinimalFix(c.quote, c.replacement)) {
      rejected++
      continue
    }
    const at = text.indexOf(c.quote)
    if (at === -1) continue
    text = text.slice(0, at) + c.replacement + text.slice(at + c.quote.length)
    applied++
  }
  if (applied === 0) return { text: draft, applied: 0, rejected }

  text = text
    // A deleted claim can leave its citation stranded: "[C10]." on its own.
    .replace(/(^|[.!?]\s+|\n)\s*(\[[CV]\d+\])+\s*[.!?]?/g, '$1')
    // ...or leave punctuation that belonged to it: "Price is X: rest" -> ": rest".
    .replace(/(^|[.!?]\s+|\n)\s*[:;,]\s*/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  // A sentence that now starts lower-case after its opening was deleted.
  text = text.replace(/(^|[.!?]\s+)([a-z])/g, (_m, lead: string, ch: string) => lead + ch.toUpperCase())
  return { text, applied, rejected }
}

/**
 * Returns the answer to show, possibly revised, plus a record of what happened.
 * Never throws.
 */
export async function verifyResearchAnswer(input: {
  question: string
  answer: string
  toolCalls: ToolCallDigest[]
  timeoutMs: number
}): Promise<{ answer: string; verification: AnswerVerification }> {
  const { question, answer, toolCalls, timeoutMs } = input
  const unchanged = (skipped_reason: string | null, checked: boolean, claims: string[] = [], rejected = 0) => ({
    answer,
    verification: { checked, revised: false, unsupported_claims: claims, fixes_applied: 0, fixes_rejected: rejected, skipped_reason },
  })

  if (hasNothingToVerify(answer, toolCalls)) return unchanged('no tool evidence or figures to check', false)

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
        max_tokens: 1600,
        messages: [{ role: 'user', content: buildVerificationPrompt(question, answer, toolCalls) }],
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Anthropic API error: ${response.status}`)

    const data = await response.json()
    const text: string | undefined = data.content?.[0]?.text
    if (!text) throw new Error('Empty verification response')

    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('No JSON object in verification response')
    const parsed = JSON.parse(match[0])

    const claims: ReviewedClaim[] = Array.isArray(parsed.claims)
      ? parsed.claims
          .filter((c: unknown): c is Record<string, unknown> => !!c && typeof c === 'object')
          .map((c: Record<string, unknown>) => ({
            claim: typeof c.claim === 'string' ? c.claim : '',
            verdict: typeof c.verdict === 'string' ? c.verdict : 'supported',
            quote: typeof c.quote === 'string' ? c.quote : '',
            replacement: typeof c.replacement === 'string' ? c.replacement : '',
            evidence_quote: typeof c.evidence_quote === 'string' ? c.evidence_quote : '',
          }))
      : []

    // Standing is decided here, from the per-claim verdicts — not by the model —
    // and only grounded objections count.
    const evidenceText = digestEvidence(toolCalls)
    const failing = claims.filter(c => FAILING_VERDICTS.has(c.verdict) && isGroundedObjection(c, evidenceText))
    if (failing.length === 0) return unchanged(null, true)

    const failingDescriptions = failing.map(c => c.claim).filter(Boolean)
    const fixed = applyClaimFixes(answer, failing)
    // Nothing applicable (or only non-minimal rewrites were proposed): the draft stands.
    if (fixed.applied === 0 || !fixed.text) return unchanged(null, true, failingDescriptions, fixed.rejected)

    return {
      answer: fixed.text,
      verification: {
        checked: true,
        revised: true,
        unsupported_claims: failingDescriptions,
        fixes_applied: fixed.applied,
        fixes_rejected: fixed.rejected,
        skipped_reason: null,
      },
    }
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError' ? 'timed out' : err instanceof Error ? err.message : String(err)
    console.error('Research answer verification failed; showing original answer:', reason)
    return unchanged(`verification failed: ${reason}`, false)
  } finally {
    clearTimeout(timeoutId)
  }
}
