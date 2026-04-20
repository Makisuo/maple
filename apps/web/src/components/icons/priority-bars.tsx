import type { IconProps } from "./icon"

export type PriorityLevel = 0 | 1 | 2 | 3 | 4

export const PRIORITY_LABEL: Record<PriorityLevel, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
}

interface PriorityBarsIconProps extends IconProps {
  level: PriorityLevel
}

function PriorityBarsIcon({
  level,
  size = 16,
  className,
  ...props
}: PriorityBarsIconProps) {
  const label = PRIORITY_LABEL[level]

  if (level === 0) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 16 16"
        width={size}
        height={size}
        className={className}
        fill="none"
        role="img"
        aria-label={label}
        {...props}
      >
        <circle cx="3" cy="8" r="1" fill="currentColor" opacity="0.55" />
        <circle cx="8" cy="8" r="1" fill="currentColor" opacity="0.55" />
        <circle cx="13" cy="8" r="1" fill="currentColor" opacity="0.55" />
      </svg>
    )
  }

  if (level === 1) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 16 16"
        width={size}
        height={size}
        className={className}
        fill="none"
        role="img"
        aria-label={label}
        {...props}
      >
        <rect
          x="1.5"
          y="1.5"
          width="13"
          height="13"
          rx="3"
          fill="oklch(0.70 0.18 55)"
        />
        <rect x="7.25" y="4" width="1.5" height="5" rx="0.4" fill="white" />
        <rect x="7.25" y="10.5" width="1.5" height="1.5" rx="0.4" fill="white" />
      </svg>
    )
  }

  const filled = level === 2 ? 3 : level === 3 ? 2 : 1
  const bars = [
    { x: 2, h: 4 },
    { x: 6, h: 7 },
    { x: 10, h: 10 },
  ]

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={className}
      fill="none"
      role="img"
      aria-label={label}
      {...props}
    >
      {bars.map((bar, i) => (
        <rect
          key={i}
          x={bar.x}
          y={14 - bar.h}
          width="3"
          height={bar.h}
          rx="0.6"
          fill="currentColor"
          opacity={i < filled ? 1 : 0.2}
        />
      ))}
    </svg>
  )
}

export { PriorityBarsIcon }
