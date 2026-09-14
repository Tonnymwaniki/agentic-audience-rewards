'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { YOUTUBE_ENTRY_PATH } from '@/lib/onboarding'

type PlatformId = 'youtube' | 'facebook' | 'instagram' | 'tiktok' | 'x' | 'linkedin'

type Platform = {
  id: PlatformId
  name: string
  /** Only YouTube has a real flow behind it today. */
  available: boolean
}

const PLATFORMS: Platform[] = [
  { id: 'youtube', name: 'YouTube', available: true },
  { id: 'facebook', name: 'Facebook', available: false },
  { id: 'instagram', name: 'Instagram', available: false },
  { id: 'tiktok', name: 'TikTok', available: false },
  { id: 'x', name: 'X', available: false },
  { id: 'linkedin', name: 'LinkedIn', available: false },
]

/** How long the "isn't connected yet" note stays up after tapping a locked card. */
const NOTICE_MS = 2600

function PlatformIcon({ id }: { id: PlatformId }) {
  const common = { viewBox: '0 0 24 24', className: 'h-8 w-8', 'aria-hidden': true } as const

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

const CARD_BASE =
  'flex min-h-[8.5rem] flex-col items-center justify-center gap-3 rounded-2xl border p-4 text-center transition-colors'

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
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
        {PLATFORMS.map(platform =>
          platform.available ? (
            <Link
              key={platform.id}
              href={YOUTUBE_ENTRY_PATH}
              className={`${CARD_BASE} border-purple/40 bg-surface hover:border-purple hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-purple focus-visible:ring-offset-2 focus-visible:ring-offset-ink focus-visible:outline-none`}
            >
              <PlatformIcon id={platform.id} />
              <span className="font-body text-sm font-semibold text-text-primary">{platform.name}</span>
              {/* Status sits in the flow under the name rather than pinned to a
                  corner: at two-up on a 375px phone a corner badge is wide enough
                  to collide with the centred icon. */}
              <span className="rounded-full bg-green-dim px-2.5 py-0.5 text-xs font-medium text-green">
                Ready · Open →
              </span>
            </Link>
          ) : (
            // A real button rather than a dead div, so keyboard and screen-reader
            // users reach it and hear why it does nothing. aria-disabled (not the
            // disabled attribute) keeps it focusable and clickable for the notice.
            <button
              key={platform.id}
              type="button"
              aria-disabled="true"
              onClick={() => setNotice(`${platform.name} isn't connected yet — it's coming soon.`)}
              className={`${CARD_BASE} cursor-not-allowed border-white/5 bg-surface/50`}
            >
              {/* Grayscale + low opacity on the mark only, so the label stays legible. */}
              <span className="opacity-40 grayscale">
                <PlatformIcon id={platform.id} />
              </span>
              <span className="font-body text-sm font-medium text-text-muted">{platform.name}</span>
              <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs font-medium text-text-muted">
                Coming soon
              </span>
            </button>
          )
        )}
      </div>

      {/* Always mounted so screen readers announce the change; visually empty otherwise. */}
      <p role="status" aria-live="polite" className="mt-4 min-h-[1.25rem] text-center text-sm text-gold-light">
        {notice}
      </p>
    </>
  )
}
