import { createServiceClient } from '@/lib/supabase/service'
import { computeWorkspace, loadWorkspaceRaw, type Share, type WorkspaceSummary } from '@/lib/agent-workspace'
import { COMING_SOON, PlatformIcon } from '@/components/PlatformIcon'

/**
 * Agent Workspace — replaces Recent Activity. An operational summary of what the
 * agent has: its sources, what it has ingested, the health of that data, and what
 * it has learned. Every number is computed from stored rows (lib/agent-workspace);
 * anything with no data behind it says so instead of showing a placeholder.
 *
 * `creatorId` must be the session-derived id; the service client is needed for the
 * channel-verification lookup (youtube_oauth_tokens is service-role only).
 */
export default async function AgentWorkspace({ creatorId }: { creatorId: string }) {
  const summary = computeWorkspace(await loadWorkspaceRaw(createServiceClient(), creatorId))
  return <WorkspaceView s={summary} />
}

export function AgentWorkspaceSkeleton() {
  return (
    <section className="card" aria-busy="true">
      <h2 className="mb-2 font-display text-base font-semibold text-text-primary">Agent Workspace</h2>
      <p className="text-sm text-text-muted">Loading your workspace…</p>
    </section>
  )
}

const LANGUAGE_LABELS: Record<string, string> = {
  english: 'English',
  swahili_sheng: 'Swahili / Sheng',
  mixed: 'Mixed',
  none: 'Not detected',
}
const SENTIMENT_TONE: Record<string, string> = {
  positive: 'bg-green',
  neutral: 'bg-text-muted/60',
  negative: 'bg-avax-red',
  mixed: 'bg-gold',
}
const STATUS_LABELS: Record<string, string> = { done: 'Done', running: 'Running', error: 'Error', idle: 'Not analyzed' }

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' }) + ' EAT'

function Label({ children }: { children: React.ReactNode }) {
  return <p className="mb-2 font-mono text-[10px] tracking-widest text-text-muted uppercase">{children}</p>
}

function Unavailable({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-text-muted italic">{children}</span>
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="text-text-muted">{label}</span>
      <span className="text-right text-text-primary">{children}</span>
    </div>
  )
}

function ShareBars({ items, labels, tones }: { items: Share[]; labels: Record<string, string>; tones?: Record<string, string> }) {
  return (
    <ul className="space-y-1.5">
      {items.map(i => (
        <li key={i.key}>
          <div className="flex justify-between text-xs">
            <span className="text-text-primary">{labels[i.key] ?? i.key}</span>
            <span className="text-text-muted">
              {i.percent}% <span className="text-text-muted/70">· {i.count.toLocaleString()}</span>
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-hover">
            <div className={`h-full rounded-full ${tones?.[i.key] ?? 'bg-purple'}`} style={{ width: `${Math.min(100, i.percent)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/10 bg-surface-hover/40 p-4">
      <h3 className="mb-3 font-display text-sm font-semibold text-text-primary">{title}</h3>
      {children}
    </div>
  )
}

function TrendBadge({ trend, pct }: { trend: string | null; pct: number | null }) {
  if (!trend) return <span className="text-text-muted">—</span>
  // Both occur in stored insights: a theme with no earlier window to compare to, and
  // one with too few comments for a trend to mean anything.
  if (trend === 'new') return <span className="text-purple-text">new</span>
  if (trend === 'insufficient_data') return <span className="text-text-muted">too early to tell</span>
  const arrow = trend === 'rising' ? '↑' : trend === 'falling' ? '↓' : '→'
  const tone = trend === 'rising' ? 'text-green' : trend === 'falling' ? 'text-avax-red' : 'text-text-muted'
  return (
    <span className={tone}>
      {arrow} {trend}
      {pct !== null && trend !== 'stable' ? ` ${Math.abs(Math.round(pct))}%` : ''}
    </span>
  )
}

function WorkspaceView({ s }: { s: WorkspaceSummary }) {
  const yt = s.sources.youtube
  const unverified = yt.channels.filter(c => !c.verified)

  return (
    <section className="card">
      <h2 className="font-display text-base font-semibold text-text-primary">Agent Workspace</h2>
      <p className="mb-4 text-xs text-text-muted">What your agent is working with, from your stored data.</p>

      <div className="grid gap-3 md:grid-cols-2">
        {/* ------------------------------------------------ connected sources */}
        <Block title="Connected sources">
          <div className="flex items-start gap-3">
            <PlatformIcon id="youtube" className="h-7 w-7 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-text-primary">
                YouTube{' '}
                <span className={`ml-1 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase ${yt.connected ? 'bg-teal-dim text-teal' : 'bg-surface-hover text-text-muted'}`}>
                  {yt.connected ? 'Connected' : 'Not connected'}
                </span>
              </p>
              {yt.channels.filter(c => c.verified).map(c => (
                <p key={c.channelId} className="mt-1 truncate text-xs text-green">✓ {c.title ?? c.channelId} · verified</p>
              ))}
              {unverified.length > 0 && (
                <p className="mt-1 text-xs text-text-muted">
                  {unverified.length} analyzed {unverified.length === 1 ? 'channel' : 'channels'} not verified
                </p>
              )}
              <Row label="Subscribers">
                {yt.subscribers === null ? <Unavailable>not yet available</Unavailable> : yt.subscribers.toLocaleString()}
              </Row>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
            {COMING_SOON.map(p => (
              <span key={p.id} title={`${p.name} — coming soon`} className="opacity-50 grayscale">
                <PlatformIcon id={p.id} className="h-5 w-5" />
              </span>
            ))}
            <span className="text-[11px] text-text-muted">coming soon</span>
          </div>
        </Block>

        {/* -------------------------------------------------------- ingestion */}
        <Block title="Ingestion">
          <Row label="Last sync">
            {s.ingestion.lastSync ? (
              <>
                {fmtDate(s.ingestion.lastSync.at)}
                <span className="block text-[11px] text-text-muted">{s.ingestion.lastSync.source}</span>
              </>
            ) : (
              <Unavailable>no sync yet</Unavailable>
            )}
          </Row>
          <Row label="Comments collected">{s.ingestion.total.toLocaleString()}</Row>
          <Row label="· top-level / replies">
            {s.ingestion.topLevel.toLocaleString()} / {s.ingestion.replies.toLocaleString()}
          </Row>
          <Row label="New in last 24h / 7d">
            {s.ingestion.new24h.toLocaleString()} / {s.ingestion.new7d.toLocaleString()}
          </Row>
          <Row label="Failed items (last sync)">
            <Unavailable>not currently tracked</Unavailable>
          </Row>
        </Block>

        {/* ------------------------------------------------------ data health */}
        <Block title="Data health">
          <Label>Language · {s.health.categorized.toLocaleString()} categorized</Label>
          {s.health.categorized > 0 ? (
            <ShareBars items={s.health.languages} labels={LANGUAGE_LABELS} />
          ) : (
            <Unavailable>not yet available</Unavailable>
          )}
          <div className="mt-3 border-t border-white/10 pt-2">
            <Row label="Spam detected">{s.health.spam.toLocaleString()}</Row>
            <Row label="Videos by status">
              {s.health.processing
                .filter(p => p.count > 0)
                .map(p => `${p.count} ${(STATUS_LABELS[p.status] ?? p.status).toLowerCase()}`)
                .join(' · ') || '—'}
            </Row>
            <Row label="Legacy videos">
              {s.health.legacyVideos} of {s.health.videos}
              <span className="block text-[11px] text-text-muted">missing duration or category</span>
            </Row>
          </div>
        </Block>

        {/* ----------------------------------------------------- intelligence */}
        <Block title="Intelligence">
          <Label>Top themes{s.intelligence.themes ? ` · as of ${fmtDate(s.intelligence.themes.computedAt)}` : ''}</Label>
          {s.intelligence.themes ? (
            <ul className="space-y-1">
              {s.intelligence.themes.items.map(t => (
                <li key={t.topic} className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate text-text-primary capitalize">{t.topic}</span>
                  <span className="flex-shrink-0 text-text-muted">
                    {t.comments} · <TrendBadge trend={t.trend} pct={t.trendPct} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Unavailable>not yet available — themes are computed daily</Unavailable>
          )}

          <div className="mt-3 border-t border-white/10 pt-2">
            <Label>
              Sentiment · {s.intelligence.sentiment.scored.toLocaleString()} scored
              {s.intelligence.sentiment.unscored > 0 ? `, ${s.intelligence.sentiment.unscored.toLocaleString()} not scored` : ''}
            </Label>
            {s.intelligence.sentiment.scored > 0 ? (
              <ShareBars
                items={s.intelligence.sentiment.shares}
                labels={{ positive: 'Positive', neutral: 'Neutral', negative: 'Negative', mixed: 'Mixed' }}
                tones={SENTIMENT_TONE}
              />
            ) : (
              <Unavailable>not yet available</Unavailable>
            )}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 border-t border-white/10 pt-3">
            {s.intelligence.categoryMix.map(c => (
              <div key={c.key} className="rounded-lg border border-white/10 px-2.5 py-2">
                <p className="font-display text-lg leading-none text-text-primary">{c.count.toLocaleString()}</p>
                <p className="mt-1 text-[11px] text-text-muted">{c.label}</p>
              </div>
            ))}
          </div>
        </Block>
      </div>
    </section>
  )
}
