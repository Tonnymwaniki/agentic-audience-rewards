/**
 * How sure the agent was about a decision, alongside what it decided.
 *
 * null means "not recorded" — a row written before confidence existed, or a reply
 * the model returned without one. Deliberately distinct from 'low': the UI shows no
 * badge for null rather than implying the agent was unsure.
 */
export type Confidence = 'high' | 'medium' | 'low'

export const CONFIDENCE_VALUES: Confidence[] = ['high', 'medium', 'low']

/**
 * Coerces whatever the model returned into a known level, or null.
 *
 * Never defaults to 'medium'. A model that returns "very high", "0.8" or nothing at
 * all has not told us it was moderately sure — inventing a level would put a
 * confident-looking badge on a decision nobody scored, which is worse than showing
 * none. Case and surrounding whitespace are forgiven; anything else is not.
 */
export function normalizeConfidence(raw: unknown): Confidence | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().toLowerCase()
  return (CONFIDENCE_VALUES as string[]).includes(value) ? (value as Confidence) : null
}

/** Prompt wording, kept in one place so reward and draft decisions score alike. */
export const CONFIDENCE_PROMPT_GUIDANCE =
  '"high" means the evidence is clear-cut either way — obvious spam, or clearly substantive engagement. ' +
  '"medium" means the decision is reasonable but rests on partial evidence. ' +
  '"low" means genuinely ambiguous: a borderline case where reasonable people might disagree. ' +
  'Be honest — marking an uncertain call as high confidence is worse than admitting the doubt.'
