// Shared repeated-comment grouping — the same normalize-and-group approach the
// Repeated Comments page uses. Lives here so the Research chat's get_trending tool
// and the Research sidebar's "Trending Topics" card can't drift apart.

export type TrendingComment = {
  text: string
  post_id: string
  audience_member_id: string | null
}

export type TrendingGroup = {
  text: string
  count: number
  unique_people: number
  video_titles: string[]
}

export function normalizeText(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ')
}

export function computeTrendingGroups(
  comments: TrendingComment[],
  postMap: Map<string, string>,
  minCount: number
): TrendingGroup[] {
  const normalizedGroups = new Map<string, TrendingComment[]>()

  for (const comment of comments) {
    const key = normalizeText(comment.text)
    const existing = normalizedGroups.get(key) || []
    existing.push(comment)
    normalizedGroups.set(key, existing)
  }

  const groups: TrendingGroup[] = []

  for (const entries of normalizedGroups.values()) {
    const uniqueMembers = new Set(entries.map(e => e.audience_member_id).filter(Boolean))
    // "Trending" means multiple different people said it — not one person repeating.
    if (uniqueMembers.size < 2 || entries.length < minCount) continue

    groups.push({
      text: entries[0].text,
      count: entries.length,
      unique_people: uniqueMembers.size,
      video_titles: Array.from(new Set(entries.map(e => postMap.get(e.post_id) || 'Untitled video'))),
    })
  }

  groups.sort((a, b) => b.count - a.count)
  return groups
}
