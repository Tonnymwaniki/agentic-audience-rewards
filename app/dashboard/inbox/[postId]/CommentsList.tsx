'use client'

import { useState } from 'react'
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

export default function CommentsList({ comments, categoryCounts, peopleNoticed, repeatedCommentIds }: CommentsListProps) {
  const [filter, setFilter] = useState<string>('all')
  const [expandedDrafts, setExpandedDrafts] = useState<Set<string>>(new Set())
  const [copyingId, setCopyingId] = useState<string | null>(null)
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null)
  const [draftErrors, setDraftErrors] = useState<Set<string>>(new Set())
  const [draftReplies, setDraftReplies] = useState<Map<string, string>>(new Map())

  const filtered =
    filter === 'all'
      ? comments
      : comments.filter(c => c.category === filter)

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

  return (
    <div>
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
          </button>
        ))}
      </div>

      <div className="space-y-4">
        {filtered.map(comment => (
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
    </div>
  )
}
