import { createServiceClient } from '@/lib/supabase/service'
import Link from 'next/link'

async function getStats() {
  const supabase = createServiceClient()

  const [commentsResult, eventsResult] = await Promise.all([
    supabase.from('comments').select('id', { count: 'exact', head: true }),
    supabase.from('reward_events').select('audience_member_id', { count: 'exact', head: true }),
  ])

  if (commentsResult.error) {
    console.log("LIVE PROOF QUERY ERROR:", JSON.stringify(commentsResult.error, Object.getOwnPropertyNames(commentsResult.error), 2))
  }
  if (eventsResult.error) {
    console.log("LIVE PROOF QUERY ERROR:", JSON.stringify(eventsResult.error, Object.getOwnPropertyNames(eventsResult.error), 2))
  }

  console.log("Querying table: comment_categories")

  const { count: categoriesCount, error: categoriesError } = await supabase
    .from('comment_categories')
    .select('comment_id', { count: 'exact', head: true })

  if (categoriesError) {
    console.log("CATEGORIES COUNT ERROR FULL:", JSON.stringify(categoriesError, Object.getOwnPropertyNames(categoriesError), 2))
  }
  console.log("CATEGORIES COUNT RESULT:", categoriesCount)

  console.log("LIVE PROOF RAW RESULTS:", {
    comments: commentsResult.count,
    categories: categoriesCount,
    events: eventsResult.count,
  })

  let uniqueRecognized = eventsResult.count || 0
  if (eventsResult.count && eventsResult.count > 0) {
    const { data: eventMembers, error: eventMembersError } = await supabase
      .from('reward_events')
      .select('audience_member_id')

    if (eventMembersError) {
      console.log("PEOPLE RECOGNIZED ERROR:", JSON.stringify(eventMembersError, Object.getOwnPropertyNames(eventMembersError), 2))
    }
    console.log("PEOPLE RECOGNIZED RESULT:", eventMembers ? new Set(eventMembers.map(e => e.audience_member_id)).size : 'no data')

    if (eventMembers) {
      uniqueRecognized = new Set(eventMembers.map(e => e.audience_member_id)).size
    }
  }

  return {
    comments: commentsResult.count || 0,
    categories: categoriesCount || 0,
    events: uniqueRecognized,
  }
}

async function getRecentRewards() {
  const supabase = createServiceClient()

  const { data: mintedEvents, error: mintedError } = await supabase
    .from('reward_events')
    .select('id, reason, audience_member_id, audience_members (display_name)')
    .eq('status', 'minted')
    .order('created_at', { ascending: false })
    .limit(3)

  if (mintedError) {
    console.log("RECENT REWARDS ERROR:", JSON.stringify(mintedError, Object.getOwnPropertyNames(mintedError), 2))
  }

  const events = mintedEvents || []

  if (events.length < 3) {
    const { data: pendingEvents } = await supabase
      .from('reward_events')
      .select('id, reason, audience_member_id, audience_members (display_name)')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(3 - events.length)

    if (pendingEvents) {
      events.push(...pendingEvents)
    }
  }

  return events.map(event => ({
    display_name: (event.audience_members as unknown as { display_name: string } | null)?.display_name || 'Someone',
    reason: event.reason || '',
  }))
}

function AnimatedMockup() {
  return (
    <div className="mt-12 space-y-3">
      {[
        { text: 'Bring back Punchline monthly 🔥', category: 'purchase_intent', delay: '0s' },
        { text: 'Hii kitu ni noma 😂🔥', category: 'praise', delay: '0.4s' },
        { text: 'Can you explain the pricing model?', category: 'question', delay: '0.8s' },
      ].map((item, i) => (
        <div
          key={i}
          className="animate-fade-in-up card flex items-center justify-between gap-4"
          style={{ animationDelay: item.delay }}
        >
          <p className="text-sm text-text-primary">"{item.text}"</p>
          <span className={`badge badge-${item.category} highlight-sweep`}>
            {item.category.replace('_', ' ')}
          </span>
        </div>
      ))}
    </div>
  )
}

export default async function HomePage() {
  const stats = await getStats()
  const recentRewards = await getRecentRewards()

  return (
    <div className="flex flex-col">
      {/* HERO */}
      <section className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-24">
        <div className="mx-auto max-w-3xl text-center">
          <p className="font-mono text-xs uppercase tracking-widest text-text-muted">
            Audience Intelligence · On-Chain
          </p>
          <h1 className="mt-6 font-display text-5xl font-semibold leading-tight text-text-primary md:text-7xl">
            Your audience is already telling you what they want.
          </h1>
          <p className="mt-6 font-body text-lg text-text-muted md:text-xl">
            Notice reads every comment, understands what matters, and rewards the people who do — automatically, on-chain.
          </p>
          <div className="mt-10">
            <Link href="/login" className="btn-primary inline-flex items-center justify-center px-8 py-3 text-base">
              See It In Action
            </Link>
          </div>
          <AnimatedMockup />
        </div>
      </section>

      {/* THE PROBLEM */}
      <section className="bg-surface px-6 py-20">
        <div className="mx-auto max-w-2xl text-center">
          <p className="font-body text-lg text-text-muted md:text-xl">
            Creators get thousands of comments. The real signal — who wants what, who deserves recognition — is buried and impossible to find by hand.
          </p>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="bg-background px-6 py-24">
        <div className="mx-auto max-w-5xl">
          <div className="grid grid-cols-1 gap-8 md:grid-cols-4">
            {[
              { num: '01', label: 'Connect', desc: 'Paste your channel link, pick a video' },
              { num: '02', label: 'Understood', desc: 'AI reads it — category, topic, language, sentiment, code-switching included' },
              { num: '03', label: 'Noticed', desc: 'The agent decides, on its own, who genuinely engaged', highlight: true },
              { num: '04', label: 'Rewarded', desc: 'A Proof of Engagement token is minted to them on Avalanche', highlight: true },
            ].map((step) => (
              <div key={step.num} className="card text-center">
                <span className="font-mono text-xs text-text-muted">{step.num}</span>
                <h3 className={`mt-2 font-display text-lg font-semibold ${step.highlight ? 'text-pink' : 'text-text-primary'}`}>
                  {step.label}
                </h3>
                <p className="mt-2 text-sm text-text-muted">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* BEYOND READING — ACTING */}
      <section className="bg-surface px-6 py-24">
        <div className="mx-auto max-w-3xl">
          <h2 className="font-display text-3xl font-semibold text-text-primary md:text-4xl text-center">
            Notice doesn&apos;t just read. It helps you act.
          </h2>
          <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="card">
              <p className="font-mono text-xs text-text-muted">01</p>
              <h3 className="mt-2 font-display text-lg font-semibold text-text-primary">Catch what&apos;s trending</h3>
              <p className="mt-2 text-sm text-text-muted">
                When multiple people say the same thing, Notice flags it — whether it&apos;s a real request or spam.
              </p>
            </div>
            <div className="card">
              <p className="font-mono text-xs text-text-muted">02</p>
              <h3 className="mt-2 font-display text-lg font-semibold text-text-primary">Never miss a lead</h3>
              <p className="mt-2 text-sm text-text-muted">
                Business inquiries and purchase intent get a drafted reply ready to send — you just approve.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* LIVE PROOF */}
      <section className="bg-surface px-6 py-24">
        <div className="mx-auto max-w-4xl">
          <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
            {[
              { value: stats.comments, label: 'COMMENTS UNDERSTOOD' },
              { value: stats.categories, label: 'CATEGORIES ASSIGNED' },
              { value: stats.events, label: 'PEOPLE RECOGNIZED' },
            ].map((stat) => (
              <div key={stat.label} className="text-center">
                <p className="font-display text-5xl font-semibold text-cobalt md:text-6xl">
                  {stat.value.toLocaleString()}
                </p>
                <p className="mt-2 font-mono text-xs text-text-muted">{stat.label}</p>
              </div>
            ))}
          </div>
          <p className="mt-10 text-center text-sm text-text-muted">
            Every reward is verifiable on Avalanche Fuji.
          </p>

          {recentRewards.length > 0 && (
            <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
              {recentRewards.map((reward, i) => (
                <div key={i} className="card">
                  <p className="font-body font-medium text-sm text-text-primary">{reward.display_name}</p>
                  <p className="mt-1 text-xs text-text-muted">
                    {reward.reason.length > 80 ? `${reward.reason.slice(0, 80)}...` : reward.reason}
                  </p>
                </div>
              ))}
            </div>
          )}

          <p className="mt-8 text-center">
            <Link href="/recognized" className="text-sm text-cobalt underline hover:text-cobalt-hover">
              See everyone recognized →
            </Link>
          </p>
        </div>
      </section>

      {/* BUILT FOR REAL AUDIENCES */}
      <section className="bg-background px-6 py-24">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="font-display text-3xl font-semibold text-text-primary md:text-4xl">
            Built for real audiences
          </h2>
          <p className="mt-6 font-body text-lg text-text-muted">
            Most tools choke on <span className="highlight">Hii kitu ni noma 😂🔥</span>. Notice understands it.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            {['Hii kitu ni noma 😂🔥', 'Mambo vipi?', 'Niko bored, suggest something'].map((text) => (
              <span key={text} className="font-mono text-xs text-text-muted">
                &ldquo;{text}&rdquo;
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="bg-surface px-6 py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-display text-3xl font-semibold text-text-primary md:text-4xl">
            Ready to see what your audience is telling you?
          </h2>
          <div className="mt-8">
            <Link href="/login" className="btn-primary inline-flex items-center justify-center px-8 py-3 text-base">
              Get Started
            </Link>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="bg-background px-6 py-12">
        <div className="mx-auto max-w-5xl flex flex-col items-center justify-between gap-4 md:flex-row">
          <p className="font-mono text-xs text-text-muted">
            Built for Team1 Kenya <span className="text-avax-red">×</span> Avalanche
          </p>
          <a
            href="https://github.com"
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-xs text-text-muted underline hover:text-text-primary"
          >
            GitHub
          </a>
        </div>
      </footer>
    </div>
  )
}
