/**
 * Citations for Research chat answers.
 *
 * Tools register the comments and videos they return and get back a short ref
 * ("C3", "V1") to include in their output. The model cites those refs in its
 * answer, and extractCitations turns them into a validated source list.
 *
 * Short refs rather than raw UUIDs, because a model copying a 36-character id is
 * where citations quietly go wrong; and refs are only honoured if a tool actually
 * returned them this turn, so an answer can never cite evidence that wasn't
 * gathered.
 */

export type CommentEvidence = {
  ref: string
  type: 'comment'
  comment_id: string
  text: string
  author: string | null
  post_id: string | null
  video_title: string | null
}

export type VideoEvidence = {
  ref: string
  type: 'video'
  post_id: string
  title: string
}

export type Evidence = CommentEvidence | VideoEvidence

export class EvidenceRegistry {
  private byKey = new Map<string, Evidence>()
  private byRef = new Map<string, Evidence>()
  private comments = 0
  private videos = 0

  /** Registers a comment (idempotent by id) and returns its ref. */
  comment(input: { id: string; text: string; author?: string | null; post_id?: string | null; video_title?: string | null }): string {
    const key = `comment:${input.id}`
    const existing = this.byKey.get(key)
    if (existing) return existing.ref

    const ref = `C${++this.comments}`
    const evidence: CommentEvidence = {
      ref,
      type: 'comment',
      comment_id: input.id,
      text: input.text,
      author: input.author ?? null,
      post_id: input.post_id ?? null,
      video_title: input.video_title ?? null,
    }
    this.byKey.set(key, evidence)
    this.byRef.set(ref, evidence)
    return ref
  }

  /** Registers a video (idempotent by post id) and returns its ref. */
  video(postId: string, title: string): string {
    const key = `video:${postId}`
    const existing = this.byKey.get(key)
    if (existing) return existing.ref

    const ref = `V${++this.videos}`
    const evidence: VideoEvidence = { ref, type: 'video', post_id: postId, title }
    this.byKey.set(key, evidence)
    this.byRef.set(ref, evidence)
    return ref
  }

  get(ref: string): Evidence | undefined {
    return this.byRef.get(ref)
  }

  get size(): number {
    return this.byRef.size
  }
}

/** A citation marker: [C3], [V1], or a group like [C3, C7] / [C3][V1]. */
const CITATION_GROUP = /\s?\[((?:[CV]\d+)(?:\s*[,;]\s*[CV]\d+)*)\]/g

export type CitationResult = {
  /** The answer with markers normalised to [C3][V1] and unknown refs removed. */
  text: string
  /** Evidence actually cited, in order of first citation. */
  sources: Evidence[]
  /** Refs the answer used that no tool returned this turn — dropped from the text. */
  invalid_refs: string[]
}

/**
 * Validates an answer's citations against what tools returned this turn, and
 * renumbers them in the order they're cited.
 *
 * Renumbering matters to the reader: tools number comments as they return them,
 * so the first citations in an answer could read [C1] [C22] [C25]. Shown to a
 * creator that looks like a broken list; C1, C2, C3 in reading order doesn't.
 */
export function extractCitations(answer: string, registry: EvidenceRegistry): CitationResult {
  const sources: Evidence[] = []
  const displayRef = new Map<string, string>()
  const invalid: string[] = []
  let comments = 0
  let videos = 0

  const text = answer.replace(CITATION_GROUP, (match: string, group: string) => {
    const refs = group.split(/\s*[,;]\s*/)
    const shown: string[] = []
    for (const ref of refs) {
      const evidence = registry.get(ref)
      if (!evidence) {
        if (!invalid.includes(ref)) invalid.push(ref)
        continue
      }
      let display = displayRef.get(ref)
      if (!display) {
        display = evidence.type === 'comment' ? `C${++comments}` : `V${++videos}`
        displayRef.set(ref, display)
        sources.push({ ...evidence, ref: display })
      }
      if (!shown.includes(display)) shown.push(display)
    }
    if (shown.length === 0) return ''
    // Keep the single leading space the marker had, so "claim [C1]" stays readable.
    const lead = match.startsWith(' ') ? ' ' : ''
    return lead + shown.map(r => `[${r}]`).join('')
  })

  return { text, sources, invalid_refs: invalid }
}
