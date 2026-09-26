/**
 * Shared protections for every PUBLIC page that shows recognition (the landing
 * page and /recognized). The people shown are real YouTube commenters who never
 * signed up to be listed, so these pages publish the praise, not the person — and
 * never the agent's internal vocabulary.
 */

/**
 * Masks a commenter's identity for this PUBLIC page.
 *
 * Everyone listed here is a real YouTube commenter who was recognized by an agent
 * — not someone who signed up, and (every row currently reads "Awaiting claim") not
 * someone who has taken any action implying they want to be listed. The praise is
 * worth showing; naming the person is not ours to do. The creator still sees full
 * handles on the authenticated Rewards page, which is where identity is needed.
 *
 * Keeps the first character so the avatar stays varied and the cards remain
 * visually distinguishable, and uses a FIXED-LENGTH mask so the handle's length —
 * itself a matching signal — is not published either.
 */
export function maskIdentity(displayName: string | null): string {
  const cleaned = (displayName ?? '').replace(/^@+/, '').trim()
  const initial = cleaned.charAt(0)
  if (!initial || !/[a-z0-9]/i.test(initial)) return 'A viewer'
  return `${initial.toUpperCase()}•••••`
}

/**
 * Removes quoted fragments of someone's own comment from the reason text.
 *
 * Republishing a person's words back at them is the same identification problem as
 * the handle: a distinctive phrase is searchable, and search leads straight back to
 * the comment and the account. The agent quotes evidence deliberately and that
 * evidence stays in the database and on the creator's own Rewards page — this
 * strips it only from the public rendering.
 *
 * A quote inside parentheses takes the parentheses with it; removing just the
 * quoted words would leave "praise ( reflects the creator's messaging)". Apostrophes
 * in contractions are untouched, because an opening delimiter is only recognised
 * after a space or an opening bracket — "creator's" and "doesn't" have a letter
 * before the apostrophe and so are never treated as quotes.
 */
export function stripQuotedFragments(text: string): string {
  const withoutParentheticals = text.replace(
    /\s*\(([^()]*)\)/g,
    (whole, inner: string) => (/["'“”‘’]/.test(inner) ? '' : whole)
  )

  const withoutQuotes = withoutParentheticals
    .replace(/["“][^"”]*["”]/g, '')
    .replace(/(^|[\s([])['‘]([^'’]+)['’](?=[\s).,;:!?\]]|$)/g, '$1')

  return withoutQuotes
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:]){2,}/g, '$1')
    .replace(/,\s*\./g, '.')
    .trim()
}

/**
 * Internal names the reward model can echo into a reason, because it sees them as
 * field names in its input (lib/rewards/evaluate.ts `signals`), as its tool names
 * (lib/rewards/evaluate-tools.ts) or as category keys. Measured on 2026-09-26:
 * "priorEngagementProfile" had reached a public card verbatim.
 */
const INTERNAL_TERMS: Record<string, string> = {
  priorEngagementProfile: 'engagement history',
  profile_summary: 'engagement history',
  totalComments: 'total comments',
  distinctPosts: 'videos commented on',
  purchaseIntentCount: 'purchase-intent comments',
  praiseCount: 'praise comments',
  questionCount: 'questions asked',
  sampleComments: 'sample comments',
  get_person_full_history: 'their full comment history',
  get_similar_rewarded_people: 'similar past recognitions',
  purchase_intent: 'purchase intent',
  business_inquiry: 'business inquiry',
}

/**
 * Replaces internal identifiers with plain words.
 *
 * Known terms get their mapped wording. Anything else that is unmistakably code —
 * snake_case, or camelCase with at least TWO interior capitals — is split into
 * ordinary lowercase words as a safety net. One interior capital is left alone on
 * purpose: real words and brands like "iPhone" or "eBay" look like that.
 * Backticks around an identifier go too.
 */
export function humanizeInternalTerms(text: string): string {
  // String.raw so the \b reaches the RegExp as a word boundary, not a backspace.
  const known = new RegExp(String.raw`\b(${Object.keys(INTERNAL_TERMS).join('|')})\b`, 'g')
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(known, term => INTERNAL_TERMS[term])
    .replace(/\b[a-z]+(?:[A-Z][a-z0-9]+){2,}\b/g, id => id.replace(/([A-Z])/g, ' $1').toLowerCase())
    .replace(/\b[a-z]+(?:_[a-z0-9]+)+\b/g, id => id.replace(/_/g, ' '))
}

/** The reason as it may appear publicly: no internal vocabulary, no quoted comment text. */
export function publicReason(reason: string | null | undefined): string {
  return stripQuotedFragments(humanizeInternalTerms(reason ?? ''))
}

/**
 * A reason left mostly empty by stripping (it was largely quotation) is too thin
 * to stand as proof of anything, so it isn't shown.
 */
export const MIN_PUBLIC_REASON_LENGTH = 40
