'use client'

import { useState, useEffect } from 'react'
import Avatar from '@/components/Avatar'

const PAGE_SIZE = 25

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
  categoryCounts: Record<string, number>
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

const CATEGORIES = [
  { key: 'all', label: 'All' },
  { key: 'question', label: 'Question' },
  { key: 'praise', label: 'Praise' },
  { key: 'complaint', label: 'Complaint' },
  { key: 'purchase_intent', label: 'Purchase Intent' },
  { key: 'spam', label: 'Spam' },
  { key: 'other', label: 'Other' },
] as const

const SUMMARY_CATEGORIES = CATEGORIES.filter(c => c.key !== 'all')

export default function CommentsList({ comments, categoryCounts, peopleNoticed, repeatedCommentIds }: CommentsListProps) {
  // null = default category-summary-cards view. 'all' or a specific category key = drilled in.
  const [filter, setFilter] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [expandedDrafts, setExpandedDrafts] = useState<Set<string>>(new Set())
  const [copyingId, setCopyingId] = useState<string | null>(null)
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null)
  const [draftErrors, setDraftErrors] = useState<Set<string>>(new Set())
  const [draftReplies, setDraftReplies] = useState<Map<string, string>>(new Map())

  // Switching categories (including going back to the summary view) always starts
  // back at page 1 — otherwise landing on "Complaints" could silently show page 3
  // just because that's where you'd scrolled to on "Purchase Intent".
  useEffect(() => {
    setPage(1)
  }, [filter])

  const filtered =
    filter === null || filter === 'all'
      ? comments
      : comments.filter(c => c.category === filter)

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const paginated = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

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

  if (filter === null) {
    return (
      <CategorySummary
        comments={comments}
        peopleNoticed={peopleNoticed}
        onSelectCategory={setFilter}
        onViewAll={() => setFilter('all')}
      />
    )
  }

  return (
    <div>
      <button
        onClick={() => setFilter(null)}
        className="mb-4 inline-flex items-center text-sm text-text-muted hover:text-text-primary"
      >
        ← Back to categories
      </button>

      <div className="mb-4 flex flex-wrap gap-2">
        {CATEGORIES.map(cat => (
          <button
            key={cat.key}
            onClick={() => setFilter(cat.key)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
              filter === cat.key
                ? 'bg-cobalt text-white'
                : 'bg-surface-hover text-text-muted hover:text-text-primary'
            }`}
          >
            {cat.label}
            {cat.key !== 'all' && categoryCounts[cat.key] ? ` (${categoryCounts[cat.key]})` : ''}
          </button>
        ))}
      </div>

      <div className="space-y-4">
        {paginated.map(comment => (
          <div
            key={comment.id}
            className="card hover:bg-surface-hover hover:scale-[1.01] transition-all duration-200"
          >
            <div className="flex items-start gap-4">
              <Avatar name={comment.authorName} size={40} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <p className="font-body font-medium text-sm text-text-primary">{comment.authorName}</p>
                    {comment.hasReward && (
                      <span className="text-xs text-pink">Noticed ✦</span>
                    )}
                    {repeatedCommentIds && repeatedCommentIds.includes(comment.id) && (
                      <span className="text-xs text-avax-red">🚩 Repeated</span>
                    )}
                  </div>
                  <span className={`badge badge-${comment.category}`}>
                    {comment.category.replace('_', ' ')}
                  </span>
                </div>
                 {comment.profileSummary && (
                   <p className="mt-0.5 text-xs italic text-text-muted">{comment.profileSummary}</p>
                 )}
                 <p className="mt-1 text-sm leading-relaxed text-text-primary">{comment.text}</p>
                 <span className="mt-1 inline-block text-xs font-mono text-text-muted">{timeAgo(comment.postedAt)}</span>
                 {comment.topic && (
                   <span className="mt-1 inline-block text-xs text-text-muted">{comment.topic}</span>
                 )}

                 {getDraftReply(comment) && (
                   <div className="mt-3">
                     <button
                       onClick={() => toggleDraft(comment.id)}
                       className="text-xs font-medium text-cobalt hover:text-cobalt-hover"
                     >
                       💬 Suggested reply
                     </button>
                     {expandedDrafts.has(comment.id) && (
                       <div className="mt-2 rounded-md bg-surface-hover p-3">
                         <p className="text-sm text-text-primary">{getDraftReply(comment)}</p>
                         <div className="mt-2 flex gap-2">
                           <button
                             onClick={() => copyReply(comment.id, getDraftReply(comment)!)}
                             disabled={copyingId === comment.id}
                             className="text-xs text-cobalt underline hover:text-cobalt-hover disabled:opacity-50"
                           >
                             {copyingId === comment.id ? 'Copied!' : 'Copy Reply'}
                           </button>
                           <button
                             onClick={() => regenerateDraft(comment.id)}
                             disabled={regeneratingId === comment.id}
                             className="text-xs text-text-muted underline hover:text-text-primary disabled:opacity-50"
                           >
                             {regeneratingId === comment.id ? 'Regenerating...' : 'Regenerate'}
                           </button>
                         </div>
                         {draftErrors.has(comment.id) && (
                           <p className="mt-2 text-xs text-avax-red">Failed to regenerate. Please try again.</p>
                         )}
                       </div>
                     )}
                   </div>
                 )}
              </div>
            </div>
          </div>
        ))}

        {filtered.length === 0 && (
          <p className="text-sm text-text-muted">No comments in this category.</p>
        )}
      </div>

      {totalPages > 1 && (
        <PaginationControls
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={setPage}
        />
      )}
    </div>
  )
}

function getPageNumbers(current: number, total: number): Array<number | 'ellipsis'> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1)
  }

  const keep = new Set<number>([1, 2, total - 1, total, current - 1, current, current + 1])
  const sorted = Array.from(keep)
    .filter(p => p >= 1 && p <= total)
    .sort((a, b) => a - b)

  const result: Array<number | 'ellipsis'> = []
  let previous = 0
  for (const p of sorted) {
    if (previous && p - previous > 1) result.push('ellipsis')
    result.push(p)
    previous = p
  }
  return result
}

function PaginationControls({
  currentPage,
  totalPages,
  onPageChange,
}: {
  currentPage: number
  totalPages: number
  onPageChange: (page: number) => void
}) {
  return (
    <div className="mt-6 flex flex-wrap items-center justify-center gap-1">
      <button
        onClick={() => onPageChange(Math.max(1, currentPage - 1))}
        disabled={currentPage === 1}
        className="rounded-md px-3 py-1.5 text-sm font-medium text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      >
        Previous
      </button>

      {getPageNumbers(currentPage, totalPages).map((p, i) =>
        p === 'ellipsis' ? (
          <span key={`ellipsis-${i}`} className="px-2 text-sm text-text-muted">
            …
          </span>
        ) : (
          <button
            key={p}
            onClick={() => onPageChange(p)}
            className={`min-w-[2rem] rounded-md px-2 py-1.5 text-sm font-medium transition-colors ${
              p === currentPage
                ? 'bg-cobalt text-white'
                : 'text-text-muted hover:bg-surface-hover hover:text-text-primary'
            }`}
          >
            {p}
          </button>
        )
      )}

      <button
        onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
        disabled={currentPage === totalPages}
        className="rounded-md px-3 py-1.5 text-sm font-medium text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      >
        Next
      </button>
    </div>
  )
}

function CategorySummary({
  comments,
  peopleNoticed,
  onSelectCategory,
  onViewAll,
}: {
  comments: Comment[]
  peopleNoticed: number
  onSelectCategory: (key: string) => void
  onViewAll: () => void
}) {
  const summaries = SUMMARY_CATEGORIES.map(cat => {
    const matches = comments.filter(c => c.category === cat.key)

    let latest: Comment | null = null
    for (const c of matches) {
      if (!latest || new Date(c.postedAt).getTime() > new Date(latest.postedAt).getTime()) {
        latest = c
      }
    }

    return { ...cat, count: matches.length, latest }
  })

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-muted">
          {comments.length} comment{comments.length === 1 ? '' : 's'}
          {peopleNoticed > 0 && ` · ${peopleNoticed} ${peopleNoticed === 1 ? 'person' : 'people'} noticed`}
        </p>
        <button
          onClick={onViewAll}
          className="text-sm text-cobalt underline hover:text-cobalt-hover"
        >
          View all comments
        </button>
      </div>

      {comments.length === 0 ? (
        <p className="text-sm text-text-muted">No comments yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {summaries.map(cat => (
            <button
              key={cat.key}
              onClick={() => onSelectCategory(cat.key)}
              disabled={cat.count === 0}
              className="card text-left transition-all duration-200 hover:bg-surface-hover hover:scale-[1.01] disabled:cursor-default disabled:opacity-50 disabled:hover:scale-100 disabled:hover:bg-transparent"
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`badge badge-${cat.key}`}>{cat.label}</span>
                <span className="font-display text-2xl font-semibold text-text-primary">{cat.count}</span>
              </div>
              {cat.latest ? (
                <p className="mt-3 line-clamp-2 text-sm text-text-muted">
                  <span className="font-body font-medium text-text-primary">{cat.latest.authorName}:</span>{' '}
                  {cat.latest.text}
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
