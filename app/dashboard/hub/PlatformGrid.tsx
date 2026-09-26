'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import MascotIcon from '@/components/MascotIcon'
import { YOUTUBE_ENTRY_PATH } from '@/lib/onboarding'
import { COMING_SOON, PlatformIcon, YOUTUBE } from '@/components/PlatformIcon'

/** How long the "isn't connected yet" note stays up after tapping a locked card. */
const NOTICE_MS = 2600


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
