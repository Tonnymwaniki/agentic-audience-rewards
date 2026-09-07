'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

// Fixed bottom tab bar for narrow viewports. The dashboard's top nav hides its link
// row at the same `md` breakpoint, so exactly one navigation is visible at a time.
//
// Four tabs split 2 | gap | 2, with Research promoted out of the row into a floating
// action button that sits in the gap. The gap is a real flex child rather than the
// FAB being laid over a tab, so the FAB can never cover another tab's tap target.

const FAB_HREF = '/dashboard/research'

type TabItem = {
  href: string
  label: string
  icon: React.ReactNode
}

const iconProps = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  className: 'h-6 w-6',
} as const

const TABS: TabItem[] = [
  {
    href: '/dashboard/agent',
    label: 'Home',
    icon: (
      <svg {...iconProps}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75"
        />
      </svg>
    ),
  },
  {
    href: '/dashboard/inbox',
    label: 'Videos',
    icon: (
      <svg {...iconProps}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="m15.75 10.5 4.72-2.36a.75.75 0 0 1 1.08.67v8.38a.75.75 0 0 1-1.08.67l-4.72-2.36M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-7.5A2.25 2.25 0 0 0 13.5 6.75h-9A2.25 2.25 0 0 0 2.25 9v7.5a2.25 2.25 0 0 0 2.25 2.25Z"
        />
      </svg>
    ),
  },
  {
    href: '/dashboard/rewards',
    label: 'Rewards',
    icon: (
      <svg {...iconProps}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M16.5 18.75h-9m9 0a3 3 0 0 1 3 3h-15a3 3 0 0 1 3-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 0 1-.982-3.172M9.497 14.25a7.454 7.454 0 0 0 .981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 0 0 7.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M7.73 9.728a6.726 6.726 0 0 0 2.748 1.35m8.272-6.842V4.5c0 2.108-.966 3.99-2.48 5.228m2.48-5.492a46.32 46.32 0 0 1 2.916.52 6.003 6.003 0 0 1-5.395 4.972m0 0a6.726 6.726 0 0 1-2.749 1.35m0 0a6.772 6.772 0 0 1-3.044 0"
        />
      </svg>
    ),
  },
  {
    href: '/dashboard/profile',
    label: 'Me',
    icon: (
      <svg {...iconProps}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M17.982 18.725A7.488 7.488 0 0 0 12 15.75a7.488 7.488 0 0 0-5.982 2.975m11.963 0a9 9 0 1 0-11.963 0m11.963 0A8.966 8.966 0 0 1 12 21a8.966 8.966 0 0 1-5.982-2.275M15 9.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
        />
      </svg>
    ),
  },
]

// Sparkles — deliberately unlike the single-weight outline glyphs in the bar, so
// the FAB reads as a different kind of thing rather than a fifth tab.
function SparkleIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      className="h-7 w-7"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z"
      />
    </svg>
  )
}

export default function MobileTabBar() {
  const pathname = usePathname()
  const fabActive = pathname === FAB_HREF || pathname?.startsWith(FAB_HREF + '/')

  // Split 2 | gap | 2 so the FAB occupies its own column.
  const left = TABS.slice(0, 2)
  const right = TABS.slice(2)

  function renderTab(tab: TabItem) {
    const isActive = pathname === tab.href || pathname?.startsWith(tab.href + '/')

    return (
      <li key={tab.href} className="flex-1">
        <Link
          href={tab.href}
          aria-current={isActive ? 'page' : undefined}
          // min-h-14 keeps every tap target comfortably past the 44px minimum
          // even though the label text is small.
          className={`flex min-h-14 flex-col items-center justify-center gap-1 px-1 py-2 transition-colors ${
            isActive ? 'text-purple-text' : 'text-text-muted active:text-text-primary'
          }`}
        >
          <span
            className={`flex h-8 w-12 items-center justify-center rounded-full transition-colors ${
              isActive ? 'bg-purple/15' : ''
            }`}
          >
            {tab.icon}
          </span>
          <span className="text-[10px] leading-none font-medium">{tab.label}</span>
        </Link>
      </li>
    )
  }

  return (
    <nav
      aria-label="Primary"
      // The bar itself carries the safe-area inset as bottom padding, so the row of
      // tabs sits above the home indicator rather than behind it. The value is 0px
      // on every device without one, which leaves the bar flush to the edge.
      //
      // No overflow clipping here: the FAB is absolutely positioned so that its top
      // half rises above the bar's top edge, and clipping would cut it in half.
      className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-surface/95 backdrop-blur md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* Sits above the bar's own background and border (z-10), and above page
          content (the nav's z-40), so the lifted half is never clipped or covered. */}
      <Link
        href={FAB_HREF}
        aria-label="Research"
        aria-current={fabActive ? 'page' : undefined}
        className="gradient-primary absolute -top-6 left-1/2 z-10 flex h-15 w-15 -translate-x-1/2 items-center justify-center rounded-full text-white ring-4 ring-background transition-transform active:scale-95"
        style={{
          // Not .glow-card: that class's first layer is a 1px purple ring shadow
          // sized for a rectangular card, which reads as a hard edge on a circle.
          // Same colours, tuned for a round, lifted control.
          boxShadow:
            '0 6px 20px -4px rgba(139, 92, 246, 0.65), 0 3px 12px -2px rgba(236, 72, 153, 0.45)',
        }}
      >
        <SparkleIcon />
      </Link>

      <ul className="flex items-stretch">
        {left.map(renderTab)}

        {/* Reserved column under the FAB. Holds the label so Research still reads as
            a named destination like its neighbours, and keeps the flex maths even so
            the four tabs stay equally spaced. */}
        <li aria-hidden="true" className="w-16 flex-shrink-0">
          <div className="flex min-h-14 flex-col items-center justify-end px-1 py-2">
            <span
              className={`text-[10px] leading-none font-medium ${
                fabActive ? 'text-purple-text' : 'text-text-muted'
              }`}
            >
              Research
            </span>
          </div>
        </li>

        {right.map(renderTab)}
      </ul>
    </nav>
  )
}
