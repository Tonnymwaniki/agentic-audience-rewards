/**
 * The muted "Evidence: …" line shown under a claim that quotes aggregate counts.
 *
 * Separate from the chat component so the wording can be unit-tested on its own —
 * it's the one piece of citation rendering with real logic in it.
 */

/** "3 videos" / "1 video". */
function videoPhrase(count: number): string {
  return `${count.toLocaleString()} video${count === 1 ? '' : 's'}`
}

/**
 * One line for every aggregate cited in a paragraph.
 *
 * Counts that share a video count collapse into "96, 58 and 8 comments across 3
 * videos" — the common case, since a channel's themes are drawn from the same
 * videos. Aggregates spanning different numbers of videos can't be collapsed without
 * misstating them, so those are listed separately, joined by a semicolon.
 */
export function formatAggregateEvidence(aggregates: Array<{ comment_count: number; video_count: number }>): string {
  const byVideoCount = new Map<number, number[]>()
  for (const a of aggregates) {
    byVideoCount.set(a.video_count, [...(byVideoCount.get(a.video_count) ?? []), a.comment_count])
  }
  const parts = [...byVideoCount].map(([videoCount, comments]) => {
    const list =
      comments.length === 1
        ? comments[0].toLocaleString()
        : `${comments
            .slice(0, -1)
            .map(n => n.toLocaleString())
            .join(', ')} and ${comments[comments.length - 1].toLocaleString()}`
    const plural = comments.length > 1 || comments[0] !== 1 ? 's' : ''
    return `${list} comment${plural} across ${videoPhrase(videoCount)}`
  })
  return parts.join('; ')
}
