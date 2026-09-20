/**
 * The seven comment categories, their display labels and their colours.
 *
 * Extracted from the video detail page's CommentsList so Agent Home's breakdown
 * widget shows a category in the same colour the video page does — a creator
 * seeing teal on the summary and teal on the detail should be reading the same
 * thing both times.
 */

export type CommentCategory =
  | 'question'
  | 'praise'
  | 'complaint'
  | 'purchase_intent'
  | 'content_request'
  | 'spam'
  | 'other'

export const CATEGORY_STYLES: Record<string, { label: string; bg: string; accent: string }> = {
  question: { label: 'Question', bg: 'rgba(59, 130, 246, 0.22)', accent: '#93c5fd' },
  praise: { label: 'Praise', bg: 'rgba(34, 197, 94, 0.22)', accent: '#86efac' },
  complaint: { label: 'Complaint', bg: 'rgba(239, 68, 68, 0.22)', accent: '#fca5a5' },
  purchase_intent: { label: 'Purchase Intent', bg: 'rgba(236, 72, 153, 0.22)', accent: '#F9A8D4' },
  content_request: { label: 'Content Request', bg: 'rgba(45, 212, 191, 0.22)', accent: '#5eead4' },
  spam: { label: 'Spam', bg: 'rgba(148, 163, 184, 0.22)', accent: '#cbd5e1' },
  other: { label: 'Other', bg: 'rgba(100, 116, 139, 0.22)', accent: '#94a3b8' },
}

export const CATEGORY_ORDER = [
  'question',
  'praise',
  'complaint',
  'purchase_intent',
  'content_request',
  'spam',
  'other',
]

/** Falls back to the raw key with underscores humanised, for any unknown value. */
export function categoryLabel(category: string): string {
  return CATEGORY_STYLES[category]?.label || category.replace(/_/g, ' ')
}
