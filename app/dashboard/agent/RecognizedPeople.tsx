import Avatar from '@/components/Avatar'
import { LEVEL_LABELS, LEVEL_RULES, type AudienceLevel } from '@/lib/levels'

// No 'use client': pure markup, so this ships no JavaScript.

export type RecognizedPerson = {
  id: string
  name: string
  /** Null for a member who predates the levels migration or has not been computed yet. */
  level: AudienceLevel | null
  reason: string
  at: string | null
}

/**
 * Per-tier styling. The visual weight climbs with the tier deliberately: a Super
 * Fan badge should be findable in a glance down the row without reading a word,
 * so it gets the gold gradient and a glow while New is a plain hairline outline.
 */
const LEVEL_BADGE: Record<AudienceLevel, string> = {
  super_fan:
    'gradient-gold text-[#2b1c00] shadow-[0_0_14px_-2px_rgba(251,191,36,0.65)] font-semibold',
  rising_fan: 'bg-purple/25 text-purple-text border border-purple/40 font-medium',
  regular: 'bg-white/10 text-text-muted border border-white/10',
  new: 'text-text-muted/80 border border-white/10',
}

function timeAgo(dateString: string): string {
  const diffMs = Date.now() - new Date(dateString).getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHour < 24) return `${diffHour}h ago`
  return `${diffDay}d ago`
}

function LevelBadge({ level }: { level: AudienceLevel | null }) {
  // An uncomputed level is left blank rather than defaulted to "New" — calling a
  // long-standing member a newcomer because a backfill hasn't run is a worse
  // error than showing nothing.
  if (!level) return null

  return (
    <span
      title={LEVEL_RULES[level]}
      className={`flex-shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] tracking-wide uppercase ${LEVEL_BADGE[level]}`}
    >
      {LEVEL_LABELS[level]}
    </span>
  )
}

export default function RecognizedPeople({ people }: { people: RecognizedPerson[] }) {
  if (people.length === 0) return null

  return (
    <div className="mb-4">
      <p className="mb-2 font-mono text-[10px] tracking-widest text-text-muted uppercase">
        Recognized this week
      </p>

      <ul className="space-y-2">
        {people.map(person => (
          <li
            key={person.id}
            className="flex items-start gap-3 rounded-xl border border-white/10 bg-surface-hover p-3"
          >
            <Avatar name={person.name} size={32} />

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-body text-sm font-medium text-text-primary">{person.name}</span>
                <LevelBadge level={person.level} />
                {person.at && (
                  <span className="text-xs text-text-muted">{timeAgo(person.at)}</span>
                )}
              </div>
              {/* The reason is the creator's own words from the reward event, so it
                  is shown in full rather than truncated to a fixed character count. */}
              <p className="mt-1 text-xs leading-snug text-text-muted">{person.reason}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
