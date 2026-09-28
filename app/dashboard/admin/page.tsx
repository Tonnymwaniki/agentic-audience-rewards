import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { isAdmin } from '@/lib/admin-auth'
import { PRO_PLAN } from '@/lib/billing'
import { AI_MONTHLY_BUDGET_USD } from '@/lib/entitlements'
import PageHeader from '@/components/PageHeader'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Admin · Notice' }

function startOfMonthIso(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatKes(cents: number): string {
  return `KES ${(cents / 100).toLocaleString('en-KE', { maximumFractionDigits: 0 })}`
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <p className="font-mono text-[10px] tracking-widest text-text-muted uppercase">{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold text-text-primary">{value}</p>
      {sub && <p className="mt-1 text-xs text-text-muted">{sub}</p>}
    </div>
  )
}

/**
 * Platform-wide view across every creator — the thing that, until now, only
 * existed as ad hoc SQL queries run by hand in Supabase during this session.
 * Restricted to the ADMIN_EMAILS allowlist (lib/admin-auth.ts), since this
 * bypasses RLS the same way every other admin-style read in this app does
 * (see lib/api-auth.ts's comment on why the service client is used at all).
 *
 * Deliberately NOT a general admin panel with mutation controls — this is a
 * read-only dashboard. Anything that changes state (refunds, plan overrides)
 * still goes through Supabase directly, same as this whole session did, until
 * there's a real need for it to happen more often than that.
 */
export default async function AdminPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')
  if (!(await isAdmin())) redirect('/dashboard/agent')

  const service = createServiceClient()
  const monthStart = startOfMonthIso()

  const [
    { count: totalCreators },
    { count: proCreators },
    { count: activeSubscriptions },
    { data: recentCreators },
    { data: monthlyAiUsage },
    { data: recentTransactions },
    { count: postsAnalyzed },
    { count: commentsIngested },
    { count: repliesSent },
    { count: repliesDrafted },
  ] = await Promise.all([
    service.from('creators').select('id', { count: 'exact', head: true }),
    service.from('creators').select('id', { count: 'exact', head: true }).eq('plan', 'pro'),
    service.from('subscriptions').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    service
      .from('creators')
      .select('id, display_name, channel_url, plan, created_at')
      .order('created_at', { ascending: false })
      .limit(10),
    service.from('ai_usage_events').select('creator_id, cost_usd').gte('created_at', monthStart),
    service
      .from('payhero_transactions')
      .select('id, creator_id, status, amount_cents, external_reference, created_at, creators(display_name, channel_url)')
      .order('created_at', { ascending: false })
      .limit(20),
    service.from('posts').select('id', { count: 'exact', head: true }).eq('analysis_status', 'done'),
    service.from('comments').select('id', { count: 'exact', head: true }),
    service.from('comment_categories').select('comment_id', { count: 'exact', head: true }).eq('reply_send_status', 'sent'),
    service.from('comment_categories').select('comment_id', { count: 'exact', head: true }).not('draft_reply', 'is', null),
  ])

  const freeCreators = (totalCreators ?? 0) - (proCreators ?? 0)
  const mrrCents = (activeSubscriptions ?? 0) * PRO_PLAN.amountKes * 100

  // Aggregated in JS rather than a SQL group-by: ai_usage_events has no view for
  // this yet, and the row count per month is small enough that this is simpler
  // than adding one just for this page.
  const spendByCreator = new Map<string, number>()
  let totalAiSpendUsd = 0
  for (const row of monthlyAiUsage ?? []) {
    const cost = Number(row.cost_usd) || 0
    totalAiSpendUsd += cost
    spendByCreator.set(row.creator_id, (spendByCreator.get(row.creator_id) ?? 0) + cost)
  }
  const topSpenderIds = [...spendByCreator.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)

  const topSpenderCreators =
    topSpenderIds.length > 0
      ? await service
          .from('creators')
          .select('id, display_name, channel_url, plan')
          .in(
            'id',
            topSpenderIds.map(([id]) => id)
          )
      : { data: [] }

  const creatorById = new Map((topSpenderCreators.data ?? []).map(c => [c.id, c]))

  const STATUS_STYLES: Record<string, string> = {
    confirmed: 'text-green',
    pending: 'text-amber-400',
    failed: 'text-avax-red',
    cancelled: 'text-text-muted',
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <PageHeader title="Admin" backHref="/dashboard/agent" backLabel="Agent Home" />

      <section>
        <h2 className="mb-3 font-mono text-[10px] tracking-widest text-text-muted uppercase">
          Business overview
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Total creators" value={String(totalCreators ?? 0)} />
          <StatCard label="Free / Pro" value={`${freeCreators} / ${proCreators ?? 0}`} />
          <StatCard label="Active subscriptions" value={String(activeSubscriptions ?? 0)} />
          <StatCard label="Est. MRR" value={formatKes(mrrCents)} sub={`${activeSubscriptions ?? 0} × KES ${PRO_PLAN.amountKes}`} />
        </div>

        <div className="card mt-3">
          <p className="mb-2 text-xs font-medium text-text-muted">Recent signups</p>
          <ul className="divide-y divide-white/10">
            {(recentCreators ?? []).length === 0 && (
              <li className="py-2 text-sm text-text-muted">No creators yet.</li>
            )}
            {(recentCreators ?? []).map(c => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 truncate text-text-primary">
                  {c.display_name || c.channel_url || c.id}
                </span>
                <span className="flex-shrink-0 text-xs text-text-muted">
                  {c.plan === 'pro' ? 'Pro' : 'Free'} · {formatDate(c.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section>
        <h2 className="mb-3 font-mono text-[10px] tracking-widest text-text-muted uppercase">
          AI spend (this month)
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatCard label="Platform total" value={`$${totalAiSpendUsd.toFixed(2)}`} />
          <StatCard label="Free ceiling / creator" value={`$${AI_MONTHLY_BUDGET_USD.free.toFixed(2)}`} />
          <StatCard label="Pro ceiling / creator" value={`$${AI_MONTHLY_BUDGET_USD.pro.toFixed(2)}`} />
        </div>

        <div className="card mt-3">
          <p className="mb-2 text-xs font-medium text-text-muted">Top spenders</p>
          <ul className="divide-y divide-white/10">
            {topSpenderIds.length === 0 && <li className="py-2 text-sm text-text-muted">No AI spend recorded yet this month.</li>}
            {topSpenderIds.map(([creatorId, cost]) => {
              const creator = creatorById.get(creatorId)
              const ceiling = creator?.plan === 'pro' ? AI_MONTHLY_BUDGET_USD.pro : AI_MONTHLY_BUDGET_USD.free
              return (
                <li key={creatorId} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0 truncate text-text-primary">
                    {creator?.display_name || creator?.channel_url || creatorId}
                  </span>
                  <span className="flex-shrink-0 text-xs text-text-muted">
                    ${cost.toFixed(2)} of ${ceiling.toFixed(2)} ({creator?.plan === 'pro' ? 'Pro' : 'Free'})
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      </section>

      <section>
        <h2 className="mb-3 font-mono text-[10px] tracking-widest text-text-muted uppercase">
          Recent payment activity
        </h2>
        <div className="card">
          <ul className="divide-y divide-white/10">
            {(recentTransactions ?? []).length === 0 && (
              <li className="py-2 text-sm text-text-muted">No payment attempts yet.</li>
            )}
            {(recentTransactions ?? []).map(txn => {
              const creator = txn.creators as unknown as { display_name: string | null; channel_url: string | null } | null
              return (
                <li key={txn.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0 truncate text-text-primary">
                    {creator?.display_name || creator?.channel_url || txn.creator_id}
                  </span>
                  <span className={`flex-shrink-0 text-xs ${STATUS_STYLES[txn.status] ?? 'text-text-muted'}`}>
                    {formatKes(txn.amount_cents)} · {txn.status} · {formatDate(txn.created_at)}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      </section>

      <section>
        <h2 className="mb-3 font-mono text-[10px] tracking-widest text-text-muted uppercase">
          Content &amp; engagement
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Videos analyzed" value={String(postsAnalyzed ?? 0)} />
          <StatCard label="Comments ingested" value={String(commentsIngested ?? 0)} />
          <StatCard label="Replies drafted" value={String(repliesDrafted ?? 0)} />
          <StatCard label="Replies sent" value={String(repliesSent ?? 0)} />
        </div>
      </section>
    </div>
  )
}
