export function DottedPattern({
  id,
  size = 4,
  opacity = 0.3,
}: {
  id: string
  size?: number
  opacity?: number
}) {
  return (
    <pattern id={id} width={size} height={size} patternUnits="userSpaceOnUse">
      <circle cx={size / 2} cy={size / 2} r={0.5} fill="currentColor" opacity={opacity} />
    </pattern>
  )
}

export function HatchedPattern({
  id,
  angle = -45,
}: {
  id: string
  angle?: number
}) {
  return (
    <pattern
      id={id}
      width={4}
      height={4}
      patternUnits="userSpaceOnUse"
      patternTransform={`rotate(${angle})`}
    >
      <line x1={0} y1={0} x2={0} y2={4} stroke="currentColor" strokeWidth={1} opacity={0.5} />
    </pattern>
  )
}

export function BarPattern({ id }: { id: string }) {
  return (
    <pattern
      id={id}
      width={6}
      height={6}
      patternUnits="userSpaceOnUse"
      patternTransform="rotate(-45)"
    >
      <rect width={2} height={6} fill="currentColor" opacity={0.4} />
    </pattern>
  )
}

export function VerticalGradient({
  id,
  color,
  startOpacity = 0.8,
  endOpacity = 0.1,
}: {
  id: string
  color: string
  startOpacity?: number
  endOpacity?: number
}) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="5%" stopColor={color} stopOpacity={startOpacity} />
      <stop offset="95%" stopColor={color} stopOpacity={endOpacity} />
    </linearGradient>
  )
}
