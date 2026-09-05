'use client'

import { useState } from 'react'
import Link from 'next/link'
import CopyLinkButton from '@/app/dashboard/rewards/CopyLinkButton'

export type CommentActivityItem = {
  type: 'comment_activity'
  key: string
  postId: string
  videoTitle: string
  count: number
  categoryBreakdown: Record<string, number>
  timestamp: string
}

export type PendingDraftItem = {
  type: 'pending_draft'
  key: string
  commentId: string
  postId: string
  videoTitle: string
  authorName: string
  commentText: string
  draftReply: string
  category: string
  timestamp: string
}

export type RewardItem = {
  type: 'reward'
  key: string
  rewardEventId: string
  postId: string | null
  videoTitle: string
  displayName: string
  reason: string
  status: string
  claimToken: string
  txHash: string | null
  timestamp: string
}

export type NotificationItem = {
  type: 'notification'
  key: string
  notificationId: string
  postId: string | null
  videoTitle: string
  message: string
  notifType: string
  timestamp: string
}

export type FeedItem = CommentActivityItem | PendingDraftItem | RewardItem | NotificationItem

export type FeedGroup = {
  postId: string
  videoTitle: string
  items: FeedItem[]
  latestTimestamp: string
}

type AgentFeedProps = {
  commentsReadCount: number
  draftsWrittenCount: number
  recognizedCount: number
  groups: FeedGroup[]
  groupByVideo: boolean
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

export default function AgentFeed({
  commentsReadCount,
  draftsWrittenCount,
  recognizedCount,
  groups,
  groupByVideo,
}: AgentFeedProps) {
  const [dismissedDraftIds, setDismissedDraftIds] = useState<Set<string>>(new Set())
  const [readNotificationIds, setReadNotificationIds] = useState<Set<string>>(new Set())

  const hasAnyActivity = groups.some(group =>
    group.items.some(item => {
      if (item.type === 'pending_draft') return !dismissedDraftIds.has(item.commentId)
      if (item.type === 'notification') return !readNotificationIds.has(item.notificationId)
      return true
    })
  )

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

  async function markNotificationRead(notificationId: string) {
    setReadNotificationIds(prev => new Set(prev).add(notificationId))

    try {
      await fetch(`/api/notifications/${notificationId}`, { method: 'PATCH' })
    } catch {
      // non-fatal — worst case it shows as unread again next visit
    }
  }

  return (
    <div className="space-y-6">
      <section className="card">
        <p className="text-sm leading-relaxed text-text-primary">
          Today, your agent read{' '}
          <span className="font-body font-semibold text-cobalt">{commentsReadCount}</span>{' '}
          comment{commentsReadCount === 1 ? '' : 's'}, drafted{' '}
          <span className="font-body font-semibold text-cobalt">{draftsWrittenCount}</span>{' '}
          repl{draftsWrittenCount === 1 ? 'y' : 'ies'}, and recognized{' '}
          <span className="font-body font-semibold text-pink">{recognizedCount}</span>{' '}
          {recognizedCount === 1 ? 'person' : 'people'}.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-lg bg-surface-hover p-3 text-center">
            <p className="text-xl font-display font-semibold text-text-primary">{commentsReadCount}</p>
            <p className="text-xs text-text-muted">comments read</p>
          </div>
          <div className="rounded-lg bg-surface-hover p-3 text-center">
            <p className="text-xl font-display font-semibold text-text-primary">{draftsWrittenCount}</p>
            <p className="text-xs text-text-muted">replies drafted</p>
          </div>
          <div className="rounded-lg bg-surface-hover p-3 text-center">
            <p className="text-xl font-display font-semibold text-text-primary">{recognizedCount}</p>
            <p className="text-xs text-text-muted">people recognized</p>
          </div>
        </div>
      </section>

      {!hasAnyActivity ? (
        <div className="card p-8 text-center">
          <p className="text-sm text-text-muted">Nothing new in the last 7 days. Check back later.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map(group => {
            const visibleItems = group.items.filter(item => {
              if (item.type === 'pending_draft') return !dismissedDraftIds.has(item.commentId)
              return true
            })

            if (visibleItems.length === 0) return null

            return (
              <div key={group.postId} className="space-y-3">
                {groupByVideo && (
                  <div className="flex items-center justify-between gap-2 px-1">
                    <h2 className="truncate text-sm font-medium text-text-muted">{group.videoTitle}</h2>
                    {group.postId !== 'general' && (
                      <Link
                        href={`/dashboard/inbox/${group.postId}`}
                        className="flex-shrink-0 text-xs text-cobalt hover:text-cobalt-hover"
                      >
                        Open in Inbox →
                      </Link>
                    )}
                  </div>
                )}

                <div className="space-y-3">
                  {visibleItems.map(item => {
                    if (item.type === 'comment_activity') {
                      return (
                        <div key={item.key} className="card">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <p className="text-sm text-text-primary">
                                <span className="font-body font-semibold">{item.count}</span> new comment
                                {item.count === 1 ? '' : 's'} on{' '}
                                <span className="font-body font-medium">{item.videoTitle}</span>
                              </p>
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {Object.entries(item.categoryBreakdown)
                                  .sort((a, b) => b[1] - a[1])
                                  .map(([category, count]) => (
                                    <span key={category} className={`badge badge-${category}`}>
                                      {count} {category.replace(/_/g, ' ')}
                                    </span>
                                  ))}
                              </div>
                            </div>
                            <span className="flex-shrink-0 text-xs text-text-muted">{timeAgo(item.timestamp)}</span>
                          </div>
                          <Link
                            href={`/dashboard/inbox/${item.postId}`}
                            className="mt-3 inline-block text-xs text-cobalt underline hover:text-cobalt-hover"
                          >
                            View comments →
                          </Link>
                        </div>
                      )
                    }

                    if (item.type === 'pending_draft') {
                      return (
                        <div key={item.key} className="card !bg-pink-dim/30">
                          <div className="flex items-start justify-between gap-2">
                            <p className="min-w-0 flex-1 text-sm font-body font-medium text-text-primary">
                              New comment needs a reply — {item.authorName}
                            </p>
                            <span className="flex-shrink-0 text-xs text-text-muted">{timeAgo(item.timestamp)}</span>
                          </div>
                          <p className="mt-1 text-sm text-text-primary">
                            <span className="highlight">{item.commentText}</span>
                          </p>
                          <div className="mt-3 rounded-md bg-surface-hover p-3">
                            <p className="mb-1 text-xs font-medium text-text-muted">Drafted reply</p>
                            <p className="text-sm text-text-primary">{item.draftReply}</p>
                          </div>
                          <div className="mt-3 flex flex-wrap gap-3">
                            <button
                              onClick={() => approveDraft(item.commentId)}
                              className="btn-primary text-xs"
                            >
                              Approve
                            </button>
                            <CopyReplyButton text={item.draftReply} />
                            <Link
                              href={`/dashboard/inbox/${item.postId}`}
                              className="text-xs text-text-muted underline hover:text-text-primary"
                            >
                              View in Inbox
                            </Link>
                          </div>
                        </div>
                      )
                    }

                    if (item.type === 'reward') {
                      return (
                        <div key={item.key} className="card">
                          <div className="flex items-start justify-between gap-2">
                            <p className="min-w-0 flex-1 text-sm font-body font-medium text-text-primary">
                              Someone was recognized — {item.displayName}
                            </p>
                            <span className="flex-shrink-0 text-xs text-text-muted">{timeAgo(item.timestamp)}</span>
                          </div>
                          <p className="mt-1 text-sm text-text-primary">
                            <span className="highlight">{item.reason}</span>
                          </p>
                          <div className="mt-3 flex flex-wrap items-center gap-3">
                            <span className="inline-flex rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800">
                              {item.status}
                            </span>
                            <CopyLinkButton claimToken={item.claimToken} status={item.status} txHash={item.txHash} />
                          </div>
                        </div>
                      )
                    }

                    if (item.type === 'notification') {
                      const isRead = readNotificationIds.has(item.notificationId)

                      const body = (
                        <div className={`card transition-colors ${isRead ? 'opacity-60' : ''}`}>
                          <div className="flex items-start justify-between gap-2">
                            <p className="min-w-0 flex-1 text-sm text-text-primary">{item.message}</p>
                            <span className="flex-shrink-0 text-xs text-text-muted">{timeAgo(item.timestamp)}</span>
                          </div>
                        </div>
                      )

                      return item.postId ? (
                        <Link
                          key={item.key}
                          href={`/dashboard/inbox/${item.postId}`}
                          onClick={() => {
                            if (!isRead) markNotificationRead(item.notificationId)
                          }}
                          className="block"
                        >
                          {body}
                        </Link>
                      ) : (
                        <button
                          key={item.key}
                          type="button"
                          onClick={() => {
                            if (!isRead) markNotificationRead(item.notificationId)
                          }}
                          className="block w-full text-left"
                        >
                          {body}
                        </button>
                      )
                    }

                    return null
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
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
    <button
      onClick={handleCopy}
      className="text-xs text-text-muted underline hover:text-text-primary"
    >
      {copied ? 'Copied!' : 'Copy Reply'}
    </button>
  )
}
