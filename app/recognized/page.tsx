import { createServiceClient } from '@/lib/supabase/service'
import Avatar from '@/components/Avatar'
import PageHeader from '@/components/PageHeader'

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

export default async function RecognizedPage() {
  const supabase = createServiceClient()

  const { data: rewardEvents, error } = await supabase
    .from('reward_events')
    .select(
      `
      id,
      reason,
      status,
      claim_token,
      tx_hash,
      created_at,
      audience_members (
        display_name
      )
    `
    )
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) {
    console.error('Recognized page fetch error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
  }

  const events = (rewardEvents || [])
    .filter(event => event.audience_members)
    .map(event => {
      const rawStatus = event.status
      const displayName = (event.audience_members as { display_name: string } | null)?.display_name || 'Unknown'
      if (displayName === '@draxisskjoung6772' || displayName.toLowerCase().includes('draxisskjoung6772')) {
        console.log('RECOGNIZED PAGE DEBUG for draxisskjoung6772:', {
          rawStatus,
          tx_hash: event.tx_hash,
          claim_token: event.claim_token,
          created_at: event.created_at,
        })
      }
      return {
        id: event.id,
        displayName,
        reason: event.reason,
        status: rawStatus,
        createdAt: event.created_at,
        claimToken: event.claim_token,
        txHash: event.tx_hash,
      }
    })

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
