'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'

type Notification = {
  id: string
  type: string
  message: string
  read: boolean
  created_at: string
  post_id: string | null
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

const POLL_INTERVAL_MS = 60000

export default function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications')
      if (!res.ok) return
      const data = await res.json()
      setNotifications(data.notifications || [])
      setUnreadCount(data.unreadCount || 0)
    } catch {
      // non-fatal — bell just won't update this cycle
    }
  }, [])

  useEffect(() => {
    load()
    const interval = setInterval(load, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [load])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  async function markRead(id: string) {
    setNotifications(prev => prev.map(n => (n.id === id ? { ...n, read: true } : n)))
    setUnreadCount(prev => Math.max(0, prev - 1))

    try {
      await fetch(`/api/notifications/${id}`, { method: 'PATCH' })
    } catch {
      // non-fatal — next poll will reconcile state
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        className="relative rounded-md p-2 text-text-muted transition-colors hover:text-text-primary"
        aria-label="Notifications"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          className="h-5 w-5"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"
          />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-avax-red px-1 text-[10px] font-medium text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 rounded-lg border border-white/10 bg-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <p className="text-sm font-medium text-text-primary">Notifications</p>
            {unreadCount > 0 && (
              <span className="text-xs text-text-muted">{unreadCount} unread</span>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {notifications.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-text-muted">No notifications yet.</p>
            ) : (
              notifications.map(notification => {
                const content = (
                  <div
                    className={`border-b border-white/5 px-4 py-3 transition-colors last:border-b-0 hover:bg-surface-hover ${
                      notification.read ? '' : 'bg-cobalt/5'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      {!notification.read && (
                        <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-cobalt" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-text-primary">{notification.message}</p>
                        <p className="mt-1 text-xs text-text-muted">{timeAgo(notification.created_at)}</p>
                      </div>
                    </div>
                  </div>
                )

                return notification.post_id ? (
                  <Link
                    key={notification.id}
                    href={`/dashboard/inbox/${notification.post_id}`}
                    onClick={() => {
                      setOpen(false)
                      if (!notification.read) markRead(notification.id)
                    }}
                    className="block"
                  >
                    {content}
                  </Link>
                ) : (
                  <button
                    key={notification.id}
                    type="button"
                    onClick={() => {
                      if (!notification.read) markRead(notification.id)
                    }}
                    className="block w-full text-left"
                  >
                    {content}
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
