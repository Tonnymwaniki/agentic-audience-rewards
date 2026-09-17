'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useResearchChat } from './ResearchChatContext'

/**
 * "Ask a follow-up in chat" for a report page.
 *
 * Pre-fills the chat composer rather than sending: the creator has just read the
 * report and knows what they want to ask better than a canned question does, so
 * they get a starting point to edit. Report pages sit inside the Research layout,
 * which owns the chat provider, so the pre-filled text and any conversation
 * already in progress survive the navigation.
 */
export function FollowUpInChat({ prompt, className = '' }: { prompt: string; className?: string }) {
  const { setInput } = useResearchChat()
  const router = useRouter()

  function handleClick() {
    setInput(prompt)
    // Phones use the full-screen chat route; from lg up the chat is the panel on
    // the Research page itself (the same split ResearchChat renders).
    const desktop = window.matchMedia('(min-width: 1024px)').matches
    router.push(desktop ? '/dashboard/research' : '/dashboard/research/chat')
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`btn-primary inline-flex min-h-11 items-center justify-center gap-2 ${className}`}
    >
      Ask a follow-up in chat
      <span aria-hidden="true">→</span>
    </button>
  )
}

/** Title block shared by the three report pages: back link, heading, one-line summary. */
export function ReportHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6">
      <Link
        href="/dashboard/research"
        className="-ml-1 mb-2 inline-flex min-h-11 items-center gap-1 px-1 text-sm text-text-muted hover:text-text-primary"
      >
        <span aria-hidden="true">←</span> Research
      </Link>
      <h1 className="font-display text-2xl font-semibold text-text-primary md:text-3xl">{title}</h1>
      <p className="mt-2 text-sm text-text-muted">{subtitle}</p>
    </div>
  )
}
