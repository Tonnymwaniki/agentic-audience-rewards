import Link from 'next/link'
import { getReportContext } from '@/lib/research/report-context'
import { toolGetAudienceInsights } from '@/lib/research/engine'
import { plainText } from '@/lib/plain-text'
import { FollowUpInChat, ReportHeader } from '../ReportActions'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Audience Insights · Research' }

type Insight = {
  topic: string
  comment_count: number
  sentiment_breakdown: { positive: number; negative: number; neutral: number; total: number }
  trend: { direction: string; pct: number | null }
  confidence: number
  representative_comments: Array<{ ref: string; text: string; author: string; video: string }>
  videos: Array<{ video_ref: string; title: string }>
}

function titleCase(topic: string) {
  return topic.charAt(0).toUpperCase() + topic.slice(1)
}

function updatedAgo(hours: number) {
  if (hours < 1) return 'less than an hour ago'
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.round(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

/** Trend in plain words, with the percentage only where it means something. */
function TrendChip({ direction, pct }: { direction: string; pct: number | null }) {
  const styles: Record<string, { label: string; className: string }> = {
    rising: { label: pct === null ? 'Rising' : `Rising +${pct}%`, className: 'bg-green-dim text-green' },
    falling: { label: pct === null ? 'Falling' : `Falling ${pct}%`, className: 'bg-white/10 text-text-muted' },
    stable: { label: 'Steady', className: 'bg-white/10 text-text-muted' },
    new: { label: 'New this month', className: 'bg-purple/20 text-purple-text' },
    insufficient_data: { label: 'Not enough data for a trend', className: 'bg-white/5 text-text-muted' },
  }
  const style = styles[direction] ?? styles.insufficient_data
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${style.className}`}>{style.label}</span>
}

/**
 * Confidence is n/(n+10): about 0.5 at 10 comments and 0.8 at 40. Shown as a word,
 * because a bare 0.52 invites more precision than the number has.
 */
function confidenceLabel(confidence: number) {
  if (confidence >= 0.75) return 'Strong signal'
  if (confidence >= 0.5) return 'Moderate signal'
  return 'Early signal'
}

/**
 * Audience Insights: the precomputed audience_insights rows for this creator,
 * read straight from the table (computed daily by /api/cron/compute-insights), so
 * the page is fast and makes no AI call.
 */
export default async function InsightsReportPage() {
  const ctx = await getReportContext()
  const result = (await toolGetAudienceInsights(ctx, {})) as
    | { insights: Insight[]; computed_at: string; age_hours: number }
    | { found: false; note: string }
    | { error: string }

  const insights = 'insights' in result ? result.insights : []

  return (
    <div className="mx-auto max-w-3xl">
      <ReportHeader
        title="Audience Insights"
        subtitle={
          'insights' in result
            ? `The ${insights.length} biggest themes in your comments. Updated ${updatedAgo(result.age_hours)}.`
            : 'The biggest themes in your comments, updated daily.'
        }
      />

      {insights.length === 0 ? (
        <section className="card text-center">
          <p className="font-display text-lg font-semibold text-text-primary">Insights aren&apos;t ready yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">
            They&apos;re calculated once a day from your analyzed videos. Check back tomorrow, or ask the chat directly in
            the meantime.
          </p>
        </section>
      ) : (
        <ol className="space-y-4">
          {insights.map(insight => {
            const s = insight.sentiment_breakdown
            return (
              <li key={insight.topic} className="card">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="font-display text-lg font-semibold text-text-primary">{titleCase(insight.topic)}</h2>
                  <TrendChip direction={insight.trend.direction} pct={insight.trend.pct} />
                </div>
                <p className="mt-1 text-sm text-text-muted">
                  <span className="font-semibold text-text-primary">{insight.comment_count}</span> comments ·{' '}
                  {confidenceLabel(insight.confidence)}
                </p>

                {/* Sentiment from comment categories: praise = positive, complaint = negative. */}
                <div className="mt-3">
                  <div
                    className="flex h-2 w-full overflow-hidden rounded-full bg-surface-hover"
                    role="img"
                    aria-label={`Sentiment: ${s.positive}% positive, ${s.neutral}% neutral, ${s.negative}% negative`}
                  >
                    <div style={{ width: `${s.positive}%`, background: 'var(--purple)' }} />
                    <div style={{ width: `${s.neutral}%`, background: 'var(--text-muted)' }} />
                    <div style={{ width: `${s.negative}%`, background: 'var(--avax-red)' }} />
                  </div>
                  <p className="mt-1.5 text-xs text-text-muted">
                    {s.positive}% positive · {s.neutral}% neutral · {s.negative}% negative
                  </p>
                </div>

                {insight.representative_comments.length > 0 && (
                  <ul className="mt-4 space-y-2">
                    {insight.representative_comments.map(c => (
                      <li key={c.ref} className="border-l-2 border-white/10 pl-3">
                        <p className="break-words text-sm text-text-primary">&ldquo;{plainText(c.text)}&rdquo;</p>
                        <p className="mt-0.5 truncate text-xs text-text-muted">
                          {c.author} · {c.video}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}

                {insight.videos.length > 0 && (
                  <p className="mt-3 text-xs text-text-muted">
                    Most discussed on:{' '}
                    {insight.videos.map((v, i) => (
                      <span key={v.video_ref}>
                        {i > 0 && ', '}
                        <span className="text-text-primary">{v.title}</span>
                      </span>
                    ))}
                  </p>
                )}
              </li>
            )
          })}
        </ol>
      )}

      <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
        <FollowUpInChat prompt="Tell me more about what my audience talks about most, and what I should do about it." />
        <Link
          href="/dashboard/research/ideas"
          className="inline-flex min-h-11 items-center justify-center text-sm text-purple-text underline hover:text-purple-hover"
        >
          Turn this into content ideas
        </Link>
      </div>
    </div>
  )
}
