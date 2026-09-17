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
  /** Whether the answer was actually checked (by the full or the simple check). */
  checked: boolean
  /**
   * Which check produced the result: 'full' (per-claim review with minimal edits),
   * 'simple' (pass/fail fallback after the full check could not return a usable
   * result), or 'none' (nothing to check, or no check could complete).
   */
  mode: 'full' | 'simple' | 'none'
  /**
   * True when the answer could not be confirmed — every check failed, or the simple
   * check found problems it cannot fix. The answer then carries a visible note, so a
   * failed check is never presented as a verified one.
   */
  reduced_confidence: boolean
  /** Why each failed check attempt failed, in order. Empty when the first attempt worked. */
  attempt_failures: string[]
  /** Whether the answer shown differs from the first draft. */
  revised: boolean
  /** Claims the reviewer found contradicted by, or absent from, the evidence. */
  unsupported_claims: string[]
  /** How many of those claims had a fix that could be applied to the draft. */
  fixes_applied: number
  /**
   * Objections left standing in the answer because no minimal fix could be applied
   * (no fix proposed, a rewrite rejected as not minimal, or its quote not found).
   * Whenever this is non-empty the answer carries the flagged note.
   */
  unresolved_claims: string[]
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

Judge nothing else. These are NEVER problems: not answering every part of the question, leaving out other relevant evidence, choice of examples, emphasis or wording ("mostly", "rare", "a small signal") that a reasonable reader could take from the evidence, tone, suggestions, or offers to look further. Note that search_comments "count" is the number of comments containing the query's words; its results list also includes related comments, so a count and the number of results can legitimately differ. When search_comments ran with no query (search_mode "filter"), "count" is every comment matching filters_applied and the results are only the newest 20 of them. filters_applied gives the exact date window used: posted_before is exclusive, so a window ending "before 2026-09-18" covers comments through 2026-09-17. A period_breakdown's sentiment_percent values are percentages and its sentiment_counts values are comment counts — never treat one as the other; a percentage copied from sentiment_percent is supported even if dividing the counts yourself gives a number 1 away (they are rounded to sum to 100). Most drafts are fully supported — finding nothing wrong is the normal result.

An objection must be grounded:
- "contradicted" requires "evidence_quote": text copied EXACTLY from the evidence above that conflicts with the claim. If you cannot copy evidence text that conflicts with it, the claim is not contradicted.
- "not_in_evidence" is only for a checkable specific — a number, a quotation, a name or a citation — that appears nowhere in the evidence. A characterisation or summary is never "not_in_evidence".

For each "contradicted" or "not_in_evidence" claim, give a minimal fix: "quote" copied EXACTLY from the draft (the shortest span containing the error) and "replacement" — corrected text using only the evidence, or "" to delete the span.

Report every verdict by calling the report_claims tool.`
}

/**
 * The full check's output shape. Returned through forced tool use rather than as
 * JSON in text: free-text JSON broke on roughly half of long answers, because the
 * reviewer copied quotations containing unescaped double quotes into its strings
 * ("Expected ',' or '}' after property value"). A tool call's input comes back
 * already parsed.
 */
const REPORT_CLAIMS_TOOL = {
  name: 'report_claims',
  description: 'Report the verdict for each factual claim in the draft answer.',
  input_schema: {
    type: 'object',
    properties: {
      claims: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            claim: { type: 'string' },
            verdict: { type: 'string', enum: ['supported', 'contradicted', 'not_in_evidence'] },
            evidence_quote: { type: 'string' },
            quote: { type: 'string' },
            replacement: { type: 'string' },
          },
          required: ['claim', 'verdict'],
        },
      },
    },
    required: ['claims'],
  },
}

export function buildSimpleCheckPrompt(question: string, answer: string, calls: ToolCallDigest[]): string {
  return `You are doing a quick pass/fail fact-check of an audience-research answer.

THE CREATOR'S QUESTION:
${question}

EVIDENCE (tool calls and results — the only evidence the answer may rely on):
${calls.length > 0 ? digestEvidence(calls) : '(no tools were called)'}

ANSWER:
${answer}

Are the answer's specific numbers, quotations, names and citations supported by the evidence, including being about the time period the answer says they are? Ignore wording, emphasis, tone, completeness and suggestions. Report with the report_check tool: all_supported true if nothing specific is wrong; otherwise false, listing each wrong or unsupported specific in problems.`
}

const REPORT_CHECK_TOOL = {
  name: 'report_check',
  description: 'Report whether the answer is supported by the evidence.',
  input_schema: {
    type: 'object',
    properties: {
      all_supported: { type: 'boolean' },
      problems: { type: 'array', items: { type: 'string' } },
    },
    required: ['all_supported', 'problems'],
  },
}

/** Appended when an answer could not be confirmed, so a failed check is visible. */
export const UNVERIFIED_NOTE =
  "_I couldn't double-check the figures in this answer, so treat the specific numbers with some caution._"
export const FLAGGED_NOTE = '_A quick check flagged some figures here that may not match the data, so treat the specific numbers with caution._'

export function withNote(answer: string, note: string): string {
  return `${answer.trimEnd()}\n\n${note}`
}

class ReviewCallError extends Error {}

/**
 * One reviewer call with a forced tool. Returns the tool's parsed input. Throws
 * ReviewCallError on anything unusable — HTTP errors, a response cut off at the
 * token limit (its tool input would be incomplete), or no tool call.
 */
async function callReviewTool(
  prompt: string,
  tool: { name: string; description: string; input_schema: object },
  maxTokens: number,
  timeoutMs: number
): Promise<Record<string, unknown>> {
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
        max_tokens: maxTokens,
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw new ReviewCallError(`Anthropic API error: ${response.status}`)
    const data = await response.json()
    if (data.stop_reason === 'max_tokens') throw new ReviewCallError('review cut off at the token limit')
    const block = Array.isArray(data.content)
      ? data.content.find((b: { type?: string; name?: string }) => b?.type === 'tool_use' && b.name === tool.name)
      : undefined
    if (!block || !block.input || typeof block.input !== 'object') throw new ReviewCallError(`no ${tool.name} tool call in the response`)
    return block.input as Record<string, unknown>
  } catch (err) {
    if (err instanceof ReviewCallError) throw err
    const reason = err instanceof Error && err.name === 'AbortError' ? 'timed out' : err instanceof Error ? err.message : String(err)
    throw new ReviewCallError(reason)
  } finally {
    clearTimeout(timeoutId)
  }
}

/** The full check's claims, validated field by field. Throws when the shape is unusable. */
function parseClaims(input: Record<string, unknown>): ReviewedClaim[] {
  if (!Array.isArray(input.claims)) throw new ReviewCallError('report_claims input has no claims array')
  return input.claims
    .filter((c: unknown): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c: Record<string, unknown>) => ({
      claim: typeof c.claim === 'string' ? c.claim : '',
      verdict: typeof c.verdict === 'string' ? c.verdict : 'supported',
      quote: typeof c.quote === 'string' ? c.quote : '',
      replacement: typeof c.replacement === 'string' ? c.replacement : '',
      evidence_quote: typeof c.evidence_quote === 'string' ? c.evidence_quote : '',
    }))
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
 * applied, how many were rejected as not minimal, and every failing claim that was
 * NOT fixed — for any reason — so the caller can surface it. A quote that isn't
 * found verbatim is skipped, never guessed at.
 */
export function applyClaimFixes(
  draft: string,
  claims: ReviewedClaim[]
): { text: string; applied: number; rejected: number; unresolved: ReviewedClaim[] } {
  let text = draft
  let applied = 0
  let rejected = 0
  const unresolved: ReviewedClaim[] = []
  for (const c of claims) {
    if (!FAILING_VERDICTS.has(c.verdict)) continue
    if (!c.quote) {
      unresolved.push(c)
      continue
    }
    if (!isMinimalFix(c.quote, c.replacement)) {
      rejected++
      unresolved.push(c)
      continue
    }
    const at = text.indexOf(c.quote)
    if (at === -1) {
      unresolved.push(c)
      continue
    }
    text = text.slice(0, at) + c.replacement + text.slice(at + c.quote.length)
    applied++
  }
  if (applied === 0) return { text: draft, applied: 0, rejected, unresolved }

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
  return { text, applied, rejected, unresolved }
}

/** Below this much time left, another reviewer call isn't started. */
const MIN_ATTEMPT_MS = 4_000
const FULL_CHECK_ATTEMPTS = 2

/**
 * Returns the answer to show, possibly revised, plus a record of what happened.
 * Never throws.
 *
 * Fails safe, not open. The full per-claim check gets FULL_CHECK_ATTEMPTS tries;
 * if none returns a usable result, a simpler pass/fail check runs. If that can't
 * complete either — or it finds problems it has no way to fix — the answer is shown
 * with a visible note that its figures couldn't be confirmed. A crashed check is
 * never reported as a passed one.
 */
export async function verifyResearchAnswer(input: {
  question: string
  answer: string
  toolCalls: ToolCallDigest[]
  timeoutMs: number
}): Promise<{ answer: string; verification: AnswerVerification }> {
  const { question, answer, toolCalls, timeoutMs } = input
  const deadline = Date.now() + timeoutMs
  const remaining = () => deadline - Date.now()
  const attemptFailures: string[] = []

  const result = (
    text: string,
    fields: Partial<AnswerVerification> & Pick<AnswerVerification, 'checked' | 'mode'>
  ): { answer: string; verification: AnswerVerification } => ({
    answer: text,
    verification: {
      revised: false,
      unsupported_claims: [],
      fixes_applied: 0,
      fixes_rejected: 0,
      skipped_reason: null,
      reduced_confidence: false,
      unresolved_claims: [],
      attempt_failures: attemptFailures,
      ...fields,
    },
  })

  if (hasNothingToVerify(answer, toolCalls)) {
    return result(answer, { checked: false, mode: 'none', skipped_reason: 'no tool evidence or figures to check' })
  }

  // --- Full check: per-claim verdicts with minimal edits. ---
  let claims: ReviewedClaim[] | null = null
  for (let attempt = 1; attempt <= FULL_CHECK_ATTEMPTS && claims === null; attempt++) {
    if (remaining() < MIN_ATTEMPT_MS) break
    try {
      claims = parseClaims(
        await callReviewTool(buildVerificationPrompt(question, answer, toolCalls), REPORT_CLAIMS_TOOL, 3000, remaining())
      )
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      attemptFailures.push(`full check attempt ${attempt}: ${reason}`)
      console.error(`Research answer verification attempt ${attempt} failed:`, reason)
    }
  }

  if (claims !== null) {
    // Standing is decided here, from the per-claim verdicts — not by the model —
    // and only grounded objections count.
    const evidenceText = digestEvidence(toolCalls)
    const failing = claims.filter(c => FAILING_VERDICTS.has(c.verdict) && isGroundedObjection(c, evidenceText))
    if (failing.length === 0) return result(answer, { checked: true, mode: 'full' })

    const failingDescriptions = failing.map(c => c.claim).filter(Boolean)
    const fixed = applyClaimFixes(answer, failing)
    // A fix that would leave nothing to show is not a usable fix: every objection
    // stays unresolved and the original draft is kept.
    const usable = fixed.applied > 0 && !!fixed.text
    const text = usable ? fixed.text : answer
    const unresolved = usable ? fixed.unresolved : failing
    const unresolvedDescriptions = unresolved.map(c => c.claim || c.quote).filter(Boolean)

    // Never let an objection the reviewer raised go out silently. If any objection
    // could not be fixed, the answer says so — accepting that this note will
    // sometimes appear on an answer whose flagged claim was actually right.
    return result(unresolved.length > 0 ? withNote(text, FLAGGED_NOTE) : text, {
      checked: true,
      mode: 'full',
      revised: usable,
      unsupported_claims: failingDescriptions,
      unresolved_claims: unresolvedDescriptions,
      reduced_confidence: unresolved.length > 0,
      fixes_applied: usable ? fixed.applied : 0,
      fixes_rejected: fixed.rejected,
    })
  }

  // --- Fallback: a simple pass/fail check. It can't make targeted edits, so a
  // failing verdict can only be surfaced, not fixed. ---
  if (remaining() >= MIN_ATTEMPT_MS) {
    try {
      const check = await callReviewTool(buildSimpleCheckPrompt(question, answer, toolCalls), REPORT_CHECK_TOOL, 800, remaining())
      if (typeof check.all_supported !== 'boolean') throw new ReviewCallError('report_check input has no all_supported flag')
      const problems = Array.isArray(check.problems) ? check.problems.filter((p): p is string => typeof p === 'string') : []
      if (check.all_supported) return result(answer, { checked: true, mode: 'simple' })
      return result(withNote(answer, FLAGGED_NOTE), {
        checked: true,
        mode: 'simple',
        unsupported_claims: problems,
        unresolved_claims: problems.length > 0 ? problems : ['the simple check failed the answer without listing a problem'],
        reduced_confidence: true,
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      attemptFailures.push(`simple check: ${reason}`)
      console.error('Research answer simple check failed:', reason)
    }
  } else {
    attemptFailures.push('simple check: not enough time left')
  }

  return result(withNote(answer, UNVERIFIED_NOTE), {
    checked: false,
    mode: 'none',
    reduced_confidence: true,
    skipped_reason: 'every verification attempt failed',
  })
}
