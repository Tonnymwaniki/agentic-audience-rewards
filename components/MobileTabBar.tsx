'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

// Fixed bottom tab bar for narrow viewports. The dashboard's top nav hides its link
// row at the same `md` breakpoint, so exactly one navigation is visible at a time.
//
// Three evenly-spaced tabs, plus a Research floating action button that is NOT part
// of the tab row: it is absolutely positioned against the bar and floats above it.
//
// An earlier version reserved a spacer column in the row for the FAB and weighted
// the trailing tab x2 to keep that column centred. That kept the FAB clear of the
// tabs but made the tab widths uneven, and the spacer's "Research" caption sat at
// the same height as the real tab labels, so the button read as an in-row item.
// Now the row contains only real tabs and the FAB is lifted clear instead.

const FAB_HREF = '/dashboard/research'

// --- Notch geometry --------------------------------------------------------
//
// The bar's background is an SVG shape with a circular scallop cut from its top
// edge, and the FAB nests in it. The cradle circle is CONCENTRIC with the FAB and
// CRADLE_GAP larger, so the gap between button and bar is even all the way round
// rather than pinching at the sides.
//
// Because the FAB's centre sits above the bar's top edge, only the lower cap of
// that circle intersects the bar — which is what makes the scallop shallow and
// wide rather than a deep semicircular bite. That matters: with three evenly
// spaced tabs the middle one ("My Videos") is at dead centre, directly under the
// notch, so the scallop has to stay clear of its icon. NOTCH_DEPTH below is the
// number that governs it, and TAB_ROW_PAD_TOP buys the clearance.
const FAB_SIZE = 60
const FAB_R = FAB_SIZE / 2
/** Distance from the bar's top edge up to the FAB's top edge. */
const FAB_LIFT = 50
const CRADLE_GAP = 8
const NOTCH_R = FAB_R + CRADLE_GAP
/** Small tangent arcs easing the scallop back into the flat top edge. */
const FILLET_R = 8
/** Width of the fixed-size SVG segment; the flanks stretch, this never scales. */
const NOTCH_W = 140
const NOTCH_CX = NOTCH_W / 2

/** FAB centre in bar-space (y grows downward, 0 = bar's top edge). Negative = above. */
const FAB_CY = -(FAB_LIFT - FAB_R)
/** Deepest point of the scallop, measured down from the bar's top edge. */
const NOTCH_DEPTH = FAB_CY + NOTCH_R
/** Breathing room between the bottom of the scallop and the middle tab's icon. */
const ICON_CLEARANCE = 6
/** The `py-2` each tab link already carries, before the row's own padding. */
const TAB_LINK_PAD_TOP = 8
/**
 * Pushes the tab row down so the middle tab's icon clears the scallop hanging over
 * it. Derived rather than hard-coded: change the cradle geometry above and this
 * follows, instead of silently letting the notch eat the icon.
 */
const TAB_ROW_PAD_TOP = Math.max(0, NOTCH_DEPTH + ICON_CLEARANCE - TAB_LINK_PAD_TOP)
/** Tall enough to contain the scallop with room for the stroke. */
const NOTCH_SVG_H = 36

// Each fillet is tangent to the flat edge (centre at y = FILLET_R) and externally
// tangent to the cradle circle (centres NOTCH_R + FILLET_R apart). Solving for the
// horizontal offset gives where the flat edge ends and where the arcs meet.
const CENTRE_DIST = NOTCH_R + FILLET_R
const CENTRE_DY = FILLET_R - FAB_CY
const CENTRE_DX = Math.sqrt(CENTRE_DIST * CENTRE_DIST - CENTRE_DY * CENTRE_DY)
/** Where the flat top edge gives way to the fillet. */
const FLAT_END_DX = CENTRE_DX
/** Where fillet meets cradle: along the line joining their centres, NOTCH_R out. */
const TANGENT_DX = (CENTRE_DX / CENTRE_DIST) * NOTCH_R
const TANGENT_Y = FAB_CY + (CENTRE_DY / CENTRE_DIST) * NOTCH_R

const r2 = (n: number) => Math.round(n * 100) / 100

// Top contour only — used both as the visible hairline and as the top of the fill.
const NOTCH_EDGE_PATH = [
  `M 0 0`,
  `H ${r2(NOTCH_CX - FLAT_END_DX)}`,
  `A ${FILLET_R} ${FILLET_R} 0 0 1 ${r2(NOTCH_CX - TANGENT_DX)} ${r2(TANGENT_Y)}`,
  `A ${NOTCH_R} ${NOTCH_R} 0 0 0 ${r2(NOTCH_CX + TANGENT_DX)} ${r2(TANGENT_Y)}`,
  `A ${FILLET_R} ${FILLET_R} 0 0 1 ${r2(NOTCH_CX + FLAT_END_DX)} 0`,
  `H ${NOTCH_W}`,
].join(' ')

// Same contour, closed down the sides and along the bottom, to fill.
const NOTCH_FILL_PATH = `${NOTCH_EDGE_PATH} V ${NOTCH_SVG_H} H 0 Z`

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
    label: 'My Videos',
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
    href: '/dashboard/me',
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
      // No background or border on the nav itself any more — the notched SVG layer
      // below paints both, so that the scallop is a genuine hole rather than a shape
      // drawn over a rectangle. The safe-area inset stays here as bottom padding so
      // the tab row clears the home indicator; it is 0px on devices without one.
      //
      // Nothing here clips: the FAB rises well above the nav's box.
      className="fixed inset-x-0 bottom-0 z-40 md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* --- Background: flat | notched | flat ---
          Three pieces rather than one full-width SVG, because a single stretched
          SVG would scale the scallop horizontally with the viewport and turn the
          circle into an ellipse. The flanks are plain stretchy fills; the middle is
          a FIXED-width SVG, so the curve keeps its true geometry at every width.
          Only its top strip needs to be SVG — everything below the scallop is solid,
          so a plain fill covers the rest of the bar's height. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="flex" style={{ height: NOTCH_SVG_H }}>
          <div className="flex-1 border-t border-white/10 bg-surface" />
          <svg
            width={NOTCH_W}
            height={NOTCH_SVG_H}
            viewBox={`0 0 ${NOTCH_W} ${NOTCH_SVG_H}`}
            className="flex-shrink-0"
            fill="none"
          >
            <path d={NOTCH_FILL_PATH} fill="var(--surface)" />
            <path
              d={NOTCH_EDGE_PATH}
              fill="none"
              stroke="rgba(255,255,255,0.10)"
              strokeWidth={1}
              // The flanks' 1px border sits inside their box (y 0→1), so nudging the
              // stroke's centre to y=0.5 lines the hairline up across all three
              // pieces instead of leaving a half-pixel step at the seams.
              transform="translate(0 0.5)"
            />
          </svg>
          <div className="flex-1 border-t border-white/10 bg-surface" />
        </div>
        {/* Everything below the scallop strip: plain full-width fill. */}
        <div
          className="bg-surface"
          style={{ height: `calc(100% - ${NOTCH_SVG_H}px)` }}
        />
      </div>

      {/* Absolutely positioned, so it is not part of the tab row's layout at all:
          left-1/2 + -translate-x-1/2 centres it on the BAR's full width, which is the
          viewport width (inset-x-0), independent of where the tabs fall. It shares a
          centre with the cradle circle, so the gap around it is even all the way
          round. No ring here now — the scallop itself provides the separation, and a
          ring would read as a second, competing outline inside the cradle. */}
      <Link
        href={FAB_HREF}
        aria-label="Research"
        aria-current={fabActive ? 'page' : undefined}
        className="gradient-primary absolute left-1/2 z-10 flex -translate-x-1/2 items-center justify-center rounded-full text-white transition-transform active:scale-95"
        style={{
          top: -FAB_LIFT,
          width: FAB_SIZE,
          height: FAB_SIZE,
          boxShadow:
            '0 6px 20px -4px rgba(139, 92, 246, 0.65), 0 3px 12px -2px rgba(236, 72, 153, 0.45)',
        }}
      >
        <SparkleIcon />
      </Link>

      {/* Exactly the three real tabs, each flex-1 — equal thirds, so their centres
          fall at 1/6, 1/2 and 5/6 of the bar. relative + z-10 keeps them above the
          background layer. The top padding is what lets the middle tab's icon clear
          the scallop hanging over it. */}
      <ul
        className="relative z-10 flex items-stretch"
        style={{ paddingTop: TAB_ROW_PAD_TOP }}
      >
        {TABS.map(renderTab)}
      </ul>
    </nav>
  )
}
