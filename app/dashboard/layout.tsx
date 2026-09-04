'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import NotificationBell from '@/components/NotificationBell'

const NAV_ITEMS = [
  { href: '/dashboard/inbox', label: 'My Videos' },
  { href: '/dashboard/brain', label: 'Audience Brain' },
  { href: '/dashboard/rewards', label: 'Rewards' },
  { href: '/dashboard/repeated', label: 'Repeated' },
]

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()

  return (
    <div className="mx-auto max-w-5xl p-6">
      <nav className="mb-6 flex items-center justify-between border-b border-white/10 pb-4">
        <Link href="/dashboard/inbox" className="block">
          <h1 className="text-xl font-bold font-display text-text-primary">Creator Dashboard</h1>
        </Link>
        <div className="flex items-center gap-1">
          {NAV_ITEMS.map(item => {
            const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'text-cobalt'
                    : 'text-text-muted hover:text-text-primary'
                }`}
              >
                {item.label}
              </Link>
            )
          })}
          <NotificationBell />
        </div>
      </nav>
      {children}
    </div>
  )
}
