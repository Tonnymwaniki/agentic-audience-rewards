const AVATAR_COLORS = [
  '#0038FF',
  '#FF7FEC',
  '#6366F1',
  '#EC4899',
  '#8B5CF6',
  '#06B6D4',
  '#10B981',
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
      className={`flex items-center justify-center rounded-full font-body font-medium text-white select-none ${className}`}
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
