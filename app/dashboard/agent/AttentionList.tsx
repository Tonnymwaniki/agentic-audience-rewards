'use client'

import { useState } from 'react'
import Link from 'next/link'
import Avatar from '@/components/Avatar'
import type { Highlight } from '@/lib/highlights'
import DraftReplyEditor from '@/components/DraftReplyEditor'

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
            <DraftReplyEditor
              className="mt-2"
              commentId={item.id}
              draftReply={item.draftReply}
              finalReplyText={item.finalReplyText}
              onApproved={() => onApprove(item.id)}
            />
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
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
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set())

  // Dismiss only. DraftReplyEditor owns the save and calls back on success, so this
  // must NOT post to the approve endpoint as well — a second request would carry no
  // final_reply_text and would overwrite the creator's edit with the raw draft,
  // silently resetting reply_was_edited to false.
  function approve(commentId: string) {
    setDismissedIds(prev => new Set(prev).add(commentId))
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
      {visible.map(item => (
        <AttentionCard key={item.id} item={item} onApprove={approve} />
      ))}
    </div>
  )
}
