'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import NotificationBell from '@/components/NotificationBell'
import MobileTabBar from '@/components/MobileTabBar'

const NAV_ITEMS = [
  { href: '/dashboard/agent', label: 'Agent Home' },
  { href: '/dashboard/inbox', label: 'My Videos' },
  { href: '/dashboard/research', label: 'Research' },
  { href: '/dashboard/rewards', label: 'Rewards' },
]

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()

  // Research runs a hybrid layout — chat plus a persistent insights sidebar — so it
  // needs more horizontal room than the reading-width pages, but it still sits
  // inside the standard nav chrome like everything else.
  const isWide = pathname?.startsWith('/dashboard/research')

  return (
    // The bottom padding below reserves room for the fixed tab bar (bar height plus
    // the device's home-indicator inset) so the last element of every page isn't
    // hidden underneath it, and returns to normal at md once the bar is gone. It has
    // to be a responsive utility rather than an inline style, since an inline style
    // would apply the extra padding at desktop widths too.
    //
    // Note: don't write bracketed utility names in these comments — Tailwind scans
    // comment text too, and emits a junk rule for anything that parses as a class.
    <div
      className={`mx-auto p-6 pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-6 ${
        isWide ? 'max-w-7xl' : 'max-w-5xl'
      }`}
    >
      <nav className="mb-6 flex flex-wrap items-center justify-between gap-y-2 border-b border-white/10 pb-4">
        <Link href="/dashboard/agent" className="block">
          <h1 className="text-xl font-bold font-display text-text-primary">Creator Dashboard</h1>
        </Link>
        {/* The link row is the desktop navigation; below md the bottom tab bar
            replaces it. The notification bell stays visible at every width — it has
            no equivalent tab. */}
        <div className="flex items-center gap-1">
          <div className="hidden flex-wrap items-center gap-1 md:flex">
            {NAV_ITEMS.map(item => {
            const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'text-purple-text'
                    : 'text-text-muted hover:text-text-primary'
                }`}
              >
                {item.label}
              </Link>
            )
            })}
          </div>

          <NotificationBell />

          {/* Duplicated by the "Me" tab below md, so it hides with the link row. */}
          <Link
            href="/dashboard/profile"
            aria-label="Business Profile"
            title="Business Profile"
            className={`hidden rounded-md p-2 transition-colors md:block ${
              pathname.startsWith('/dashboard/profile')
                ? 'text-purple-text'
                : 'text-text-muted hover:text-text-primary'
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
                d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"
              />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
            </svg>
          </Link>
        </div>
      </nav>
      {children}
      <MobileTabBar />
    </div>
  )
}
