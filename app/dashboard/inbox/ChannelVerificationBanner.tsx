import type { ChannelSummary } from '@/lib/channel-verification'
import { UNKNOWN_CHANNEL_ID, VERIFY_OWNERSHIP_PATH } from '@/lib/channel-verification'

/**
 * Per-channel ownership status for everything this creator has analyzed.
 *
 * Deliberately not a blocking banner. Reading is open, so a creator analyzing
 * someone else's channel is doing something legitimate and should not be nagged as
 * if they had done wrong — the copy states which capabilities are unlocked, not
 * that anything is broken.
 *
 * It renders nothing when there is one channel and it is verified: at that point
 * the status is "everything works", and a banner saying so is just noise.
 */
export default function ChannelVerificationBanner({ channels }: { channels: ChannelSummary[] }) {
  if (channels.length === 0) return null

  const unverified = channels.filter(c => !c.verified)
  if (unverified.length === 0 && channels.length === 1) return null

  return (
    <section
      aria-labelledby="channel-verification"
      className="mb-4 rounded-xl border border-white/10 bg-surface p-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2
          id="channel-verification"
          className="font-mono text-[10px] tracking-widest text-text-muted uppercase"
        >
          Channel ownership
        </h2>
        {unverified.length > 0 && (
          <a
            href={VERIFY_OWNERSHIP_PATH}
            className="flex-shrink-0 text-xs font-medium text-purple-text underline hover:text-text-primary"
          >
            Verify ownership
          </a>
        )}
      </div>

      <ul className="mt-3 space-y-2">
        {channels.map(channel => (
          <li key={channel.channelId} className="flex items-start gap-2.5">
            <span
              aria-hidden="true"
              className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${
                channel.verified ? 'bg-green' : 'bg-text-muted/50'
              }`}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm leading-snug text-text-primary">
                {/* break-all: a raw channel id is one unbreakable token. */}
                <span className={channel.title ? '' : 'font-mono text-xs break-all'}>
                  {channel.channelId === UNKNOWN_CHANNEL_ID
                    ? 'Channel not identified'
                    : (channel.title ?? channel.channelId)}
                </span>{' '}
                <span className="text-xs text-text-muted">
                  · {channel.postCount} {channel.postCount === 1 ? 'video' : 'videos'}
                </span>
              </p>
              <p className="mt-0.5 text-xs leading-snug text-text-muted">
                {channel.verified ? (
                  <span className="text-green">Verified — replies and rewards enabled</span>
                ) : (
                  'Analysis and research work. Drafted replies and rewards need verified ownership.'
                )}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
