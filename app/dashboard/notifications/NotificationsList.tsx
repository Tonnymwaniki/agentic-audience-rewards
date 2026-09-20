'use client'

import { useState } from 'react'
import Link from 'next/link'
import Avatar from '@/components/Avatar'
import DraftReplyEditor from '@/components/DraftReplyEditor'
import { ESCALATION_LABELS, ESCALATION_NOTE, normalizeEscalation } from '@/lib/escalation'

export type InboxComment = {
  id: string
  text: string
  postedAt: string
  postId: string
  authorName: string
  videoTitle: string
  category: string | null
  /** Null once approved, so an answered comment stops offering Approve again. */
  draftReply: string | null
  finalReplyText: string | null
  draftConfidence: string | null
  escalationFlag: string | null
  approved: boolean
}

export type InboxItem = {
  id: string
  type: string
  message: string
  read: boolean
  createdAt: string
  /** Null only if the underlying comment was deleted out from under the row. */
  comment: InboxComment | null
}

function timeAgo(dateString: string): string {
  const diffMs = Date.now() - new Date(dateString).getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHour < 24) return `${diffHour}h ago`
  if (diffDay < 30) return `${diffDay}d ago`
  return `${Math.floor(diffDay / 30)}mo ago`
}

export default function NotificationsList({ items }: { items: InboxItem[] }) {
  // Read state is tracked here rather than re-fetched, so approving or opening a
  // card updates the row instantly; the server is told in the background.
  const [readIds, setReadIds] = useState<Set<string>>(
    () => new Set(items.filter(i => i.read).map(i => i.id))
  )

  async function markRead(id: string) {
    if (readIds.has(id)) return
    setReadIds(prev => new Set(prev).add(id))
    try {
      await fetch(`/api/notifications/${id}`, { method: 'PATCH' })
    } catch {
      // Non-fatal: the row is already styled as read, and a reload reconciles it.
    }
  }

  if (items.length === 0) {
    return (
      <section className="card text-center">
        <p className="font-display text-lg font-semibold text-text-primary">Nothing needs you right now</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">
          When your agent drafts a reply or flags a comment for you to answer personally, it lands
          here.
        </p>
        <Link
          href="/dashboard/inbox"
          className="mt-4 inline-flex min-h-11 items-center text-sm text-purple-text underline hover:text-purple-hover"
        >
          Go to My Videos
        </Link>
      </section>
    )
  }

  return (
    <ul className="space-y-3">
      {items.map(item => {
        const isRead = readIds.has(item.id)
        const comment = item.comment
        const escalation = normalizeEscalation(comment?.escalationFlag ?? null)
        const actionable = Boolean(comment?.draftReply)

        return (
          <li
            key={item.id}
            // Unread carries a left accent bar and full-strength surface; read drops
            // the accent and dims. Opacity alone was not enough to tell apart at a
            // glance on a phone, which is the whole point of the distinction.
            className={`card relative overflow-hidden transition-opacity ${
              isRead ? 'opacity-60' : ''
            }`}
          >
            {!isRead && (
              <span aria-hidden="true" className="gradient-primary absolute inset-y-0 left-0 w-1" />
            )}

            <div className="flex items-start gap-3">
              <Avatar name={comment?.authorName || 'Unknown'} size={36} />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {!isRead && (
                    <span
                      aria-label="Unread"
                      className="h-2 w-2 flex-shrink-0 rounded-full bg-purple-text"
                    />
                  )}
                  <p className="font-body text-sm font-medium text-text-primary">
                    {comment?.authorName || 'Unknown'}
                  </p>
                  {comment?.category && (
                    <span className={`badge badge-${comment.category}`}>
                      {comment.category.replace(/_/g, ' ')}
                    </span>
                  )}
                  <span className="text-xs text-text-muted">{timeAgo(item.createdAt)}</span>
                </div>

                {comment ? (
                  <>
                    <p className="mt-1.5 text-sm leading-relaxed text-text-primary">{comment.text}</p>
                    <p className="mt-1 truncate text-xs text-text-muted">on {comment.videoTitle}</p>
                  </>
                ) : (
                  <p className="mt-1.5 text-sm leading-relaxed text-text-primary">{item.message}</p>
                )}

                {/* Escalated comments deliberately carry no draft — the creator has
                    to answer personally, so the card says why instead of offering
                    a reply to approve. */}
                {escalation && (
                  <div className="mt-2 rounded-md border border-avax-red/30 bg-avax-red/10 p-3">
                    <p className="text-xs font-medium text-avax-red">
                      {ESCALATION_LABELS[escalation] ?? 'Needs your personal reply'}
                    </p>
                    <p className="mt-1 text-xs leading-snug text-text-muted">{ESCALATION_NOTE}</p>
                  </div>
                )}

                {actionable && comment && (
                  <DraftReplyEditor
                    className="mt-2"
                    commentId={comment.id}
                    draftReply={comment.draftReply!}
                    finalReplyText={comment.finalReplyText}
                    onApproved={() => void markRead(item.id)}
                  />
                )}

                {comment?.approved && (
                  <p className="mt-2 text-xs text-green">Reply approved</p>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {comment && (
                    <Link
                      href={`/dashboard/inbox/${comment.postId}`}
                      onClick={() => void markRead(item.id)}
                      className="inline-flex min-h-11 items-center text-xs text-purple-text hover:underline"
                    >
                      Open video →
                    </Link>
                  )}
                  {!isRead && (
                    <button
                      type="button"
                      onClick={() => void markRead(item.id)}
                      className="inline-flex min-h-11 items-center rounded-lg border border-white/10 px-3 text-xs font-medium text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
                    >
                      Mark as read
                    </button>
                  )}
                </div>
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
