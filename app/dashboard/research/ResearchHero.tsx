// Welcome header for Research. No 'use client' — pure markup plus CSS animation,
// so it ships no JS and the prefers-reduced-motion opt-out lives in globals.css.

const MASCOT_SIZE = 132
// The orbit ring the sparkles sit on. Kept inside the mascot's own reserved box so
// a rotating particle can never widen the card or the page.
const ORBIT_SIZE = MASCOT_SIZE + 28

// Fuller-featured than components/MascotIcon's face: brow plate, cheek panels,
// eye highlights and side modules. It's rendered ~1.5x larger here, and the simpler
// glyph reads as under-detailed at this size.
function HeroRobotFace() {
  return (
    <svg viewBox="0 0 64 64" fill="none" className="h-[58%] w-[58%]" aria-hidden="true">
      {/* antenna */}
      <circle cx="32" cy="6.5" r="3.2" fill="currentColor" />
      <path d="M32 9.7v4.3" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      {/* head */}
      <rect x="11" y="14" width="42" height="34" rx="13" stroke="currentColor" strokeWidth="2.8" />
      {/* brow plate */}
      <path d="M19 22.5h26" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.55" />
      {/* eyes, with a highlight dot so they read as lit rather than drawn */}
      <circle cx="23.5" cy="31" r="4.2" fill="currentColor" />
      <circle cx="40.5" cy="31" r="4.2" fill="currentColor" />
      <circle cx="25.1" cy="29.4" r="1.35" fill="var(--surface)" />
      <circle cx="42.1" cy="29.4" r="1.35" fill="var(--surface)" />
      {/* smile */}
      <path
        d="M25 39.5c1.9 2 4.2 3 7 3s5.1-1 7-3"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      {/* side modules */}
      <path d="M7.5 26v10M56.5 26v10" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      {/* cheek vents */}
      <path d="M16.5 35.5v3M47.5 35.5v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity="0.5" />
    </svg>
  )
}

function Sparkle({ size, color }: { size: number; color: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill={color} aria-hidden="true">
      <path d="M12 0c.6 5.7 5.7 10.8 12 12-6.3 1.2-11.4 6.3-12 12-.6-5.7-5.7-10.8-12-12C6.3 10.8 11.4 5.7 12 0Z" />
    </svg>
  )
}

// Fixed positions on the orbit ring, given individual delays so they twinkle out of
// phase with each other.
const SPARKLES = [
  { top: '2%', left: '46%', size: 15, color: 'var(--pink)', delay: '0s' },
  { top: '26%', left: '92%', size: 11, color: 'var(--purple-text)', delay: '0.9s' },
  { top: '76%', left: '86%', size: 13, color: 'var(--pink)', delay: '1.8s' },
  { top: '90%', left: '30%', size: 10, color: 'var(--purple-text)', delay: '2.4s' },
  { top: '58%', left: '0%', size: 12, color: 'var(--pink)', delay: '1.3s' },
  { top: '14%', left: '6%', size: 9, color: 'var(--purple-text)', delay: '2.9s' },
]

function HeroMascot() {
  return (
    <div
      className="relative flex flex-shrink-0 items-center justify-center"
      style={{ width: ORBIT_SIZE, height: ORBIT_SIZE }}
      role="img"
      aria-label="Your Research AI"
    >
      {/* bloom */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute rounded-full blur-2xl"
        style={{
          width: MASCOT_SIZE * 1.2,
          height: MASCOT_SIZE * 1.2,
          background:
            'radial-gradient(circle, rgba(139,92,246,0.55) 0%, rgba(236,72,153,0.35) 45%, transparent 70%)',
        }}
      />

      {/* rotating ring of sparkles — transform-only, so it cannot affect layout */}
      <span aria-hidden="true" className="sparkle-orbit pointer-events-none absolute inset-0">
        {SPARKLES.map((s, i) => (
          <span
            key={i}
            className="sparkle-twinkle absolute"
            style={{ top: s.top, left: s.left, animationDelay: s.delay }}
          >
            <Sparkle size={s.size} color={s.color} />
          </span>
        ))}
      </span>

      {/* gradient ring + inner disc, same construction as MascotIcon */}
      <span
        className="mascot-breathe relative block rounded-full"
        style={{
          width: MASCOT_SIZE,
          height: MASCOT_SIZE,
          backgroundImage: 'var(--gradient-primary)',
        }}
      >
        <span
          className="absolute inset-[4px] flex items-center justify-center rounded-full bg-surface"
          style={{ color: 'var(--purple-text)' }}
        >
          <HeroRobotFace />
        </span>
      </span>
    </div>
  )
}

const featureIconProps = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  className: 'h-5 w-5',
} as const

const FEATURES = [
  {
    tone: 'purple',
    title: 'Real-time trends',
    detail: 'from your comments',
    icon: (
      <svg {...featureIconProps}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M2.25 18 9 11.25l4.306 4.307a11.95 11.95 0 0 1 5.814-5.518l2.74-1.22m0 0-5.94-2.28m5.94 2.28-2.28 5.941"
        />
      </svg>
    ),
  },
  {
    tone: 'pink',
    title: 'Audience insights',
    detail: '& behavior patterns',
    icon: (
      <svg {...featureIconProps}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z"
        />
      </svg>
    ),
  },
  {
    tone: 'teal',
    title: 'Content ideas',
    detail: 'that actually work',
    icon: (
      <svg {...featureIconProps}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 18v-5.25m0 0a6.01 6.01 0 0 0 1.5-.189m-1.5.189a6.01 6.01 0 0 1-1.5-.189m3.75 7.478a12.06 12.06 0 0 1-4.5 0m3.75 2.383a14.406 14.406 0 0 1-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 1 0-7.517 0c.85.493 1.509 1.333 1.509 2.316V18"
        />
      </svg>
    ),
  },
] as const

export default function ResearchHero({ creatorName }: { creatorName: string }) {
  return (
    <div className="space-y-4">
      <section className="card glow-card relative pt-14 sm:pt-5">
        {/* Absolute so it hugs the corner; the card's mobile pt-14 reserves the row
            it sits in, which is why the content below never collides with it. */}
        <span className="absolute top-4 right-4 inline-flex items-center gap-1.5 rounded-full border border-purple/30 bg-purple-dim px-3 py-1 font-mono text-[10px] tracking-wide text-purple-text uppercase">
          <span aria-hidden="true">✨</span>
          Powered by AI
        </span>

        <div className="flex flex-col items-center gap-5 text-center sm:flex-row sm:gap-7 sm:text-left">
          <HeroMascot />
          {/* w-full matters on mobile: the parent is `flex-col items-center`, and
              `items-center` means children are NOT stretched — they size to their
              content. Without it this block sized to the widest unbreakable token
              (the email address) and overflowed a 320px viewport by 14px. At sm it
              becomes a flex child sharing the row with the mascot instead. */}
          <div className="w-full min-w-0 sm:w-auto sm:flex-1">
            {/* break-words: creatorName falls back to the signup email, which is a
                single unbreakable token at this size. */}
            <h1 className="font-display text-2xl leading-tight font-semibold break-words text-text-primary sm:text-3xl">
              Hi {creatorName}, I&apos;m your Research AI
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-text-muted">
              I analyze your audience, find patterns, spot opportunities and give you clear,
              instant insights.
            </p>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {FEATURES.map(feature => (
          <div
            key={feature.title}
            className="card flex items-center gap-3 py-3.5"
          >
            <span className={`icon-badge icon-badge-${feature.tone}`} aria-hidden="true">
              {feature.icon}
            </span>
            <span className="min-w-0">
              <span className="block font-body text-sm font-medium text-text-primary">
                {feature.title}
              </span>
              <span className="mt-0.5 block text-xs leading-snug text-text-muted">
                {feature.detail}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
