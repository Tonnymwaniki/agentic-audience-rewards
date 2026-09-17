import Link from 'next/link'
import { getReportContext } from '@/lib/research/report-context'
import { toolGetTrending } from '@/lib/research/engine'
import { plainText } from '@/lib/plain-text'
import { FollowUpInChat, ReportHeader } from '../ReportActions'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Real-Time Trends · Research' }

/**
 * Real-Time Trends: the same repeated-comment grouping the chat's get_trending
 * tool uses, computed live on each visit (no AI call). A "trend" here is the same
 * comment posted by at least two different people — one person repeating
 * themselves doesn't count.
 */
export default async function TrendsReportPage() {
  const ctx = await getReportContext()
  const { count, groups } = await toolGetTrending(ctx, {})
  const people = groups.reduce((sum, g) => sum + g.unique_people, 0)

  return (
    <div className="mx-auto max-w-3xl">
      <ReportHeader
        title="Real-Time Trends"
        subtitle={
          count === 0
            ? 'Comments that several different people have posted, across all your videos.'
            : `${count} ${count === 1 ? 'comment is' : 'comments are'} being repeated by different people — ${people} ${people === 1 ? 'person' : 'people'} in total, across all your videos.`
        }
      />

      {count === 0 ? (
        <section className="card text-center">
          <p className="font-display text-lg font-semibold text-text-primary">Nothing is repeating yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">
            No comment has been posted by two or more different people so far. That usually changes as more videos are
            analyzed. For the broader themes your audience keeps coming back to, see Audience Insights.
          </p>
          <Link
            href="/dashboard/research/insights"
            className="mt-4 inline-flex min-h-11 items-center text-sm text-purple-text underline hover:text-purple-hover"
          >
            Open Audience Insights
          </Link>
        </section>
      ) : (
        <ol className="space-y-3">
          {groups.map((group, index) => (
            <li key={`${index}-${group.text}`} className="card">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 font-mono text-xs text-text-muted">{String(index + 1).padStart(2, '0')}</span>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-base text-text-primary">&ldquo;{plainText(group.text)}&rdquo;</p>
                  <p className="mt-2 text-xs text-text-muted">
                    <span className="font-semibold text-purple-text">{group.count}×</span> by {group.unique_people}{' '}
                    {group.unique_people === 1 ? 'person' : 'different people'}
                  </p>
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {group.video_titles.map(title => (
                      <li
                        key={title}
                        className="max-w-full truncate rounded-full border border-white/10 bg-surface-hover px-2.5 py-1 text-xs text-text-muted"
                      >
                        {title}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
        <FollowUpInChat prompt="What do the comments people keep repeating tell me about my audience?" />
      </div>
    </div>
  )
}
