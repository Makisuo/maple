export function GlowFilter({
  id,
  stdDeviation = 3.5,
}: {
  id: string
  stdDeviation?: number
}) {
  return (
    <filter id={id} x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur in="SourceGraphic" stdDeviation={stdDeviation} result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>
  )
}

export function RainbowGradient({ id }: { id: string }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stopColor="#ff0000" />
      <stop offset="20%" stopColor="#ff8800" />
      <stop offset="40%" stopColor="#ffff00" />
      <stop offset="60%" stopColor="#00ff00" />
      <stop offset="80%" stopColor="#0088ff" />
      <stop offset="100%" stopColor="#8800ff" />
    </linearGradient>
  )
}
