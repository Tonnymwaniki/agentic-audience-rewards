'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import MascotIcon from '@/components/MascotIcon'
import { YOUTUBE_ENTRY_PATH } from '@/lib/onboarding'

type PlatformId = 'youtube' | 'facebook' | 'instagram' | 'tiktok' | 'x' | 'linkedin'

type Platform = {
  id: PlatformId
  name: string
  /** What this platform's agent will do, in the agent's own voice. */
  blurb: string
  /**
   * The platform's real brand colour, used at low alpha for the card's border and
   * wash. Kept even on the locked cards: a fully neutral row of six greys reads as
   * broken rather than pending, and the tint is what makes each one recognisable
   * at a glance before the icon registers.
   */
  tint: string
}

/** The one platform with a real flow behind it today. */
const YOUTUBE: Platform = {
  id: 'youtube',
  name: 'YouTube',
  blurb: 'Your YouTube agent — reading comments, drafting replies, recognizing loyal customers',
  tint: '#FF0033',
}

const COMING_SOON: Platform[] = [
  { id: 'instagram', name: 'Instagram', blurb: 'Will understand comments and DMs once available', tint: '#D62976' },
  { id: 'tiktok', name: 'TikTok', blurb: 'Will follow comment trends on short video once available', tint: '#25F4EE' },
  { id: 'facebook', name: 'Facebook', blurb: 'Will answer page comments and visitor posts once available', tint: '#1877F2' },
  { id: 'x', name: 'X', blurb: 'Will track replies and mentions once available', tint: '#FFFFFF' },
  { id: 'linkedin', name: 'LinkedIn', blurb: 'Will handle professional comments and leads once available', tint: '#0A66C2' },
]

/** How long the "isn't connected yet" note stays up after tapping a locked card. */
const NOTICE_MS = 2600

function PlatformIcon({ id, className = 'h-8 w-8' }: { id: PlatformId; className?: string }) {
  const common = { viewBox: '0 0 24 24', className, 'aria-hidden': true } as const

  switch (id) {
    case 'youtube':
      return (
        <svg {...common}>
          <rect x="1.5" y="5" width="21" height="14" rx="4" fill="#FF0033" />
          <path d="M10 9.2v5.6l4.9-2.8z" fill="#fff" />
        </svg>
      )
    case 'facebook':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10.5" fill="#1877F2" />
          <path
            d="M13.4 21.4v-7h2.3l.4-2.8h-2.7V9.9c0-.8.3-1.4 1.4-1.4h1.4V6c-.3 0-1.1-.1-2-.1-2 0-3.4 1.2-3.4 3.5v2.2H8.5v2.8h2.3v7z"
            fill="#fff"
          />
        </svg>
      )
    case 'instagram':
      return (
        <svg {...common}>
          <defs>
            <linearGradient id="ig-grad" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#FEDA75" />
              <stop offset="0.35" stopColor="#FA7E1E" />
              <stop offset="0.65" stopColor="#D62976" />
              <stop offset="1" stopColor="#4F5BD5" />
            </linearGradient>
          </defs>
          <rect x="2" y="2" width="20" height="20" rx="6" fill="url(#ig-grad)" />
          <rect x="6" y="6" width="12" height="12" rx="3.6" fill="none" stroke="#fff" strokeWidth="1.8" />
          <circle cx="12" cy="12" r="2.9" fill="none" stroke="#fff" strokeWidth="1.8" />
          <circle cx="16.1" cy="7.9" r="1" fill="#fff" />
        </svg>
      )
    case 'tiktok':
      return (
        <svg {...common}>
          <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="#000" stroke="#ffffff22" />
          <path
            d="M15.6 5.5c.4 1.3 1.5 2.3 2.9 2.4v2.3a5.4 5.4 0 0 1-2.9-.9v4.9a4.3 4.3 0 1 1-4.3-4.3h.5v2.4a2 2 0 1 0 1.5 1.9V5.5z"
            fill="#25F4EE"
            transform="translate(-0.6 -0.4)"
          />
          <path
            d="M15.6 5.5c.4 1.3 1.5 2.3 2.9 2.4v2.3a5.4 5.4 0 0 1-2.9-.9v4.9a4.3 4.3 0 1 1-4.3-4.3h.5v2.4a2 2 0 1 0 1.5 1.9V5.5z"
            fill="#FE2C55"
            transform="translate(0.6 0.4)"
          />
          <path
            d="M15.6 5.5c.4 1.3 1.5 2.3 2.9 2.4v2.3a5.4 5.4 0 0 1-2.9-.9v4.9a4.3 4.3 0 1 1-4.3-4.3h.5v2.4a2 2 0 1 0 1.5 1.9V5.5z"
            fill="#fff"
          />
        </svg>
      )
    case 'x':
      return (
        <svg {...common}>
          <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="#000" stroke="#ffffff22" />
          <path
            d="M16.3 5.8h2.2l-4.8 5.5 5.6 7.4h-4.4l-3.4-4.5-3.9 4.5H5.4l5.1-5.9-5.4-7h4.5l3.1 4.1zm-.8 11.6h1.2L8.9 7H7.6z"
            fill="#fff"
          />
        </svg>
      )
    case 'linkedin':
      return (
        <svg {...common}>
          <rect x="1.5" y="1.5" width="21" height="21" rx="4" fill="#0A66C2" />
          <circle cx="7.4" cy="7.6" r="1.5" fill="#fff" />
          <rect x="6.1" y="10.1" width="2.6" height="7.9" fill="#fff" />
          <path d="M10.9 10.1h2.5v1.1c.4-.7 1.3-1.3 2.6-1.3 2.3 0 2.9 1.5 2.9 3.5V18h-2.6v-4c0-1-.2-1.8-1.3-1.8s-1.5.8-1.5 1.8v4h-2.6z" fill="#fff" />
        </svg>
      )
  }
}

/** Shared shell for the five pending cards. */
const PENDING_CARD =
  'flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors'

export default function PlatformGrid() {
  const [notice, setNotice] = useState<string | null>(null)

  // Clear the note after a moment. Keyed on the message itself, so tapping a
  // second locked card restarts the timer instead of letting the first one cut it short.
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  return (
    <>
      {/* ---------------------------------------------------------------- hero */}
      <Link
        href={YOUTUBE_ENTRY_PATH}
        className="group block rounded-2xl border border-purple/40 bg-surface p-5 transition-colors hover:border-purple hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-purple focus-visible:ring-offset-2 focus-visible:ring-offset-ink focus-visible:outline-none active:bg-surface-hover"
      >
        {/* Stacked and centred on a phone, side-by-side from sm. The mascot is the
            first thing read either way — it is what separates this card from the
            five below at a glance, before any text is parsed. */}
        <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:items-center sm:gap-5 sm:text-left">
          <MascotIcon type="agent" size={76} className="flex-shrink-0" />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 sm:justify-start">
              <PlatformIcon id="youtube" className="h-5 w-5 flex-shrink-0" />
              <h2 className="font-display text-xl font-semibold text-text-primary">YouTube</h2>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-green/30 bg-green-dim px-2.5 py-0.5 font-mono text-[10px] tracking-wide text-green uppercase">
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-green" />
                Active
              </span>
            </div>

            <p className="mt-2 text-sm leading-snug text-text-muted">{YOUTUBE.blurb}</p>

            <span className="mt-3 inline-flex rounded-full bg-green-dim px-3 py-1 text-xs font-medium text-green transition-colors group-hover:bg-green/20">
              Ready · Open →
            </span>
          </div>
        </div>
      </Link>

      {/* -------------------------------------------------------- coming soon */}
      {/* Deliberately a quieter block: smaller type, one column on a phone so each
          blurb has room to read, two and three columns as width allows. */}
      <h3 className="mt-8 mb-3 font-mono text-[11px] tracking-wider text-text-muted/70 uppercase">
        Still in training
      </h3>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {COMING_SOON.map(platform => (
          // A real button rather than a dead div, so keyboard and screen-reader
          // users reach it and hear why it does nothing. aria-disabled (not the
          // disabled attribute) keeps it focusable and clickable for the notice.
          <button
            key={platform.id}
            type="button"
            aria-disabled="true"
            onClick={() => setNotice(`${platform.name} isn't deployed yet — it's coming soon.`)}
            className={`${PENDING_CARD} cursor-not-allowed`}
            // Brand tint at low alpha. Inline because the colour is per-platform
            // data, not one of a fixed set Tailwind could scan for at build time.
            style={{
              borderColor: `${platform.tint}33`,
              backgroundColor: `${platform.tint}0A`,
            }}
          >
            {/* Partly desaturated rather than fully grey: enough brand colour
                survives to identify the platform, not enough to compete with the
                hero card above. */}
            <span className="flex-shrink-0 opacity-70 grayscale-[0.5]">
              <PlatformIcon id={platform.id} className="h-6 w-6" />
            </span>

            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-body text-sm font-medium text-text-muted">{platform.name}</span>
                <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium text-text-muted/80">
                  Not deployed yet
                </span>
              </span>
              <span className="mt-1 block text-xs leading-snug text-text-muted/70">{platform.blurb}</span>
            </span>
          </button>
        ))}
      </div>

      {/* Always mounted so screen readers announce the change; visually empty otherwise. */}
      <p role="status" aria-live="polite" className="mt-4 min-h-[1.25rem] text-center text-sm text-gold-light">
        {notice}
      </p>
    </>
  )
}
