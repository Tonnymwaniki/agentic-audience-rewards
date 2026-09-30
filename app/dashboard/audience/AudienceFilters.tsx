'use client'

import { useRouter, useSearchParams } from 'next/navigation'

type Channel = { channelId: string; title: string | null }

const SEGMENT_OPTIONS = [
  { value: 'potential_customer', label: 'Potential customers' },
  { value: 'critic', label: 'Critics' },
  { value: 'loyal_fan', label: 'Loyal fans' },
  { value: 'content_requester', label: 'Content requesters' },
  { value: 'casual_viewer', label: 'Casual viewers' },
]
const LEVEL_OPTIONS = [
  { value: 'super_fan', label: 'Super fans' },
  { value: 'rising_fan', label: 'Rising fans' },
  { value: 'regular', label: 'Regular' },
  { value: 'new', label: 'New' },
]

/** Three independent filters for the Audience directory, each just a URL param —
 *  so the list stays a plain server-rendered page and a shared link keeps its filters. */
export default function AudienceFilters({ channels }: { channels: Channel[] }) {
  const router = useRouter()
  const searchParams = useSearchParams()

  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (value === 'all') params.delete(key)
    else params.set(key, value)
    router.push(`/dashboard/audience?${params.toString()}`)
  }

  const selectClass = 'min-h-9 rounded-lg border border-white/10 bg-surface px-2 text-xs text-text-primary'

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {channels.length > 1 && (
        <select
          value={searchParams.get('channel') ?? 'all'}
          onChange={e => setParam('channel', e.target.value)}
          className={selectClass}
        >
          <option value="all">All channels</option>
          {channels.map(c => (
            <option key={c.channelId} value={c.channelId}>
              {c.title || 'Untitled channel'}
            </option>
          ))}
        </select>
      )}
      <select value={searchParams.get('segment') ?? 'all'} onChange={e => setParam('segment', e.target.value)} className={selectClass}>
        <option value="all">Any segment</option>
        {SEGMENT_OPTIONS.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <select value={searchParams.get('level') ?? 'all'} onChange={e => setParam('level', e.target.value)} className={selectClass}>
        <option value="all">Any level</option>
        {LEVEL_OPTIONS.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}
