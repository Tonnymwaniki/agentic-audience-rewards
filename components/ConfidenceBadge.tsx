import { normalizeConfidence } from '@/lib/confidence'

/**
 * How sure the agent was, shown so the creator's eye lands on the shaky calls first.
 *
 * The visual weighting is deliberately inverted from the usual instinct: HIGH is the
 * quietest badge and LOW is the loudest. A page of confident decisions should look
 * calm, with the handful worth checking standing out — if every badge shouted, none
 * would. Nothing renders at all when confidence was never recorded, so rows written
 * before this existed stay unlabelled rather than being guessed at.
 */
const STYLES: Record<string, { className: string; label: string }> = {
  high: {
    className: 'border-white/10 bg-surface-hover text-text-muted',
    label: 'High confidence',
  },
  medium: {
    className: 'border-gold/30 bg-gold-dim text-gold-light',
    label: 'Medium confidence',
  },
  low: {
    className: 'border-avax-red/40 bg-avax-red/15 text-avax-red',
    label: 'Low confidence — worth double-checking',
  },
}

export default function ConfidenceBadge({
  confidence,
  className = '',
}: {
  confidence: string | null | undefined
  className?: string
}) {
  const level = normalizeConfidence(confidence)
  if (!level) return null

  const style = STYLES[level]

  return (
    <span
      className={`inline-flex flex-shrink-0 items-center rounded-full border px-2 py-0.5 font-mono text-[10px] tracking-wide uppercase ${style.className} ${className}`}
      title={style.label}
    >
      {level === 'low' && (
        <span aria-hidden="true" className="mr-1">
          ▲
        </span>
      )}
      {style.label}
    </span>
  )
}
