// Hero mascot badge. No 'use client' — this is pure markup and CSS, so it ships
// no JS; the breathing animation and its prefers-reduced-motion opt-out both live
// in globals.css.

export type MascotType = 'agent' | 'rewards'

type MascotIconProps = {
  type: MascotType
  /** Diameter of the badge in px. The mockup range is 80-100. */
  size?: number
  className?: string
}

// Friendly, geometric robot face: rounded head, two round eyes, a small antenna
// and a soft smile. Drawn rather than borrowed so the curves match the rounded
// language of the cards.
function AgentFace() {
  return (
    // Sized larger than the crown: this glyph's antenna and side "ears" push its
    // visual mass inward, so at an equal box it reads noticeably smaller.
    <svg viewBox="0 0 48 48" fill="none" className="h-[62%] w-[62%]" aria-hidden="true">
      {/* antenna */}
      <circle cx="24" cy="6" r="2.6" fill="currentColor" />
      <path d="M24 8.6v3.4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      {/* head */}
      <rect
        x="8"
        y="12"
        width="32"
        height="26"
        rx="10"
        stroke="currentColor"
        strokeWidth="2.4"
      />
      {/* eyes */}
      <circle cx="18" cy="23.5" r="3.1" fill="currentColor" />
      <circle cx="30" cy="23.5" r="3.1" fill="currentColor" />
      {/* smile */}
      <path
        d="M19 30.5c1.4 1.5 3.1 2.2 5 2.2s3.6-.7 5-2.2"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      {/* ears */}
      <path d="M5.5 21v6M42.5 21v6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  )
}

// Crown rather than a trophy: the Rewards page already uses a trophy glyph for the
// "people recognized" stat, and repeating it would flatten the hierarchy.
function CrownIcon() {
  return (
    <svg viewBox="0 0 48 48" fill="none" className="h-[54%] w-[54%]" aria-hidden="true">
      <path
        d="M8 34.5 5 14l10.5 7.5L24 9l8.5 12.5L43 14l-3 20.5z"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
      <path d="M9.5 39.5h29" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="24" cy="26.5" r="2.4" fill="currentColor" />
    </svg>
  )
}

const VARIANTS: Record<
  MascotType,
  { ring: string; iconColor: string; glow: string; icon: React.ReactNode; label: string }
> = {
  agent: {
    ring: 'var(--gradient-primary)',
    iconColor: 'var(--purple-text)',
    glow: 'radial-gradient(circle, rgba(139,92,246,0.55) 0%, rgba(236,72,153,0.35) 45%, transparent 70%)',
    icon: <AgentFace />,
    label: 'Your agent',
  },
  rewards: {
    ring: 'var(--gradient-gold)',
    iconColor: 'var(--gold-light)',
    glow: 'radial-gradient(circle, rgba(251,191,36,0.55) 0%, rgba(245,158,11,0.35) 45%, transparent 70%)',
    icon: <CrownIcon />,
    label: 'Rewards',
  },
}

export default function MascotIcon({ type, size = 88, className = '' }: MascotIconProps) {
  const variant = VARIANTS[type]

  return (
    <div
      className={`relative inline-flex flex-shrink-0 items-center justify-center ${className}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={variant.label}
    >
      {/* Soft bloom behind the badge. Scaled past the badge and blurred, so the
          glow reads as light spilling outward rather than as a second ring. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute rounded-full blur-xl"
        style={{
          width: size * 1.25,
          height: size * 1.25,
          background: variant.glow,
        }}
      />

      {/* The gradient ring is the badge's own background; the inner disc sits on
          top inset by the ring width, which is what leaves a clean ring visible. */}
      <span
        className="mascot-breathe relative block h-full w-full rounded-full"
        style={{ backgroundImage: variant.ring }}
      >
        {/* inset-[3px] is the ring thickness — absolute rather than a margin so the
            disc can be exactly the badge minus the ring without overflowing it. */}
        <span
          className="absolute inset-[3px] flex items-center justify-center rounded-full bg-surface"
          style={{ color: variant.iconColor }}
        >
          {variant.icon}
        </span>
      </span>
    </div>
  )
}
