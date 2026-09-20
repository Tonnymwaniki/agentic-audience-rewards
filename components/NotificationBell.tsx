'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const POLL_INTERVAL_MS = 60000

/**
 * The bell is now a link to the notification inbox, not a dropdown.
 *
 * It previously opened a small panel listing recent messages, which could only
 * show the message text — there was nowhere in it to approve a drafted reply. Now
 * that /dashboard/notifications renders the full actionable card, a second,
 * weaker copy of the same list was a strictly worse way in, so the bell just
 * carries the unread count and takes you there.
 *
 * It still polls, so the badge stays current while the creator sits on another
 * page, and it re-reads whenever the route changes so the count drops as soon as
 * the inbox marks something read.
 */
export default function NotificationBell() {
  const [unreadCount, setUnreadCount] = useState(0)
  const pathname = usePathname()

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications')
      if (!res.ok) return
      const data = await res.json()
      setUnreadCount(data.unreadCount || 0)
    } catch {
      // non-fatal — bell just won't update this cycle
    }
  }, [])

  useEffect(() => {
    load()
    const interval = setInterval(load, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [load, pathname])

  const label = unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'

  return (
    <Link
      href="/dashboard/notifications"
      aria-label={label}
      title={label}
      className={`relative rounded-md p-2 transition-colors hover:text-text-primary ${
        pathname === '/dashboard/notifications' ? 'text-purple-text' : 'text-text-muted'
      }`}
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
        <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-avax-red px-1 text-[10px] font-medium text-white">
          {unreadCount > 9 ? '9+' : unreadCount}
        </span>
      )}
    </Link>
  )
}
