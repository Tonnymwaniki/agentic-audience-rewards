import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import PageHeader from '@/components/PageHeader'
import EvaluateButton from './EvaluateButton'
import CopyLinkButton from './CopyLinkButton'

export default async function RewardsPage({
  searchParams,
}: {
  searchParams: Promise<{ post?: string }>
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: creator, error: creatorError } = await supabase
    .from('creators')
    .select('id')
    .eq('user_id', user.id)
    .single()

  if (creatorError || !creator) {
    redirect('/login')
  }

  const params = await searchParams
  const selectedPostId = params.post || null

  const { data: creatorAudienceMembers, error: audienceError } = await supabase
    .from('audience_members')
    .select('id')
    .eq('creator_id', creator.id)

  if (audienceError) {
    console.error('Audience members fetch error:', JSON.stringify(audienceError, Object.getOwnPropertyNames(audienceError), 2))
    return (
      <div className="p-6">
        <p className="text-red-500">Failed to load audience members</p>
      </div>
    )
  }

  const creatorMemberIds = new Set((creatorAudienceMembers || []).map(m => m.id))

  let rewardEventsQuery = supabase
    .from('reward_events')
    .select(
      `
      id,
      post_id,
      audience_member_id,
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

  if (selectedPostId) {
    rewardEventsQuery = rewardEventsQuery.eq('post_id', selectedPostId)
  }

  const { data: rewardEvents, error: eventsError } = await rewardEventsQuery

  if (eventsError) {
    console.error('Reward events fetch error:', JSON.stringify(eventsError, Object.getOwnPropertyNames(eventsError), 2))
    return (
      <div className="p-6">
        <p className="text-red-500">Failed to load reward events</p>
      </div>
    )
  }

  const formattedEvents = (rewardEvents || [])
    .filter(event => creatorMemberIds.has(event.audience_member_id))
    .map(event => ({
      id: event.id,
      displayName: (event.audience_members as unknown as { display_name: string } | null)?.display_name || 'Unknown',
      reason: event.reason,
      status: event.status,
      createdAt: event.created_at,
      claimToken: event.claim_token,
      txHash: event.tx_hash,
    }))

  return (
    <div>
      <PageHeader title="Rewards" backHref="/dashboard/inbox" backLabel="My Videos" />
      <EvaluateButton creatorId={creator.id} postId={selectedPostId} />

      {formattedEvents.length === 0 ? (
        <p className="text-text-muted">No reward events yet. Run an evaluation to find eligible audience members.</p>
      ) : (
        <ul className="space-y-3">
          {formattedEvents.map(event => (
            <li key={event.id} className="card">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <p className="font-body font-medium text-sm text-text-primary">{event.displayName}</p>
                  <p className="mt-1 text-sm text-text-muted">
                    <span className="highlight">{event.reason}</span>
                  </p>
                  <p className="mt-1 text-xs text-text-muted">
                    {new Date(event.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <span className="inline-flex rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800">
                    {event.status}
                  </span>
                  <CopyLinkButton claimToken={event.claimToken} status={event.status} txHash={event.txHash} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
