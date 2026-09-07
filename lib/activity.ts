// Shared shaping for the "recent activity" stream that Agent Home and the Research
// sidebar both render.
//
// Deliberately a PURE function rather than a loader: both callers already fetch
// comments, categories and reward events for their own stats, so a self-fetching
// helper would re-read the same tables a third time on a page that is already
// query-heavy. Callers pass in what they have; this decides ordering and wording.

export type ActivityKind = 'notification' | 'pending_draft' | 'reward'

export type ActivityItem = {
  kind: ActivityKind
  text: string
  at: string | null
}

export type ActivityInput = {
  notifications?: Array<{ message: string; at: string | null }>
  pendingDrafts?: Array<{ category: string; videoTitle: string; at: string | null }>
  rewards?: Array<{ personName: string; reason: string; at: string | null }>
}

function humanCategory(category: string): string {
  return category.replace(/_/g, ' ')
}

/**
 * Merges the three streams into one newest-first list, capped to `limit`.
 *
 * Undated entries sort last rather than to the top — treating a missing timestamp
 * as epoch 0 would be a silent lie about recency, and -Infinity keeps them
 * visible but at the bottom.
 */
export function buildActivityFeed(input: ActivityInput, limit: number): ActivityItem[] {
  const items: ActivityItem[] = []

  for (const notification of input.notifications || []) {
    items.push({ kind: 'notification', text: notification.message, at: notification.at })
  }

  for (const draft of input.pendingDrafts || []) {
    items.push({
      kind: 'pending_draft',
      text: `Reply drafted for a ${humanCategory(draft.category)} comment on “${draft.videoTitle}” — waiting on your approval.`,
      at: draft.at,
    })
  }

  for (const reward of input.rewards || []) {
    items.push({ kind: 'reward', text: `${reward.personName} recognized — ${reward.reason}`, at: reward.at })
  }

  items.sort((a, b) => {
    const aTime = a.at ? new Date(a.at).getTime() : -Infinity
    const bTime = b.at ? new Date(b.at).getTime() : -Infinity
    return bTime - aTime
  })

  return items.slice(0, limit)
}
