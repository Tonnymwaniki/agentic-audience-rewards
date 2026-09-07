import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import MascotIcon from '@/components/MascotIcon'
import LogoutButton from './LogoutButton'

export const dynamic = 'force-dynamic'

const linkIconProps = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  className: 'h-5 w-5',
} as const

const ACCOUNT_LINKS = [
  {
    href: '/dashboard/connect',
    tone: 'purple',
    label: 'Analyze more videos',
    description: 'Connect a channel or pull in new videos',
    icon: (
      <svg {...linkIconProps}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="m15.75 10.5 4.72-2.36a.75.75 0 0 1 1.08.67v8.38a.75.75 0 0 1-1.08.67l-4.72-2.36M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-7.5A2.25 2.25 0 0 0 13.5 6.75h-9A2.25 2.25 0 0 0 2.25 9v7.5a2.25 2.25 0 0 0 2.25 2.25Z"
        />
      </svg>
    ),
  },
  {
    href: '/dashboard/profile',
    tone: 'pink',
    label: 'Business Profile',
    description: 'Facts your agent uses when drafting replies',
    icon: (
      <svg {...linkIconProps}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M13.5 21v-7.5a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 .75.75V21m-4.5 0H2.36m11.14 0H18m0 0h3.64m-1.39 0V9.349M3.75 21V9.349m0 0a3.001 3.001 0 0 0 3.75-.615A2.993 2.993 0 0 0 9.75 9.75c.896 0 1.7-.393 2.25-1.016a2.993 2.993 0 0 0 2.25 1.016c.896 0 1.7-.393 2.25-1.016a3.001 3.001 0 0 0 3.75.614m-16.5 0a3.004 3.004 0 0 1-.621-4.72l1.189-1.19A1.5 1.5 0 0 1 5.378 3h13.243a1.5 1.5 0 0 1 1.06.44l1.19 1.189a3 3 0 0 1-.621 4.72M6.75 18h3.75a.75.75 0 0 0 .75-.75V13.5a.75.75 0 0 0-.75-.75H6.75a.75.75 0 0 0-.75.75v3.75c0 .414.336.75.75.75Z"
        />
      </svg>
    ),
  },
  {
    href: '/dashboard/rewards',
    tone: 'gold',
    label: 'Rewards',
    description: 'People your agent recognized, and their claim links',
    icon: (
      <svg {...linkIconProps}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 17.5 2.5 7l5.25 3.75L12 4.5l4.25 6.25L21.5 7 20 17.5zM5 20h14"
        />
      </svg>
    ),
  },
] as const

function ChevronIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      className="h-4 w-4 flex-shrink-0 text-text-muted"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
    </svg>
  )
}

export default async function MePage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: creator, error: creatorError } = await supabase
    .from('creators')
    .select('display_name')
    .eq('user_id', user.id)
    .maybeSingle()

  if (creatorError) {
    console.error('Me page creator fetch error:', JSON.stringify(creatorError, Object.getOwnPropertyNames(creatorError), 2))
  }

  const displayName = creator?.display_name || user.email || 'Your account'
  // display_name is frequently the signup email, in which case printing both would
  // just repeat the same string twice.
  const showEmailSeparately = Boolean(user.email) && user.email !== displayName

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <section className="flex flex-col items-center pt-2 text-center">
        <MascotIcon type="agent" />
        {/* break-words: displayName is usually an email — one unbreakable token. */}
        <h1 className="mt-4 font-display text-xl leading-tight font-semibold break-words text-text-primary">
          {displayName}
        </h1>
        {showEmailSeparately && (
          <p className="mt-1 text-sm break-words text-text-muted">{user.email}</p>
        )}
        <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-green/30 bg-green-dim px-3 py-1 font-mono text-[10px] tracking-wide text-green uppercase">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-green" />
          Signed in
        </p>
      </section>

      <nav className="space-y-3" aria-label="Account">
        {ACCOUNT_LINKS.map(link => (
          <Link
            key={link.href}
            href={link.href}
            className="flex items-center gap-3 rounded-xl border border-white/10 bg-surface p-4 transition-colors hover:border-purple/40 hover:bg-surface-hover"
          >
            <span className={`icon-badge icon-badge-${link.tone}`} aria-hidden="true">
              {link.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-body text-sm font-medium text-text-primary">
                {link.label}
              </span>
              <span className="mt-0.5 block text-xs leading-snug text-text-muted">
                {link.description}
              </span>
            </span>
            <ChevronIcon />
          </Link>
        ))}
      </nav>

      <LogoutButton />
    </div>
  )
}
