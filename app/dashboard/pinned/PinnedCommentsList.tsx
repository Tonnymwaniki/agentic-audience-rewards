'use client'

import { useState } from 'react'
import Link from 'next/link'
import Avatar from '@/components/Avatar'
import DraftReplyEditor from '@/components/DraftReplyEditor'

export type PinnedComment = {
  id: string
  text: string
  postedAt: string
  authorName: string
  /** The channel owner pinned their own comment (an announcement, not something to answer). */
  isSelfPin: boolean
  category: string | null
  draftReply: string | null
  finalReplyText: string | null
  approved: boolean
  draftLocked: boolean
  replySendStatus: string | null
  replyAutoSent: boolean
  ownerAlreadyReplied: boolean
  ownerReplyText: string | null
}

export type PinnedItem = {
  postId: string
  videoTitle: string
  /** false = only our relevance-order guess; true = the creator confirmed it. */
  pinnedConfirmed: boolean
  comment: PinnedComment
}

export default function PinnedCommentsList({ items }: { items: PinnedItem[] }) {
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({})
  const [cleared, setCleared] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [error, setError] = useState<Record<string, string>>({})
  const [regenerated, setRegenerated] = useState<Record<string, string>>({})
  const [regenerating, setRegenerating] = useState<Set<string>>(new Set())

  async function act(postId: string, action: 'confirm' | 'clear') {
    setBusy(prev => new Set(prev).add(postId))
    setError(prev => {
      const next = { ...prev }
      delete next[postId]
      return next
    })
    try {
      const res = await fetch(`/api/creator/pinned/${postId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) throw new Error('Failed')
      if (action === 'confirm') setConfirmed(prev => ({ ...prev, [postId]: true }))
      else setCleared(prev => new Set(prev).add(postId))
    } catch {
      setError(prev => ({ ...prev, [postId]: 'Could not save — try again.' }))
    } finally {
      setBusy(prev => {
        const next = new Set(prev)
        next.delete(postId)
        return next
      })
    }
  }

  async function generateReply(commentId: string) {
    setRegenerating(prev => new Set(prev).add(commentId))
    try {
      const res = await fetch('/api/draft-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment_id: commentId }),
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.draft_reply) setRegenerated(prev => ({ ...prev, [commentId]: data.draft_reply }))
    } finally {
      setRegenerating(prev => {
        const next = new Set(prev)
        next.delete(commentId)
        return next
      })
    }
  }

  const visible = items.filter(i => !cleared.has(i.postId))

  if (visible.length === 0) {
    return (
      <section className="card text-center">
        <p className="font-display text-lg font-semibold text-text-primary">No pinned comments found yet</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">
          When a video is (re-)analyzed, Notice makes a best-effort guess at which comment is pinned.
        </p>
      </section>
    )
  }

  return (
    <ul className="space-y-3">
      {visible.map(item => {
        const { comment } = item
        const isConfirmed = item.pinnedConfirmed || confirmed[item.postId]
        const liveDraftReply = regenerated[comment.id] || comment.draftReply || null
        const actionable = Boolean(liveDraftReply) && !comment.isSelfPin

        return (
          <li key={item.postId} className="card relative overflow-hidden">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span
                className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide ${
                  isConfirmed ? 'bg-green/15 text-green' : 'bg-surface-hover text-text-muted'
                }`}
              >
                {isConfirmed ? 'Confirmed pinned' : 'Guessed pinned — not confirmed'}
              </span>
              {!isConfirmed && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void act(item.postId, 'confirm')}
                    disabled={busy.has(item.postId)}
                    className="inline-flex min-h-9 items-center rounded-lg border border-white/10 px-3 text-xs font-medium text-text-primary transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Yes, this is pinned
                  </button>
                  <button
                    type="button"
                    onClick={() => void act(item.postId, 'clear')}
                    disabled={busy.has(item.postId)}
                    className="inline-flex min-h-9 items-center rounded-lg border border-white/10 px-3 text-xs font-medium text-text-muted transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Wrong comment
                  </button>
                </div>
              )}
              {error[item.postId] && <span className="text-xs text-avax-red">{error[item.postId]}</span>}
            </div>

            <div className="flex items-start gap-3">
              <Avatar name={comment.authorName} size={36} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <p className="font-body text-sm font-medium text-text-primary">{comment.authorName}</p>
                  {comment.isSelfPin && <span className="badge">your own comment</span>}
                  {comment.category && !comment.isSelfPin && (
                    <span className={`badge badge-${comment.category}`}>{comment.category.replace(/_/g, ' ')}</span>
                  )}
                </div>
                <p className="mt-1 text-sm leading-relaxed text-text-primary">{comment.text}</p>
                <p className="mt-1 truncate text-xs text-text-muted">on {item.videoTitle}</p>
              </div>
            </div>

            {/* The reply, directly below the pinned comment — the whole point of
                this page over hunting through a video's full comment list. */}
            <div className="mt-2">
              {comment.isSelfPin ? (
                <p className="rounded-md border border-white/10 bg-surface-hover p-3 text-xs leading-snug text-text-muted">
                  You pinned your own comment — treated as an announcement, not something to reply to.
                </p>
              ) : comment.ownerAlreadyReplied ? (
                <div className="rounded-md border border-green/20 bg-green/5 p-3">
                  <p className="text-xs font-medium text-green">You already replied</p>
                  {comment.ownerReplyText && <p className="mt-1 text-xs leading-relaxed text-text-primary">{comment.ownerReplyText}</p>}
                </div>
              ) : comment.approved ? (
                <div className="rounded-md border border-green/20 bg-green/5 p-3">
                  <p className="text-xs font-medium text-green">
                    {comment.replySendStatus === 'sent'
                      ? comment.replyAutoSent
                        ? 'Sent automatically'
                        : 'Reply approved and sent'
                      : comment.replySendStatus === 'failed'
                        ? 'Approved, but sending to YouTube failed'
                        : 'Reply approved'}
                  </p>
                  {comment.finalReplyText && <p className="mt-1 text-xs leading-relaxed text-text-primary">{comment.finalReplyText}</p>}
                </div>
              ) : actionable ? (
                <DraftReplyEditor className="mt-1" commentId={comment.id} draftReply={liveDraftReply!} finalReplyText={comment.finalReplyText} />
              ) : comment.draftLocked ? (
                <p className="rounded-md border border-white/10 bg-surface-hover p-3 text-xs leading-snug text-text-muted">
                  A reply was drafted before channel verification existed and can&apos;t be approved until ownership is
                  verified.{' '}
                  <a href="/api/auth/youtube/start" className="text-purple-text underline hover:text-purple-hover">
                    Verify ownership
                  </a>
                </p>
              ) : (
                <div className="rounded-md border border-white/10 bg-surface-hover p-3">
                  <p className="text-xs leading-snug text-text-muted">No reply yet.</p>
                  <button
                    type="button"
                    onClick={() => void generateReply(comment.id)}
                    disabled={regenerating.has(comment.id)}
                    className="mt-2 inline-flex min-h-9 items-center rounded-lg border border-white/10 px-3 text-xs font-medium text-text-primary transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {regenerating.has(comment.id) ? 'Drafting…' : 'Draft a reply'}
                  </button>
                </div>
              )}
            </div>

            <div className="mt-3">
              <Link href={`/dashboard/inbox/${item.postId}`} className="inline-flex min-h-11 items-center text-xs text-purple-text hover:underline">
                Open video →
              </Link>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
