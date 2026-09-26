// Platform identity shared by the Hub and Agent Home's workspace, so both show the
// same platforms, names and icons. No 'use client': pure data and SVG, renderable
// from server and client components alike.

export type PlatformId = 'youtube' | 'facebook' | 'instagram' | 'tiktok' | 'x' | 'linkedin'

export type Platform = {
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
export const YOUTUBE: Platform = {
  id: 'youtube',
  name: 'YouTube',
  blurb: 'Your YouTube agent — reading comments, drafting replies, recognizing loyal customers',
  tint: '#FF0033',
}

export const COMING_SOON: Platform[] = [
  { id: 'instagram', name: 'Instagram', blurb: 'Will understand comments and DMs once available', tint: '#D62976' },
  { id: 'tiktok', name: 'TikTok', blurb: 'Will follow comment trends on short video once available', tint: '#25F4EE' },
  { id: 'facebook', name: 'Facebook', blurb: 'Will answer page comments and visitor posts once available', tint: '#1877F2' },
  { id: 'x', name: 'X', blurb: 'Will track replies and mentions once available', tint: '#FFFFFF' },
  { id: 'linkedin', name: 'LinkedIn', blurb: 'Will handle professional comments and leads once available', tint: '#0A66C2' },
]

export function PlatformIcon({ id, className = 'h-8 w-8' }: { id: PlatformId; className?: string }) {
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
