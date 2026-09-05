'use client'

import { useState } from 'react'
import Link from 'next/link'
import Avatar from '@/components/Avatar'

export type Highlight = {
  id: string
  text: string
  postedAt: string
  authorName: string
  postId: string
  videoTitle: string
  reason: 'pending_draft' | 'repeated'
  draftReply: string | null
  repeatCount: number | null
}

type HighlightsListProps = {
  draftHighlights: Highlight[]
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

export default function HighlightsList({ draftHighlights, repeatedHighlights }: HighlightsListProps) {
  const [dismissedDraftIds, setDismissedDraftIds] = useState<Set<string>>(new Set())

  async function approveDraft(commentId: string) {
    setDismissedDraftIds(prev => new Set(prev).add(commentId))

    try {
      const res = await fetch('/api/draft-reply/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment_id: commentId }),
      })
      if (!res.ok) {
        setDismissedDraftIds(prev => {
          const next = new Set(prev)
          next.delete(commentId)
          return next
        })
      }
    } catch {
      setDismissedDraftIds(prev => {
        const next = new Set(prev)
        next.delete(commentId)
        return next
      })
    }
  }

  const visibleDrafts = draftHighlights.filter(h => !dismissedDraftIds.has(h.id))

  if (visibleDrafts.length === 0 && repeatedHighlights.length === 0) {
    return (
      <div className="card p-8 text-center">
        <p className="text-sm text-text-muted">Nothing needs your attention right now.</p>
      </div>
    )
  }

  return (
    <div className="space-y-8">
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
          className="truncate text-xs text-text-muted underline hover:text-text-primary"
        >
          {highlight.videoTitle}
        </Link>
        <span
          className={`flex-shrink-0 text-xs font-medium ${
            highlight.reason === 'pending_draft' ? 'text-cobalt' : 'text-avax-red'
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
            <div className="mt-3 rounded-md bg-surface-hover p-3">
              <p className="mb-1 text-xs font-medium text-text-muted">Drafted reply</p>
              <p className="text-sm text-text-primary">{highlight.draftReply}</p>
              <div className="mt-2 flex flex-wrap gap-3">
                <button onClick={() => onApproveDraft(highlight.id)} className="btn-primary text-xs">
                  Approve
                </button>
                <CopyReplyButton text={highlight.draftReply} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function CopyReplyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard unavailable
    }
  }

  return (
    <button onClick={handleCopy} className="text-xs text-text-muted underline hover:text-text-primary">
      {copied ? 'Copied!' : 'Copy Reply'}
    </button>
  )
}
