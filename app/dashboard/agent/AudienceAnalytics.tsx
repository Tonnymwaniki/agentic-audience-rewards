import { createServiceClient } from '@/lib/supabase/service'
import { VERIFY_OWNERSHIP_PATH } from '@/lib/channel-verification'
import {
  audienceHeadline,
  formatDuration,
  lastDays,
  loadChannelAnalytics,
  type AnalyticsResult,
  type ChannelAnalytics,
} from '@/lib/youtube-analytics'

const WINDOW_DAYS = 28

/**
 * Real audience analytics for the creator's VERIFIED channel(s), streamed in
 * behind a Suspense boundary so four Google calls never hold up Agent Home.
 *
 * Renders nothing for a creator with no verified channel: analytics come from the
 * channel owner's own grant, so there is nothing to show — and nothing that could
 * be shown — for a channel they have not proven is theirs.
 *
 * `creatorId` must be the session-derived id. The service client is required
 * because youtube_oauth_tokens is readable only by the service role.
 */
export default async function AudienceAnalytics({ creatorId }: { creatorId: string }) {
  const supabase = createServiceClient()
  const { data: grants } = await supabase
    .from('youtube_oauth_tokens')
    .select('channel_id, channel_title')
    .eq('creator_id', creatorId)

  const channels = ((grants ?? []) as Array<{ channel_id: string | null; channel_title: string | null }>)
    .filter((g): g is { channel_id: string; channel_title: string | null } => Boolean(g.channel_id))
  if (channels.length === 0) return null

  const range = lastDays(WINDOW_DAYS)
  const results = await Promise.all(
    channels.map(async c => ({ channel: c, result: await loadChannelAnalytics(supabase, creatorId, c.channel_id, range) }))
  )

  return (
    <>
      {results.map(({ channel, result }) => (
        <AudienceCard key={channel.channel_id} title={channel.channel_title ?? channel.channel_id} result={result} />
      ))}
    </>
  )
}

export function AudienceAnalyticsSkeleton() {
  return (
    <section className="card" aria-busy="true">
      <h2 className="mb-2 font-display text-base font-semibold text-text-primary">Your audience</h2>
      <p className="text-sm text-text-muted">Loading your channel analytics from YouTube…</p>
    </section>
  )
}

export function AudienceCard({ title, result }: { title: string; result: AnalyticsResult }) {
  if (!result.ok) {
    if (result.reason === 'no_grant') return null
    return (
      <section className="card">
        <h2 className="mb-1 font-display text-base font-semibold text-text-primary">Your audience</h2>
        <p className="mb-3 text-xs text-text-muted">{title}</p>
        <FailureNotice reason={result.reason} />
      </section>
    )
  }
  return <AnalyticsBody title={title} a={result.data} />
}

function FailureNotice({ reason }: { reason: Exclude<AnalyticsResult, { ok: true }>['reason'] }) {
  // The two cases the creator can fix get a clear action; the rest are ours to fix
  // (logged server-side) and say so without blaming their connection.
  if (reason === 'reconsent_required' || reason === 'reconnect_required') {
    return (
      <div className="rounded-xl border border-purple/40 bg-purple/10 p-4">
        <p className="text-sm font-medium text-text-primary">Re-connect to unlock audience demographics</p>
        <p className="mt-1 text-xs leading-relaxed text-text-muted">
          {reason === 'reconsent_required'
            ? 'Your YouTube connection doesn’t include access to your channel’s analytics yet. Reconnecting asks Google for read-only access to aggregate audience figures — nothing is posted or changed.'
            : 'Your YouTube connection has expired or was removed in your Google account. Reconnect to see your audience’s age, countries and how they find you.'}
        </p>
        <a href={VERIFY_OWNERSHIP_PATH} className="btn-primary mt-3 inline-flex">
          Re-connect YouTube
        </a>
      </div>
    )
  }
  return (
    <p className="text-sm text-text-muted">
      Audience analytics are unavailable right now. Everything else on this page is unaffected.
    </p>
  )
}

function Bar({ percent }: { percent: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-hover">
      <div className="h-full rounded-full bg-purple" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/10 bg-surface-hover p-3">
      <p className="font-mono text-[10px] tracking-widest text-text-muted uppercase">{label}</p>
      <p className="mt-1 font-display text-lg text-text-primary">{value}</p>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-2 font-mono text-[10px] tracking-widest text-text-muted uppercase">{children}</p>
}

function AnalyticsBody({ title, a }: { title: string; a: ChannelAnalytics }) {
  const headline = a.totals.views === 0 ? `No views on ${title} in the last ${WINDOW_DAYS} days.` : audienceHeadline(a)
  const hours = a.totals.minutesWatched / 60

  return (
    <section className="card">
      <h2 className="font-display text-base font-semibold text-text-primary">Your audience</h2>
      <p className="mb-3 text-xs text-text-muted">
        {title} · last {WINDOW_DAYS} days
      </p>

      {headline && <p className="mb-4 text-sm leading-relaxed text-text-primary">{headline}</p>}

      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Views" value={a.totals.views.toLocaleString()} />
        <Stat
          label="Watch time"
          value={
            hours >= 100
              ? `${Math.round(hours).toLocaleString()} h`
              : hours >= 1
                ? `${hours.toFixed(1)} h`
                : `${Math.round(a.totals.minutesWatched)} min`
          }
        />
        <Stat label="Avg view" value={formatDuration(a.totals.averageViewDurationSeconds)} />
        <Stat label="Avg % watched" value={a.totals.averageViewPercentage === null ? '—' : `${Math.round(a.totals.averageViewPercentage)}%`} />
      </div>

      {a.demographics ? (
        <div className="mb-5 grid gap-5 sm:grid-cols-2">
          <div>
            <SectionLabel>Age</SectionLabel>
            <ul className="space-y-2">
              {a.demographics.ageGroups.map(g => (
                <li key={g.ageGroup}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="text-text-primary">{g.label}</span>
                    <span className="text-text-muted">{g.percent}%</span>
                  </div>
                  <Bar percent={g.percent} />
                </li>
              ))}
            </ul>
          </div>
          <div>
            <SectionLabel>Gender</SectionLabel>
            <ul className="space-y-2">
              {a.demographics.genders.map(g => (
                <li key={g.gender}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="text-text-primary">{g.label}</span>
                    <span className="text-text-muted">{g.percent}%</span>
                  </div>
                  <Bar percent={g.percent} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <p className="mb-5 rounded-xl border border-white/10 bg-surface-hover p-3 text-xs leading-relaxed text-text-muted">
          YouTube hasn’t released age and gender figures for this period. It withholds them until enough people have
          watched for the numbers to stay anonymous — they’ll appear here as your audience grows.
        </p>
      )}

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <SectionLabel>Top countries</SectionLabel>
          {a.countries.length > 0 ? (
            <ul className="space-y-2">
              {a.countries.map(c => (
                <li key={c.code}>
                  <div className="mb-1 flex justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate text-text-primary">{c.name}</span>
                    <span className="flex-shrink-0 text-text-muted">{c.share}% of views</span>
                  </div>
                  <Bar percent={c.share} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-text-muted">Not reported for this period yet.</p>
          )}
        </div>
        <div>
          <SectionLabel>How viewers find you</SectionLabel>
          {a.trafficSources.length > 0 ? (
            <ul className="space-y-2">
              {a.trafficSources.map(t => (
                <li key={t.type}>
                  <div className="mb-1 flex justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate text-text-primary">{t.label}</span>
                    <span className="flex-shrink-0 text-text-muted">{t.share}%</span>
                  </div>
                  <Bar percent={t.share} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-text-muted">Not reported for this period yet.</p>
          )}
        </div>
      </div>

      <p className="mt-5 border-t border-white/10 pt-3 text-[11px] leading-relaxed text-text-muted">
        Aggregate figures from YouTube Analytics for your own channel. They describe your audience as a whole — no
        individual viewer is identified.
      </p>
    </section>
  )
}
