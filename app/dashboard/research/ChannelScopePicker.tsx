'use client'

import { useEffect, useState } from 'react'
import { useResearchChat } from './ResearchChatContext'

type Channel = { channelId: string; title: string | null; postCount: number; verified: boolean }

/**
 * Lets a creator choose which channel a NEW Research conversation answers from —
 * their own channel, or one they've researched — instead of every answer silently
 * blending every channel they've ever analyzed into one pool. Renders nothing once
 * a conversation has actually started (its scope is then fixed; see
 * ResearchChatContext's setChannelId) or when there's nothing to choose between.
 */
export default function ChannelScopePicker({ className = '' }: { className?: string }) {
  const { channelId, setChannelId, hasMessages } = useResearchChat()
  const [channels, setChannels] = useState<Channel[] | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/creator/channels')
      .then(res => res.json())
      .then(data => {
        if (!cancelled) setChannels(Array.isArray(data.channels) ? data.channels : [])
      })
      .catch(() => {
        if (!cancelled) setChannels([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Nothing to narrow down: one channel (or none) means "all channels" already
  // means exactly one thing.
  if (!channels || channels.length < 2) return null

  if (hasMessages) {
    if (!channelId) return null
    const scoped = channels.find(c => c.channelId === channelId)
    return (
      <p className={`text-xs text-text-muted ${className}`}>
        Scoped to <span className="text-text-primary">{scoped?.title ?? 'one channel'}</span>
      </p>
    )
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <label htmlFor="research-channel-scope" className="text-xs text-text-muted">
        Ask about
      </label>
      <select
        id="research-channel-scope"
        value={channelId ?? 'all'}
        onChange={e => setChannelId(e.target.value === 'all' ? null : e.target.value)}
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
