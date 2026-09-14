import { redirect } from 'next/navigation'
// Service-role, not the anon client: this page is opened by an anonymous
// audience member following a claim link, with no session and therefore no
// creator to scope by. Once RLS is enabled, a creator-scoped policy cannot
// serve this read, and the only policy that could would expose every reward row
// in the database. The unguessable claim_token is the credential here, and it is
// checked below — exactly as /api/reward/mint already does for the write side.
import { createServiceClient } from '@/lib/supabase/service'
import PageHeader from '@/components/PageHeader'
import ClaimWidget from './ClaimWidget'

export default async function ClaimPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const supabase = createServiceClient()
  const { token } = await params

  const { data: rewardEvent, error: rewardError } = await supabase
    .from('reward_events')
    .select(
      `
      id,
      status,
      tx_hash,
      reason,
      audience_members (
        display_name
      )
    `
    )
    .eq('claim_token', token)
    .single()

  if (rewardError || !rewardEvent) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="card max-w-md p-6 text-center">
          <PageHeader title="Invalid Claim Link" />
          <p className="text-text-muted">This claim link is invalid or has expired.</p>
        </div>
      </div>
    )
  }

  const status = rewardEvent.status
  const displayName = (rewardEvent.audience_members as unknown as { display_name: string } | null)?.display_name || 'there'

  if (status === 'minted' || status === 'claimed') {
    const txHash = rewardEvent.tx_hash
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="card max-w-md p-6 text-center">
          <PageHeader title="Already Claimed" />
          <p className="mb-4 text-text-muted">
            You've already claimed this reward!
          </p>
          {txHash && (
            <a
              href={`https://testnet.snowtrace.io/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-avax-red underline hover:text-avax-red/80"
            >
              View on Snowtrace
            </a>
          )}
        </div>
      </div>
    )
  }

  if (status !== 'pending') {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="card max-w-md p-6 text-center">
          <PageHeader title="Claim Unavailable" />
          <p className="text-text-muted">This reward is no longer available for claiming.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="card w-full max-w-md p-6">
        <PageHeader title="Claim Your Reward" />
        <p className="mb-6 text-center text-text-muted">
          Hi {displayName}, you've been recognized for your engagement!
        </p>
        <ClaimWidget
          claimToken={token}
          reason={rewardEvent.reason}
        />
      </div>
    </div>
  )
}
