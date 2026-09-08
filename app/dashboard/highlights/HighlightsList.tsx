'use client'

import { useState } from 'react'
import Link from 'next/link'
import Avatar from '@/components/Avatar'
import type { Highlight } from '@/lib/highlights'
import DraftReplyEditor from '@/components/DraftReplyEditor'
import ConfidenceBadge from '@/components/ConfidenceBadge'
import { ESCALATION_LABELS, ESCALATION_NOTE, normalizeEscalation } from '@/lib/escalation'

type HighlightsListProps = {
  draftHighlights: Highlight[]
  escalatedHighlights: Highlight[]
  repeatedHighlights: Highlight[]
}

function timeAgo(dateString: string): string {
  const diffMs = Date.now() - new Date(dateString).getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHour < 24) return `${diffHour}h ago`
  return `${diffDay}d ago`
}

function reasonLabel(highlight: Highlight): string {
  if (highlight.reason === 'pending_draft') return 'Needs a reply'
  return `Trending — repeated ${highlight.repeatCount}x`
}

export default function HighlightsList({
  draftHighlights,
  escalatedHighlights,
  repeatedHighlights,
}: HighlightsListProps) {
  const [dismissedDraftIds, setDismissedDraftIds] = useState<Set<string>>(new Set())

  // The save request now lives in DraftReplyEditor, which only calls back on
  // success — so this dismisses on a confirmed write rather than optimistically and
  // then un-dismissing on failure. The editor shows the error in place instead.
  function approveDraft(commentId: string) {
    setDismissedDraftIds(prev => new Set(prev).add(commentId))
  }

  const visibleDrafts = draftHighlights.filter(h => !dismissedDraftIds.has(h.id))

  if (
    visibleDrafts.length === 0 &&
    escalatedHighlights.length === 0 &&
    repeatedHighlights.length === 0
  ) {
    return (
      <div className="card p-8 text-center">
        <p className="text-sm text-text-muted">Nothing needs your attention right now.</p>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* First on the page: these are the only comments the agent declined to
          handle, so they should be the first thing the creator sees. */}
      {escalatedHighlights.length > 0 && (
        <section>
          <h2 className="mb-1 font-display text-lg font-semibold text-text-primary">
            Needs your personal attention
          </h2>
          <p className="mb-3 text-sm text-text-muted">{ESCALATION_NOTE}</p>
          <div className="space-y-4">
            {escalatedHighlights.map(highlight => (
              <EscalatedCard key={highlight.id} highlight={highlight} />
            ))}
          </div>
        </section>
      )}

      {visibleDrafts.length > 0 && (
        <section>
          <h2 className="mb-3 font-display text-lg font-semibold text-text-primary">Needs a Reply</h2>
          <div className="space-y-4">
            {visibleDrafts.map(highlight => (
              <HighlightCard key={highlight.id} highlight={highlight} onApproveDraft={approveDraft} />
            ))}
          </div>
        </section>
      )}

      {repeatedHighlights.length > 0 && (
        <section>
          <h2 className="mb-3 font-display text-lg font-semibold text-text-primary">Trending</h2>
          <div className="space-y-4">
            {repeatedHighlights.map(highlight => (
              <HighlightCard key={highlight.id} highlight={highlight} onApproveDraft={approveDraft} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

/**
 * An escalated comment. Shows the comment and nothing else — no drafted reply, no
 * Approve button, no Copy. The absence of those controls is the feature: there is
 * deliberately nothing here to accept without reading.
 */
function EscalatedCard({ highlight }: { highlight: Highlight }) {
  const flag = normalizeEscalation(highlight.escalationFlag)

  return (
    <div className="card border-avax-red/30">
      <div className="flex items-center justify-between gap-2">
        <Link
          href={`/dashboard/inbox/${highlight.postId}`}
          className="min-w-0 truncate text-xs text-text-muted underline hover:text-text-primary"
        >
          {highlight.videoTitle}
        </Link>
        {flag && (
          <span className="flex-shrink-0 rounded-full border border-avax-red/40 bg-avax-red/15 px-2 py-0.5 font-mono text-[10px] tracking-wide text-avax-red uppercase">
            {ESCALATION_LABELS[flag]}
          </span>
        )}
      </div>

      <div className="mt-3 flex items-start gap-3">
        <Avatar name={highlight.authorName} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="font-body text-sm font-medium text-text-primary">{highlight.authorName}</p>
            <span className="text-xs text-text-muted">{timeAgo(highlight.postedAt)}</span>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-text-primary">{highlight.text}</p>
        </div>
      </div>
    </div>
  )
}

function HighlightCard({
  highlight,
  onApproveDraft,
}: {
  highlight: Highlight
  onApproveDraft: (commentId: string) => void
}) {
  return (
    <div className="card">
      <div className="flex items-center justify-between gap-2">
        <Link
          href={`/dashboard/inbox/${highlight.postId}`}
          // min-w-0: `truncate` implies white-space:nowrap, and a flex item's
          // default min-width:auto would let a long title force the page wider than
          // the viewport instead of ellipsising.
          className="min-w-0 truncate text-xs text-text-muted underline hover:text-text-primary"
        >
          {highlight.videoTitle}
        </Link>
        <span
          className={`flex-shrink-0 text-xs font-medium ${
            highlight.reason === 'pending_draft' ? 'text-purple-text' : 'text-avax-red'
          }`}
        >
          {reasonLabel(highlight)}
        </span>
      </div>

      <div className="mt-3 flex items-start gap-3">
        <Avatar name={highlight.authorName} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="font-body text-sm font-medium text-text-primary">{highlight.authorName}</p>
            <span className="text-xs text-text-muted">{timeAgo(highlight.postedAt)}</span>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-text-primary">{highlight.text}</p>

          {highlight.reason === 'pending_draft' && highlight.draftReply && (
            <>
              {/* Above the editor, so uncertainty is visible before the creator
                  starts reading the drafted text as if it were settled. */}
              <div className="mt-3">
                <ConfidenceBadge confidence={highlight.draftConfidence} />
              </div>
              <DraftReplyEditor
                className="mt-2"
                commentId={highlight.id}
                draftReply={highlight.draftReply}
                finalReplyText={highlight.finalReplyText}
                onApproved={() => onApproveDraft(highlight.id)}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
