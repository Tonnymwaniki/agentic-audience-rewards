// Hashed per-person identity colours. Deliberately a wider range than the brand
// palette — these exist to tell people apart at a glance, so they need to stay
// distinguishable from each other rather than all reading as "brand purple". The
// first two now match the theme's purple/pink so the common cases feel on-brand.
const AVATAR_COLORS = [
  '#8B5CF6',
  '#EC4899',
  '#6366F1',
  '#2DD4BF',
  '#A78BFA',
  '#06B6D4',
  '#34D399',
  '#F59E0B',
] as const

function getAvatarColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

function getInitial(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  return trimmed.charAt(0).toUpperCase()
}

type AvatarProps = {
  name: string
  size?: number
  className?: string
}

export default function Avatar({ name, size = 40, className = '' }: AvatarProps) {
  const color = getAvatarColor(name)
  const initial = getInitial(name)

  return (
    <div
      // flex-shrink-0: this is almost always a flex item next to text. Without it
      // a long neighbour squashes the fixed-width circle into an oval.
      className={`flex flex-shrink-0 items-center justify-center rounded-full font-body font-medium text-white select-none ${className}`}
      style={{
        width: size,
        height: size,
        backgroundColor: color,
        fontSize: size * 0.4,
      }}
    >
      {initial}
    </div>
  )
}
