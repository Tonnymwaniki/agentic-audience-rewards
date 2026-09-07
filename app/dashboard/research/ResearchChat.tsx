'use client'

import { useRef, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useResearchChat, type ChatMessage, type VideoCard, type StatsCard, type IdeaCard, type AnomalyCard, type PersonCard } from './ResearchChatContext'
import ReactMarkdown from 'react-markdown'
import Avatar from '@/components/Avatar'
import { InterestBars, TrendingList } from './AudienceInsights'
import type { SidebarInterest, SidebarTrendingTopic } from './ResearchSidebar'

// Messages are only ever created client-side (the list starts empty on both
// server and client), so formatting a local time here can't cause a hydration
// mismatch.
function formatTime(iso: string): string {
  const date = new Date(iso)
  if (isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function CopyResponseButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard unavailable
    }
  }

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1 text-[10px] text-text-muted transition-colors hover:text-text-primary"
      aria-label="Copy response"
    >
      {copied ? (
        'Copied!'
      ) : (
        <>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            className="h-3 w-3"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m0 0H5.625"
            />
          </svg>
          Copy
        </>
      )}
    </button>
  )
}

function RegenerateButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1 text-[10px] text-text-muted transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
      aria-label="Regenerate response"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        className="h-3 w-3"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M16.023 9.348h4.992V4.356m-4.992 4.992-1.72-1.72a8.25 8.25 0 0 0-13.803 3.7M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7"
        />
      </svg>
      Regenerate
    </button>
  )
}

function TypingIndicator() {
  return (
    <div className="card mr-auto rounded-tl-sm border-l-2 border-pink">
      <div className="flex items-center gap-1.5" role="status" aria-label="Thinking">
        {[0, 1, 2].map(i => (
          <span
            key={i}
            className="typing-dot h-1.5 w-1.5 rounded-full bg-text-muted"
            style={{ animationDelay: `${i * 0.18}s` }}
          />
        ))}
      </div>
    </div>
  )
}

// Same visual language as the person rows on Highlights/Rewards: hashed-color
// avatar, name, supporting line, small count badge.
function PersonCardDisplay({ card }: { card: PersonCard }) {
  return (
    <div className="card mt-3">
      <div className="flex items-start gap-3">
        <Avatar name={card.display_name} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate font-body text-sm font-medium text-text-primary">{card.display_name}</p>
            {card.comment_count > 0 && (
              <span className="flex-shrink-0 rounded-full border border-white/10 bg-surface-hover px-2 py-0.5 font-mono text-[10px] text-text-muted">
                {card.comment_count} {card.comment_count === 1 ? 'comment' : 'comments'}
              </span>
            )}
          </div>
          {card.reason && (
            <p className="mt-1 text-sm leading-relaxed text-text-muted">{card.reason}</p>
          )}
        </div>
      </div>
    </div>
  )
}

function IdeaCardDisplay({ card }: { card: IdeaCard }) {
  return (
    <div className="card mt-3">
      <div className="flex items-start gap-3">
        <span className="font-display text-lg font-semibold text-purple-text">{card.number}</span>
        <div className="min-w-0 flex-1">
          <p className="font-body text-sm font-semibold text-text-primary">{card.title}</p>
          <p className="mt-1 text-sm leading-relaxed text-text-primary">{card.description}</p>
          <p className="mt-2 font-mono text-[10px] uppercase tracking-wide text-text-muted">{card.signal}</p>
        </div>
      </div>
    </div>
  )
}

function AnomalyCardDisplay({ card }: { card: AnomalyCard }) {
  if (!card.hasAnomaly) {
    return (
      <div className="mb-3 rounded-lg border border-purple/40 bg-purple/10 p-4">
        <p className="text-sm text-text-primary">
          Nothing unusual — activity is within normal range.
        </p>
      </div>
    )
  }

  return (
    <div className="mb-3 space-y-2">
      {card.findings.map((finding, i) => (
        <div
          key={i}
          className={`rounded-lg border-l-2 bg-surface-hover p-3 ${
            finding.severity === 'high' ? 'border-avax-red' : 'border-avax-red/50'
          }`}
        >
          <div className="flex items-start gap-2">
            <span className="text-sm text-avax-red">▲</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm leading-relaxed text-text-primary">{finding.description}</p>
              <p className="mt-1 font-mono text-[10px] uppercase tracking-wide text-text-muted">
                {finding.severity} severity
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// Stat grid styled after the landing page's "Live Proof" block — font-display
// numerals in purple over uppercase mono labels — scaled down to sit inside a
// chat bubble rather than a full-width marketing section.
function StatsCardDisplay({ card }: { card: StatsCard }) {
  return (
    <div className="mb-3 rounded-lg border border-white/10 bg-surface-hover p-4">
      <p className="mb-3 font-display text-sm font-semibold text-text-primary">{card.title}</p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {card.stats.map(stat => (
          <div key={stat.label} className="text-center">
            <p className="font-display text-2xl font-semibold text-purple-text">
              {typeof stat.value === 'number' ? stat.value.toLocaleString() : stat.value}
            </p>
            <p className="mt-1 font-mono text-[10px] leading-tight text-text-muted">{stat.label}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// Renders an agent message's markdown with per-element overrides so it inherits
// the app's theme rather than react-markdown's bare browser defaults (which would
// come out as unstyled black-on-dark headings and browser-default list indents).
function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="text-sm leading-relaxed text-text-primary">
      <ReactMarkdown
        components={{
          p: ({ children }) => <p className="mb-3 leading-relaxed last:mb-0">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-text-primary">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          h1: ({ children }) => (
            <h1 className="mb-2 font-display text-lg font-semibold text-text-primary">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 font-display text-base font-semibold text-text-primary">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-2 font-display text-sm font-semibold text-text-primary">{children}</h3>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-purple-text underline hover:text-purple-hover"
            >
              {children}
            </a>
          ),
          code: ({ children }) => (
            <code className="rounded bg-surface-hover px-1 py-0.5 font-mono text-xs">{children}</code>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-white/10 pl-3 text-text-muted">{children}</blockquote>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

function VideoCardDisplay({ card }: { card: VideoCard }) {
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-white/10 bg-surface-hover">
      <div className="aspect-video w-full overflow-hidden bg-surface">
        {card.thumbnail_url ? (
          <img src={card.thumbnail_url} alt={card.title} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              className="h-8 w-8 text-text-muted"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15.75 10.5l4.72-2.36a.75.75 0 0 1 1.08.67v8.38a.75.75 0 0 1-1.08.67l-4.72-2.36M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-7.5A2.25 2.25 0 0 0 13.5 6.75h-9A2.25 2.25 0 0 0 2.25 9v7.5a2.25 2.25 0 0 0 2.25 2.25Z"
              />
            </svg>
          </div>
        )}
      </div>
      <div className="p-3">
        <p className="truncate font-body text-sm font-medium text-text-primary">{card.title}</p>
        <p className="mt-0.5 text-xs text-text-muted">{card.total_comments} comments</p>
        {Object.keys(card.category_counts).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {Object.entries(card.category_counts)
              .sort((a, b) => b[1] - a[1])
              .map(([category, count]) => (
                <span key={category} className={`badge badge-${category}`}>
                  {count} {category.replace(/_/g, ' ')}
                </span>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ~8 lines of text at this font size before the textarea starts scrolling internally.
const MAX_TEXTAREA_HEIGHT = 200

const SUGGESTED_QUESTIONS = [
  "What's trending?",
  'What should I post next?',
  'What does my audience want?',
  'Show me repeated comments',
]

function ArrowRightIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
    </svg>
  )
}

/**
 * The phone-first Research landing view, shown below lg before anything is asked.
 *
 * Uses a single-line <input> rather than reusing the chat's auto-growing
 * <textarea>: the mockup's element is a search field, and — more practically — two
 * textareas bound to the same `input` state would fight over one autogrow ref.
 */
function MobileResearchLanding({
  onAsk,
  interests,
  trending,
  error,
  hasMessages,
}: {
  onAsk: (question: string) => void
  interests: SidebarInterest[]
  trending: SidebarTrendingTopic[]
  error: string | null
  hasMessages: boolean
}) {
  return (
    // The page-level ResearchHero now carries the welcome heading, so this view
    // opens straight into the ask field rather than repeating a greeting.
    <div className="space-y-5">
      {/* The inline composer moved to the full-screen chat route. This screen is now
          an overview whose single job is to get you into the conversation. */}
      <Link
        href="/dashboard/research/chat"
        className="btn-primary flex w-full items-center justify-center gap-2 py-3.5 text-base"
      >
        {hasMessages ? 'Continue chat' : 'Start Chat'}
        <ArrowRightIcon />
      </Link>
      {error && <p className="text-sm text-avax-red">{error}</p>}

      <div className="flex flex-wrap gap-2">
        {SUGGESTED_QUESTIONS.map(question => (
          <button
            key={question}
            onClick={() => onAsk(question)}
            className="rounded-full border border-white/10 bg-surface px-4 py-2 text-sm text-text-primary transition-colors active:bg-surface-hover"
          >
            {question}
          </button>
        ))}
      </div>

      <section className="card">
        <h2 className="mb-3 font-display text-base font-semibold text-text-primary">
          Audience Insights
        </h2>
        <InterestBars interests={interests} />
      </section>

      <section className="card">
        <h2 className="mb-3 font-display text-base font-semibold text-text-primary">
          Trending topics
        </h2>
        <TrendingList topics={trending} />
      </section>

      <section className="gradient-primary rounded-xl p-5">
        <p className="font-display text-lg leading-snug font-semibold text-white">
          Want to know what your audience really thinks?
        </p>
        <p className="mt-1.5 text-sm leading-relaxed text-white/85">
          Your agent has read every comment. Ask it anything.
        </p>
        <button
          onClick={() => onAsk('What does my audience really think?')}
          className="mt-4 w-full rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-[#151530] transition-colors active:bg-white/90"
        >
          Ask this
        </button>
      </section>
    </div>
  )
}

// The message list itself — every card renderer, the typing indicator and the
// inline error. Shared verbatim by the desktop panel and the full-screen mobile
// view so there is exactly ONE rendering of a conversation in the app.
function ChatThread({
  messages,
  loading,
  error,
  lastAssistantIndex,
  onRegenerate,
}: {
  messages: ChatMessage[]
  loading: boolean
  error: string | null
  lastAssistantIndex: number
  onRegenerate: () => void
}) {
  return (
    <>
          {messages.map((message, index) =>
        message.role === 'user' ? (
          <div key={index} className="flex flex-col items-end gap-1">
            <div className="max-w-[75%] rounded-2xl rounded-br-sm bg-purple px-4 py-3 text-sm whitespace-pre-wrap text-white">
              {message.content}
            </div>
            <span className="font-mono text-[10px] text-text-muted">{formatTime(message.createdAt)}</span>
          </div>
        ) : (
          <div key={index} className="flex flex-col items-start gap-1">
            <div className="card max-w-[75%] rounded-tl-sm border-l-2 border-pink">
              {message.statsCards?.map(card => (
                <StatsCardDisplay key={card.title} card={card} />
              ))}
              {message.anomalyCard && <AnomalyCardDisplay card={message.anomalyCard} />}
              <MarkdownMessage content={message.content} />
              {message.personCards?.map(card => (
                <PersonCardDisplay key={card.display_name} card={card} />
              ))}
              {message.ideaCards?.map(card => (
                <IdeaCardDisplay key={card.number} card={card} />
              ))}
              {message.videoCards?.map(card => (
                <VideoCardDisplay key={card.post_id} card={card} />
              ))}
            </div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-[10px] text-text-muted">{formatTime(message.createdAt)}</span>
              <CopyResponseButton text={message.content} />
              {index === lastAssistantIndex && (
                <RegenerateButton onClick={onRegenerate} disabled={loading} />
              )}
            </div>
          </div>
        )
      )}

      {loading && <TypingIndicator />}

      {error && <p className="mr-auto text-sm text-avax-red">{error}</p>}
    </>
  )
}

export default function ResearchChat({
  variant = 'page',
  interests = [],
  trending = [],
}: {
  /** 'page' = the mobile landing + desktop panel. 'fullscreen' = the mobile chat route. */
  variant?: 'page' | 'fullscreen'
  interests?: SidebarInterest[]
  trending?: SidebarTrendingTopic[]
}) {
  // All conversation state comes from the provider in the research layout, so it
  // survives navigating between the landing screen and the full-screen chat.
  const {
    messages,
    input,
    loading,
    error,
    hasMessages,
    lastAssistantIndex,
    setInput,
    sendMessage,
    regenerate,
    startNewChat,
  } = useResearchChat()

  const router = useRouter()
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, loading])

  // Grow the textarea to fit its content up to MAX_TEXTAREA_HEIGHT, then let it
  // scroll internally. Resetting to 'auto' first is what lets it shrink back down
  // (including to one line after a send clears the value).
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
  }, [input])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    sendMessage(input)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter falls through to the browser's newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  // A suggestion pill on the landing screen has to do two things: open the
  // full-screen view and ask the question. Navigating first means the reply streams
  // in where the creator is already looking, rather than behind them on a screen
  // that no longer renders messages.
  function handleAskFromLanding(question: string) {
    router.push('/dashboard/research/chat')
    sendMessage(question)
  }

  // Three shells, one conversation.
  //
  //  variant="fullscreen"  the mobile chat route: fixed to the viewport, its own
  //                        header with Back, nothing else on screen.
  //  variant="page" <lg    the landing/overview: audience cards and a Start Chat
  //                        button. Renders NO messages — the conversation lives on
  //                        the chat route now, so this stays an overview even mid-
  //                        conversation.
  //  variant="page" >=lg   the desktop hybrid panel, unchanged.
  //
  // State, handlers and every card renderer are shared, so this is a layout switch
  // rather than a second chat implementation.
  const isFullscreen = variant === 'fullscreen'

  if (isFullscreen) {
    return (
      // Fixed rather than h-screen: on mobile browsers h-screen tracks the LARGE
      // viewport, so the composer would sit under the address bar. inset-0 pins it
      // to the visible area instead. z-50 clears the tab bar's z-40 in case any
      // chrome is still mounted.
      <div className="fixed inset-0 z-50 flex flex-col bg-background">
        <header
          className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3"
          // The chat route renders outside the dashboard shell, so it carries its
          // own top inset for notched phones.
          style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}
        >
          <Link
            href="/dashboard/research"
            aria-label="Back to Research"
            className="-ml-1 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-text-muted transition-colors active:bg-surface-hover"
          >
            <span aria-hidden="true" className="text-base leading-none">←</span>
            Back
          </Link>
          <h1 className="font-display text-base font-semibold text-text-primary">Research</h1>
          {hasMessages ? (
            <button
              onClick={startNewChat}
              className="rounded-full border border-white/10 bg-surface px-3 py-1.5 text-xs text-text-muted transition-colors active:bg-surface-hover"
            >
              + New
            </button>
          ) : (
            // Keeps the title optically centred when there's no button yet.
            <span aria-hidden="true" className="w-14" />
          )}
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4">
          {!hasMessages && (
            <div className="flex h-full flex-col items-center justify-center gap-5 py-8 text-center">
              <p className="font-display text-lg font-semibold text-text-primary">
                Ask anything about your audience.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTED_QUESTIONS.map(question => (
                  <button
                    key={question}
                    onClick={() => sendMessage(question)}
                    className="rounded-full border border-white/10 bg-surface px-4 py-2 text-sm text-text-primary transition-colors active:bg-surface-hover"
                  >
                    {question}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className={`mx-auto max-w-2xl flex-col gap-5 py-5 ${hasMessages || loading || error ? 'flex' : 'hidden'}`}>
            <ChatThread
              messages={messages}
              loading={loading}
              error={error}
              lastAssistantIndex={lastAssistantIndex}
              onRegenerate={regenerate}
            />
          </div>
        </div>

        <div
          className="flex-shrink-0 border-t border-white/10 px-4 py-3"
          style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
        >
          <form onSubmit={handleSubmit} className="mx-auto flex max-w-2xl items-end gap-2">
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about your audience..."
              disabled={loading}
              className="flex-1 resize-none overflow-y-auto rounded-2xl border border-white/10 bg-surface px-4 py-3 text-base leading-relaxed text-text-primary placeholder:text-text-muted focus:ring-2 focus:ring-purple focus:ring-offset-2 focus:ring-offset-ink focus:outline-none disabled:opacity-50"
              style={{ maxHeight: MAX_TEXTAREA_HEIGHT }}
            />
            <button
              type="submit"
              disabled={!input.trim() || loading}
              aria-label="Send"
              className="btn-primary h-11 w-11 flex-shrink-0 rounded-full p-0 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="flex items-center justify-center"><ArrowRightIcon /></span>
            </button>
          </form>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="lg:hidden">
        <MobileResearchLanding
          onAsk={handleAskFromLanding}
          interests={interests}
          trending={trending}
          error={error}
          hasMessages={hasMessages}
        />
      </div>

      <div
        // Desktop only now: below lg the landing above owns the screen and the
        // conversation lives on its own route.
        className="hidden h-[70vh] min-h-[480px] flex-col overflow-hidden rounded-xl border border-white/10 bg-background lg:flex lg:h-[calc(100vh-27rem)] lg:min-h-[420px]"
      >
      <header className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-white/10 px-5 py-3">
        <h2 className="font-display text-base font-semibold text-text-primary">Research</h2>
        {hasMessages && (
          <button
            onClick={startNewChat}
            className="rounded-full border border-white/10 bg-surface px-3 py-1.5 text-xs text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
          >
            + New chat
          </button>
        )}
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5">
        {!hasMessages && (
          // The opening state lives inside the scroll area — the composer stays
          // bottom-anchored in the panel, so the old collapsing-spacer trick that
          // floated it to screen-centre no longer applies.
          <div className="flex h-full flex-col items-center justify-center gap-5 py-8 text-center">
            <p className="font-display text-lg font-semibold text-text-primary">
              Ask anything about your audience.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTED_QUESTIONS.map(question => (
                <button
                  key={question}
                  onClick={() => sendMessage(question)}
                  className="rounded-full border border-white/10 bg-surface px-4 py-2 text-sm text-text-primary transition-colors hover:bg-surface-hover"
                >
                  {question}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Collapsed while empty so its vertical padding can't push the h-full opening
            state above into a stray scrollbar. */}
        <div className={`mx-auto max-w-2xl flex-col gap-5 py-6 ${hasMessages || loading || error ? 'flex' : 'hidden'}`}>
          <ChatThread
            messages={messages}
            loading={loading}
            error={error}
            lastAssistantIndex={lastAssistantIndex}
            onRegenerate={regenerate}
          />
        </div>
      </div>

      {/* Composer is permanently bottom-anchored within the panel now. */}
      <div className="flex-shrink-0 border-t border-white/10 px-5 py-4">
        <div className="mx-auto max-w-2xl">
          <form onSubmit={handleSubmit} className="flex items-end gap-3">
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about your audience..."
              disabled={loading}
              className="flex-1 resize-none overflow-y-auto rounded-2xl border border-white/10 bg-surface px-5 py-3 text-sm leading-relaxed text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-purple focus:ring-offset-2 focus:ring-offset-ink disabled:opacity-50"
              style={{ maxHeight: MAX_TEXTAREA_HEIGHT }}
            />
            <button
              type="submit"
              disabled={!input.trim() || loading}
              className="btn-primary h-11 flex-shrink-0 rounded-full px-6 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Send
            </button>
          </form>
        </div>
      </div>
      </div>
    </>
  )
}
