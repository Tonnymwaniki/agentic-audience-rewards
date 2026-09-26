import { createServiceClient } from '@/lib/supabase/service'
import Avatar from '@/components/Avatar'
import PageHeader from '@/components/PageHeader'
import { logError } from '@/lib/logger'
import { VOIDED_UNVERIFIED_STATUS } from '@/lib/rewards/status'

/**
 * Masks a commenter's identity for this PUBLIC page.
 *
 * Everyone listed here is a real YouTube commenter who was recognized by an agent
 * — not someone who signed up, and (every row currently reads "Awaiting claim") not
 * someone who has taken any action implying they want to be listed. The praise is
 * worth showing; naming the person is not ours to do. The creator still sees full
 * handles on the authenticated Rewards page, which is where identity is needed.
 *
 * Keeps the first character so the avatar stays varied and the cards remain
 * visually distinguishable, and uses a FIXED-LENGTH mask so the handle's length —
 * itself a matching signal — is not published either.
 */
function maskIdentity(displayName: string | null): string {
  const cleaned = (displayName ?? '').replace(/^@+/, '').trim()
  const initial = cleaned.charAt(0)
  if (!initial || !/[a-z0-9]/i.test(initial)) return 'A viewer'
  return `${initial.toUpperCase()}•••••`
}

/**
 * Removes quoted fragments of someone's own comment from the reason text.
 *
 * Republishing a person's words back at them is the same identification problem as
 * the handle: a distinctive phrase is searchable, and search leads straight back to
 * the comment and the account. The agent quotes evidence deliberately and that
 * evidence stays in the database and on the creator's own Rewards page — this
 * strips it only from the public rendering.
 *
 * A quote inside parentheses takes the parentheses with it; removing just the
 * quoted words would leave "praise ( reflects the creator's messaging)". Apostrophes
 * in contractions are untouched, because an opening delimiter is only recognised
 * after a space or an opening bracket — "creator's" and "doesn't" have a letter
 * before the apostrophe and so are never treated as quotes.
 */
function stripQuotedFragments(text: string): string {
  const withoutParentheticals = text.replace(
    /\s*\(([^()]*)\)/g,
    (whole, inner: string) => (/["'“”‘’]/.test(inner) ? '' : whole)
  )

  const withoutQuotes = withoutParentheticals
    .replace(/["“][^"”]*["”]/g, '')
    .replace(/(^|[\s([])['‘]([^'’]+)['’](?=[\s).,;:!?\]]|$)/g, '$1')

  return withoutQuotes
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:]){2,}/g, '$1')
    .replace(/,\s*\./g, '.')
    .trim()
}

function relativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  if (diffSec < 60) return 'just now'
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`
  if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? '' : 's'} ago`
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`
  return date.toLocaleDateString()
}

/**
 * `audience_members` is a TO-ONE embed, so PostgREST returns an OBJECT here, not
 * an array. The row type is spelled out because the untyped client infers the
 * embed as an array, which is what produced the bug this type replaces: the page
 * filtered on `audience_members.length > 0`, and `undefined > 0` is false for
 * every row, so every reward event was discarded and the page permanently showed
 * "No one has been recognized yet" while 50 events sat in the database.
 */
type RecognizedRow = {
  id: string
  reason: string
  status: string
  tx_hash: string | null
  created_at: string
  audience_members: { display_name: string | null } | null
}

export default async function RecognizedPage() {
  const supabase = createServiceClient()

  // claim_token is deliberately NOT selected. This page is public and
  // unauthenticated, and a claim token is a bearer secret — whoever holds it can
  // redeem someone else's reward. It was previously fetched and carried into the
  // page's props while no JSX ever rendered it, which is a leak waiting for the
  // first person to add a debug line or a serialised prop. Claiming happens at
  // /claim/[token], where the token comes from the URL, and creators distribute
  // that link from the authenticated Rewards page — nothing here needs it.
  const { data: rewardEvents, error } = await supabase
    .from('reward_events')
    .select(
      `
      id,
      reason,
      status,
      tx_hash,
      created_at,
      audience_members (
        display_name
      )
    `
    )
    // A voided reward was never valid (issued on a channel its creator had not
    // proven they own) and would otherwise render as "Awaiting claim" forever.
    .neq('status', VOIDED_UNVERIFIED_STATUS)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) {
    logError('page.recognized', error, { stage: 'fetch' })
  }

  const events = ((rewardEvents ?? []) as unknown as RecognizedRow[])
    .filter(event => Boolean(event.audience_members))
    .map(event => ({
      id: event.id,
      // Masked here, at the point the row becomes page data, so the real handle and
      // the quoted evidence never reach the props that get serialised into the HTML.
      displayName: maskIdentity(event.audience_members?.display_name ?? null),
      reason: stripQuotedFragments(event.reason ?? ''),
      status: event.status,
      createdAt: event.created_at,
      txHash: event.tx_hash,
    }))
    // A reason that was mostly quotation can be left too thin to stand as proof.
    .filter(event => event.reason.length >= 40)

  return (
    <div className="mx-auto max-w-5xl px-6 py-16">
      <PageHeader title="Recognized by Notice" />

      {events.length === 0 ? (
        <div className="card p-12 text-center">
          <p className="text-sm text-text-muted">No one has been recognized yet. Be the first.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {events.map(event => {
            const isClaimed = event.status === 'minted' || event.status === 'claimed'

            return (
              <div key={event.id} className="card">
                <div className="flex items-start gap-4">
                  <Avatar name={event.displayName} size={40} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-body font-medium text-sm text-text-primary truncate">
                        {event.displayName}
                      </p>
                      <span className={`text-xs font-medium ${isClaimed ? 'text-pink' : 'text-text-muted'}`}>
                        {isClaimed ? 'Claimed ✓' : 'Awaiting claim'}
                      </span>
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-text-primary">
                      <span className="highlight">{event.reason}</span>
                    </p>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="text-xs text-text-muted">{relativeTime(event.createdAt)}</span>
                      {isClaimed && event.txHash && (
                        <a
                          href={`https://testnet.snowtrace.io/tx/${event.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-avax-red underline hover:text-avax-red/80"
                        >
                          View on Snowtrace
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
