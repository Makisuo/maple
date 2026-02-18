import { memo, useId } from "react"
import { getBezierPath, type EdgeProps } from "@xyflow/react"
import type { ServiceEdgeData } from "./service-map-utils"

function getEdgeColor(errorRate: number): string {
  if (errorRate > 5) return "oklch(0.6 0.2 25)" // red
  if (errorRate > 1) return "oklch(0.7 0.15 85)" // amber
  return "oklch(0.6 0.12 160)" // green/teal
}

function getStrokeWidth(callCount: number): number {
  if (callCount <= 0) return 2
  // Log scale from 2 to 8px
  return Math.min(8, Math.max(2, 2 + Math.log10(callCount) * 2))
}

const TRAVERSE_TIME = 2 // seconds, fixed visual crossing speed
const MAX_DUR = 20 // cap for very low rates (prevents near-invisible motion)
const MAX_PARTICLES = 8

function simpleHash(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0
  }
  return (Math.abs(h) % 1000) / 1000
}

function formatCallCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return String(count)
}

export const ServiceMapEdge = memo(function ServiceMapEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const uniqueId = useId()
  const edgeData = data as ServiceEdgeData | undefined

  const callCount = edgeData?.callCount ?? 0
  const callsPerSecond = edgeData?.callsPerSecond ?? 0
  const errorRate = edgeData?.errorRate ?? 0

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })

  const color = getEdgeColor(errorRate)
  const strokeWidth = getStrokeWidth(callCount)
  // Rate-matching: arrival_rate = particleCount / duration ≈ callsPerSecond
  const rate = Math.max(callsPerSecond, 0)
  let particleCount: number
  let traversalDuration: number

  if (rate <= 0) {
    particleCount = 0
    traversalDuration = TRAVERSE_TIME
  } else {
    const interArrival = 1 / rate

    if (interArrival > TRAVERSE_TIME) {
      // Low throughput: 1 particle, longer cycle
      particleCount = 1
      traversalDuration = Math.min(interArrival, MAX_DUR)
    } else {
      // High throughput: multiple particles, fixed cycle
      traversalDuration = TRAVERSE_TIME
      particleCount = Math.min(MAX_PARTICLES, Math.max(1, Math.round(rate * TRAVERSE_TIME)))
    }
  }

  const stagger = traversalDuration / particleCount
  const edgeOffset = simpleHash(id) * stagger

  const pathId = `path-${id}-${uniqueId}`

  return (
    <>
      {/* Base path */}
      <path
        id={pathId}
        d={edgePath}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeOpacity={0.5}
        className="react-flow__edge-path"
      />

      {/* Animated particles */}
      {Array.from({ length: particleCount }).map((_, i) => (
        <circle
          key={i}
          r={Math.max(2, strokeWidth * 0.6)}
          fill={color}
          opacity={0.9}
        >
          <animateMotion
            dur={`${traversalDuration}s`}
            repeatCount="indefinite"
            begin={`${edgeOffset + i * stagger}s`}
          >
            <mpath href={`#${pathId}`} />
          </animateMotion>
        </circle>
      ))}

      {/* Label */}
      <foreignObject
        x={labelX - 40}
        y={labelY - 12}
        width={80}
        height={24}
        className="overflow-visible pointer-events-none"
      >
        <div className="flex items-center justify-center">
          <span className="rounded bg-card/90 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-mono font-medium text-muted-foreground border border-border/50 whitespace-nowrap tabular-nums">
            {formatCallCount(callCount)}
            {errorRate > 0 && (
              <span
                className={
                  errorRate > 5
                    ? " text-red-600 dark:text-red-400"
                    : errorRate > 1
                      ? " text-amber-600 dark:text-amber-400"
                      : ""
                }
              >
                {" "}
                {errorRate.toFixed(1)}%
              </span>
            )}
          </span>
        </div>
      </foreignObject>
    </>
  )
})
