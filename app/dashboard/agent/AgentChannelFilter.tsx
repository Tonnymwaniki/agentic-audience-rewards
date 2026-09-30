'use client'

import { useRouter, useSearchParams } from 'next/navigation'

type Channel = { channelId: string; title: string | null; verified: boolean }

/**
 * Lets a creator pick which one of their analyzed channels Agent Home's stats are
 * built from — their own channel, or one they've researched — instead of every
 * number on the page silently blending all of them together. Only rendered by
 * page.tsx when there's actually more than one channel to choose between.
 */
export default function AgentChannelFilter({
  channels,
  selectedChannelId,
}: {
  channels: Channel[]
  selectedChannelId: string | null
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  function handleChange(value: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (value === 'all') {
      params.set('channel', 'all')
    } else {
      params.set('channel', value)
    }
    router.push(`/dashboard/agent?${params.toString()}`)
  }

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="agent-channel-filter" className="text-xs text-text-muted">
        Showing
      </label>
      <select
        id="agent-channel-filter"
        value={selectedChannelId ?? 'all'}
        onChange={e => handleChange(e.target.value)}
        className="min-h-9 rounded-lg border border-white/10 bg-surface px-2 text-xs text-text-primary"
      >
        <option value="all">All channels (mixed)</option>
        {channels.map(c => (
          <option key={c.channelId} value={c.channelId}>
            {(c.title || 'Untitled channel') + (c.verified ? ' (yours)' : '')}
          </option>
        ))}
      </select>
    </div>
  )
}
