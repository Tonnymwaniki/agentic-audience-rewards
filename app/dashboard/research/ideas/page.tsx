import { Suspense } from 'react'
import { getReportContext } from '@/lib/research/report-context'
import { toolSuggestContentIdeas, type ToolContext } from '@/lib/research/engine'
import {
  IDEAS_FAILED_MESSAGE,
  numberSignals,
  signalKindLabel,
  synthesizeContentIdeas,
  type ContentIdea,
  type Signal,
} from '@/lib/research/content-ideas'
import { isFresh, loadCachedIdeas, saveCachedIdeas, type SignalCounts } from '@/lib/research/content-ideas-cache'
import { FollowUpInChat, ReportHeader } from '../ReportActions'
import { ClearRefreshParam } from './ClearRefreshParam'

export const dynamic = 'force-dynamic'
// A fresh generation is one model call while the page streams.
export const maxDuration = 60

export const metadata = { title: 'Content Ideas · Research' }

const REFRESH_HREF = '/dashboard/research/ideas?refresh=1'

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`
}

function subtitleFor(c: SignalCounts) {
  const parts = [
    c.requests > 0 && plural(c.requests, 'content request', 'content requests'),
    c.questions > 0 && plural(c.questions, 'audience question', 'audience questions'),
    c.buying > 0 && plural(c.buying, 'buying signal', 'buying signals'),
    c.repeated > 0 && plural(c.repeated, 'repeated comment', 'repeated comments'),
  ].filter((part): part is string => !!part)
  if (parts.length === 0) return 'What to make next, based on your audience’s comments.'
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `What to make next, based on ${list}.`
}

function generatedAgo(iso: string, now = Date.now()) {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${plural(minutes, 'minute', 'minutes')} ago`
  return `${plural(Math.floor(minutes / 60), 'hour', 'hours')} ago`
}

/**
 * Content Ideas: the same audience signals the chat's suggest_content_ideas tool
 * gathers, turned into 3-5 ideas by a single model call.
 *
 * The last successful generation is cached for a day (content_ideas_cache), so a
 * repeat visit renders straight from one row read with no model call and no
 * signal gathering. ?refresh=1 (the Regenerate / Try again links) bypasses it.
 * A fresh generation streams in behind a Suspense boundary, so the page never
 * sits blank waiting on the model.
 */
export default async function IdeasReportPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const refresh = (await searchParams).refresh === '1'
  const ctx = await getReportContext()

  const cached = refresh ? null : await loadCachedIdeas(ctx.supabase, ctx.creatorId)
  if (cached && isFresh(cached)) {
    return (
      <IdeasShell subtitle={subtitleFor(cached.signal_counts)}>
        <IdeasCards ideas={cached.ideas} generatedAt={cached.generated_at} />
      </IdeasShell>
    )
  }

  const signals = numberSignals(await toolSuggestContentIdeas(ctx))
  const counts: SignalCounts = {
    requests: signals.filter(s => s.kind === 'content_request').length,
    questions: signals.filter(s => s.kind === 'question').length,
    buying: signals.filter(s => s.kind === 'purchase_intent').length,
    repeated: signals.filter(s => s.kind === 'repeated').length,
  }

  return (
    <IdeasShell subtitle={subtitleFor(counts)}>
      {refresh && <ClearRefreshParam />}
      {signals.length === 0 ? (
        <section className="card text-center">
          <p className="font-display text-lg font-semibold text-text-primary">Not enough audience signal yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">
            Ideas come from content requests, questions, buying signals and repeated comments. Analyze a few more videos and check back.
          </p>
        </section>
      ) : (
        <Suspense fallback={<IdeasLoading />}>
          <GeneratedIdeas ctx={ctx} signals={signals} counts={counts} />
        </Suspense>
      )}
    </IdeasShell>
  )
}

function IdeasShell({ subtitle, children }: { subtitle: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl">
      <ReportHeader title="Content Ideas" subtitle={subtitle} />
      {children}
      <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
        <FollowUpInChat prompt="Help me develop one of these content ideas into a video plan." />
      </div>
    </div>
  )
}

async function GeneratedIdeas({ ctx, signals, counts }: { ctx: ToolContext; signals: Signal[]; counts: SignalCounts }) {
  const { ideas, error } = await synthesizeContentIdeas(signals)

  // Rejected results (too fast, too few ideas, or any error) are never shown and
  // never cached, so the next visit tries again.
  if (error || ideas.length === 0) {
    return (
      <section className="card text-center" role="alert">
        <p className="font-display text-lg font-semibold text-text-primary">{IDEAS_FAILED_MESSAGE}</p>
        <a
          href={REFRESH_HREF}
          className="gradient-primary mt-4 inline-flex min-h-[44px] items-center justify-center rounded-lg px-5 text-sm font-semibold text-white"
        >
          Try again
        </a>
      </section>
    )
  }

  const generatedAt = await saveCachedIdeas(ctx.supabase, ctx.creatorId, ideas, counts)
  return <IdeasCards ideas={ideas} generatedAt={generatedAt} />
}

function IdeasCards({ ideas, generatedAt }: { ideas: ContentIdea[]; generatedAt: string }) {
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="text-xs text-text-muted" data-generated-at={generatedAt}>
          Generated {generatedAgo(generatedAt)}
        </p>
        <a href={REFRESH_HREF} className="inline-flex min-h-[44px] items-center text-sm font-medium text-purple hover:underline">
          Regenerate
        </a>
      </div>
      <ol className="space-y-4">
        {ideas.map(idea => (
          <li key={idea.number} className="card">
            <div className="flex items-start gap-3">
              <span className="gradient-primary flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-xs text-white">
                {idea.number}
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="font-display text-lg font-semibold text-text-primary">{idea.title}</h2>
                <p className="mt-1 text-sm text-text-muted">{idea.description}</p>
                <div className="mt-3">
                  <p className="mb-1.5 font-mono text-[10px] tracking-wide text-text-muted uppercase">Based on</p>
                  <ul className="space-y-1.5">
                    {idea.signals.map(signal => (
                      <li key={signal.id} className="border-l-2 border-purple/40 pl-3 text-sm">
                        <span className="break-words text-text-primary">
                          {signal.kind === 'topic' ? signal.text : <>&ldquo;{signal.text}&rdquo;</>}
                        </span>
                        <span className="block text-xs text-text-muted">
                          {signalKindLabel(signal.kind)} · {signal.detail}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </>
  )
}

function IdeasLoading() {
  return (
    <section className="card" aria-busy="true" aria-live="polite">
      <p className="text-sm text-text-muted">Reading your audience signals and drafting ideas…</p>
      <div className="mt-4 space-y-3" aria-hidden="true">
        {[0, 1, 2].map(i => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-surface-hover" />
        ))}
      </div>
    </section>
  )
}
