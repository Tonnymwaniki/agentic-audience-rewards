'use client'

import { useState } from 'react'
import Link from 'next/link'
import Avatar from '@/components/Avatar'
import type { Highlight } from '@/lib/highlights'

// A compact preview of the Highlights page's "Needs a Reply" section. Same data,
// same approve endpoint — denser layout, and capped to a few items.

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
    <button
      onClick={handleCopy}
      className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
    >
      {copied ? 'Copied!' : 'Copy reply'}
    </button>
  )
}

function AttentionCard({
  item,
  onApprove,
}: {
  item: Highlight
  onApprove: (commentId: string) => void
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-surface-hover p-4">
      <div className="flex items-start gap-3">
        <Avatar name={item.authorName} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="font-body text-sm font-medium text-text-primary">{item.authorName}</p>
            {item.category && (
              <span className={`badge badge-${item.category}`}>{item.category.replace(/_/g, ' ')}</span>
            )}
            <span className="text-xs text-text-muted">{timeAgo(item.postedAt)}</span>
          </div>

          <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-text-primary">{item.text}</p>

          {item.draftReply && (
            <p className="mt-2 line-clamp-2 border-l-2 border-purple pl-2.5 text-sm leading-relaxed text-text-muted">
              {item.draftReply}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() => onApprove(item.id)}
              className="btn-primary px-3 py-1.5 text-xs"
            >
              Approve
            </button>
            {item.draftReply && <CopyReplyButton text={item.draftReply} />}
            <Link
              href={`/dashboard/inbox/${item.postId}`}
              // min-w-0 is load-bearing, not decorative. `truncate` sets
              // white-space:nowrap, and a flex item defaults to min-width:auto —
              // its content-based minimum. A long video title therefore refused to
              // shrink and forced the whole page wider than the viewport. min-w-0
              // lets it shrink so the ellipsis actually engages.
              className="min-w-0 flex-1 truncate text-xs text-text-muted underline transition-colors hover:text-text-primary"
            >
              {item.videoTitle}
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function AttentionList({ items }: { items: Highlight[] }) {
  // Optimistic: the card leaves the list immediately, and comes back if the
  // approve call fails, so a failure is visible rather than silently swallowed.
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set())
  const [failedId, setFailedId] = useState<string | null>(null)

  async function approve(commentId: string) {
    setFailedId(null)
    setDismissedIds(prev => new Set(prev).add(commentId))

    const restore = () => {
      setDismissedIds(prev => {
        const next = new Set(prev)
        next.delete(commentId)
        return next
      })
      setFailedId(commentId)
    }

    try {
      const res = await fetch('/api/draft-reply/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment_id: commentId }),
      })
      if (!res.ok) restore()
    } catch {
      restore()
    }
  }

  const visible = items.filter(item => !dismissedIds.has(item.id))

  if (visible.length === 0) {
    return (
      <p className="rounded-lg border border-white/10 bg-surface-hover p-6 text-center text-sm text-text-muted">
        Nothing needs your attention right now.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {failedId && (
        <p className="text-xs text-avax-red">
          That reply couldn&apos;t be approved — please try again.
        </p>
      )}
      {visible.map(item => (
        <AttentionCard key={item.id} item={item} onApprove={approve} />
      ))}
    </div>
  )
}
