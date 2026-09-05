'use client'

import { useState, useEffect, useRef } from 'react'
import Avatar from '@/components/Avatar'

type Comment = {
  id: string
  text: string
  postedAt: string
  authorName: string
  category: string
  topic: string | null
  hasReward?: boolean
  draftReply?: string | null
  profileSummary?: string | null
}

type CommentsListProps = {
  comments: Comment[]
  peopleNoticed: number
  repeatedCommentIds?: string[]
}

function timeAgo(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  if (diffSec < 60) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHour < 24) return `${diffHour}h ago`
  if (diffDay < 7) return `${diffDay}d ago`
  return date.toLocaleDateString()
}

// Muted/darkened tints of each category's existing badge hue (see .badge-* in
// globals.css) — rendered at low alpha over the app's near-black background so
// the whole card reads as that color without looking like a bright UI-kit swatch.
const CATEGORY_STYLES: Record<string, { label: string; bg: string; accent: string }> = {
  question: { label: 'Question', bg: 'rgba(59, 130, 246, 0.22)', accent: '#93c5fd' },
  praise: { label: 'Praise', bg: 'rgba(34, 197, 94, 0.22)', accent: '#86efac' },
  complaint: { label: 'Complaint', bg: 'rgba(239, 68, 68, 0.22)', accent: '#fca5a5' },
  purchase_intent: { label: 'Purchase Intent', bg: 'rgba(255, 127, 236, 0.22)', accent: '#FF7FEC' },
  spam: { label: 'Spam', bg: 'rgba(148, 163, 184, 0.22)', accent: '#cbd5e1' },
  other: { label: 'Other', bg: 'rgba(100, 116, 139, 0.22)', accent: '#94a3b8' },
}

const CATEGORY_ORDER = ['question', 'praise', 'complaint', 'purchase_intent', 'spam', 'other']

const SWIPE_THRESHOLD_PX = 50

export default function CommentsList({ comments, peopleNoticed, repeatedCommentIds }: CommentsListProps) {
  // null = category-summary-cards view (the only entry point now — there is no "all").
  const [category, setCategory] = useState<string | null>(null)
  const [commentIndex, setCommentIndex] = useState(0)
  const [expandedDrafts, setExpandedDrafts] = useState<Set<string>>(new Set())
  const [copyingId, setCopyingId] = useState<string | null>(null)
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null)
  const [draftErrors, setDraftErrors] = useState<Set<string>>(new Set())
  const [draftReplies, setDraftReplies] = useState<Map<string, string>>(new Map())
  const touchStartX = useRef<number | null>(null)

  // Picking a new category always starts back at the first comment.
  useEffect(() => {
    setCommentIndex(0)
  }, [category])

  const filtered = category === null ? [] : comments.filter(c => c.category === category)
  const current = filtered[commentIndex] ?? null

  function getDraftReply(comment: Comment): string | null {
    return draftReplies.get(comment.id) ?? comment.draftReply ?? null
  }

  function toggleDraft(commentId: string) {
    setExpandedDrafts(prev => {
      const next = new Set(prev)
      if (next.has(commentId)) {
        next.delete(commentId)
      } else {
        next.add(commentId)
      }
      return next
    })
  }

  async function copyReply(commentId: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopyingId(commentId)
      setTimeout(() => setCopyingId(null), 2000)
    } catch {
      // clipboard unavailable
    }
  }

  async function regenerateDraft(commentId: string) {
    setRegeneratingId(commentId)
    setDraftErrors(prev => {
      const next = new Set(prev)
      next.delete(commentId)
      return next
    })

    try {
      const response = await fetch('/api/draft-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment_id: commentId }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to regenerate')
      }

      const comment = comments.find(c => c.id === commentId)
      if (comment) {
        setDraftReplies(prev => new Map(prev).set(commentId, data.draft_reply))
      }
    } catch (err) {
      setDraftErrors(prev => new Set(prev).add(commentId))
      console.error('Regenerate draft error:', err)
    } finally {
      setRegeneratingId(null)
    }
  }

  function goToPrevious() {
    setCommentIndex(i => Math.max(0, i - 1))
  }

  function goToNext() {
    setCommentIndex(i => Math.min(filtered.length - 1, i + 1))
  }

  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0]?.clientX ?? null
  }

  function handleTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return
    const deltaX = (e.changedTouches[0]?.clientX ?? touchStartX.current) - touchStartX.current
    touchStartX.current = null

    if (deltaX > SWIPE_THRESHOLD_PX) {
      goToPrevious()
    } else if (deltaX < -SWIPE_THRESHOLD_PX) {
      goToNext()
    }
  }

  if (category === null) {
    return (
      <CategorySummary
        comments={comments}
        peopleNoticed={peopleNoticed}
        onSelectCategory={setCategory}
      />
    )
  }

  return (
    <div>
      <button
        onClick={() => setCategory(null)}
        className="mb-4 inline-flex items-center text-sm text-text-muted hover:text-text-primary"
      >
        ← Back to categories
      </button>

      {!current ? (
        <p className="text-sm text-text-muted">No comments in this category.</p>
      ) : (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <span className={`badge badge-${current.category}`}>
              {CATEGORY_STYLES[current.category]?.label || current.category.replace('_', ' ')}
            </span>
            <p className="text-sm text-text-muted">
              Comment {commentIndex + 1} of {filtered.length}
            </p>
          </div>

          <div
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            className="card p-6 sm:p-8"
          >
            <div className="flex items-start gap-4">
              <Avatar name={current.authorName} size={56} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-body text-base font-medium text-text-primary">{current.authorName}</p>
                  {current.hasReward && (
                    <span className="text-sm text-pink">Noticed ✦</span>
                  )}
                  {repeatedCommentIds && repeatedCommentIds.includes(current.id) && (
                    <span className="text-sm text-avax-red">🚩 Repeated</span>
                  )}
                  <span className="text-xs font-mono text-text-muted">{timeAgo(current.postedAt)}</span>
                </div>

                <p className="mt-3 text-lg leading-relaxed text-text-primary">{current.text}</p>

                {current.topic && (
                  <span className="mt-3 inline-block text-xs text-text-muted">{current.topic}</span>
                )}

                {current.profileSummary && (
                  <div className="mt-4 rounded-md bg-surface-hover p-3">
                    <p className="text-xs font-medium text-text-muted">🧠 What we know about this person</p>
                    <p className="mt-1 text-sm italic text-text-muted">{current.profileSummary}</p>
                  </div>
                )}

                {getDraftReply(current) && (
                  <div className="mt-5">
                    <button
                      onClick={() => toggleDraft(current.id)}
                      className="text-sm font-medium text-cobalt hover:text-cobalt-hover"
                    >
                      💬 Suggested reply
                    </button>
                    {expandedDrafts.has(current.id) && (
                      <div className="mt-2 rounded-md bg-surface-hover p-4">
                        <p className="text-sm text-text-primary">{getDraftReply(current)}</p>
                        <div className="mt-2 flex gap-3">
                          <button
                            onClick={() => copyReply(current.id, getDraftReply(current)!)}
                            disabled={copyingId === current.id}
                            className="text-xs text-cobalt underline hover:text-cobalt-hover disabled:opacity-50"
                          >
                            {copyingId === current.id ? 'Copied!' : 'Copy Reply'}
                          </button>
                          <button
                            onClick={() => regenerateDraft(current.id)}
                            disabled={regeneratingId === current.id}
                            className="text-xs text-text-muted underline hover:text-text-primary disabled:opacity-50"
                          >
                            {regeneratingId === current.id ? 'Regenerating...' : 'Regenerate'}
                          </button>
                        </div>
                        {draftErrors.has(current.id) && (
                          <p className="mt-2 text-xs text-avax-red">Failed to regenerate. Please try again.</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between gap-2">
            <button
              onClick={goToPrevious}
              disabled={commentIndex === 0}
              className="rounded-md bg-surface-hover px-4 py-2 text-sm font-medium text-text-muted transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              ← Previous
            </button>
            <button
              onClick={goToNext}
              disabled={commentIndex === filtered.length - 1}
              className="rounded-md bg-surface-hover px-4 py-2 text-sm font-medium text-text-muted transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function CategorySummary({
  comments,
  peopleNoticed,
  onSelectCategory,
}: {
  comments: Comment[]
  peopleNoticed: number
  onSelectCategory: (key: string) => void
}) {
  const summaries = CATEGORY_ORDER.map(key => {
    const matches = comments.filter(c => c.category === key)

    let latest: Comment | null = null
    for (const c of matches) {
      if (!latest || new Date(c.postedAt).getTime() > new Date(latest.postedAt).getTime()) {
        latest = c
      }
    }

    return { key, ...CATEGORY_STYLES[key], count: matches.length, latest }
  })

  return (
    <div>
      <p className="mb-4 text-sm text-text-muted">
        {comments.length} comment{comments.length === 1 ? '' : 's'}
        {peopleNoticed > 0 && ` · ${peopleNoticed} ${peopleNoticed === 1 ? 'person' : 'people'} noticed`}
      </p>

      {comments.length === 0 ? (
        <p className="text-sm text-text-muted">No comments yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {summaries.map(cat => (
            <button
              key={cat.key}
              onClick={() => onSelectCategory(cat.key)}
              disabled={cat.count === 0}
              style={cat.count > 0 ? { backgroundColor: cat.bg } : undefined}
              className={`card text-left transition-all duration-200 ${
                cat.count > 0 ? 'hover:brightness-110 hover:scale-[1.01]' : 'cursor-default opacity-50'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className="font-body text-sm font-semibold uppercase tracking-wide"
                  style={{ color: cat.accent }}
                >
                  {cat.label}
                </span>
                <span className="font-display text-3xl font-semibold text-text-primary">{cat.count}</span>
              </div>
              {cat.latest ? (
                <p className="mt-3 line-clamp-2 text-sm text-text-primary">
                  <span className="font-body font-medium">{cat.latest.authorName}:</span> {cat.latest.text}
                </p>
              ) : (
                <p className="mt-3 text-sm text-text-muted">No comments yet.</p>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
