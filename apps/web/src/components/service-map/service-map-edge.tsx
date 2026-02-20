import { memo, useId } from "react"
import { getSmoothStepPath, type EdgeProps } from "@xyflow/react"
import { getServiceLegendColor } from "@maple/ui/colors"
import { useReducedMotion } from "@/hooks/use-reduced-motion"
import type { ServiceEdgeData } from "./service-map-utils"

function getStrokeWidth(callCount: number): number {
  if (callCount <= 0) return 2
  return Math.min(8, Math.max(2, 2 + Math.log10(callCount) * 2))
}

function getEdgeIntensity(callsPerSecond: number): number {
  if (callsPerSecond <= 0) return 0.15
  return Math.min(1, 0.3 + 0.7 * (Math.log10(1 + callsPerSecond) / Math.log10(100)))
}

const TRAVERSE_TIME = 2
const MAX_DUR = 20
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
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const uniqueId = useId()
  const reducedMotion = useReducedMotion()
  const edgeData = data as ServiceEdgeData | undefined

  const callCount = edgeData?.callCount ?? 0
  const estimatedCallCount = edgeData?.hasSampling
    ? Math.round((edgeData?.estimatedCallsPerSecond ?? 0) * (callCount / Math.max(edgeData?.callsPerSecond ?? 1, 0.001)))
    : callCount
  const callsPerSecond = edgeData?.callsPerSecond ?? 0
  const errorRate = edgeData?.errorRate ?? 0
  const hasSampling = edgeData?.hasSampling ?? false
  const services = edgeData?.services ?? []

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 12,
  })

  const sourceColor = getServiceLegendColor(source, services)
  const targetColor = getServiceLegendColor(target, services)
  const sw = getStrokeWidth(callCount)
  const i = getEdgeIntensity(callsPerSecond)

  // Particle calculation
  const rate = Math.max(callsPerSecond, 0)
  let particleCount: number
  let traversalDuration: number

  if (rate <= 0) {
    particleCount = 0
    traversalDuration = TRAVERSE_TIME
  } else {
    const interArrival = 1 / rate
    if (interArrival > TRAVERSE_TIME) {
      particleCount = 1
      traversalDuration = Math.min(interArrival, MAX_DUR)
    } else {
      traversalDuration = TRAVERSE_TIME
      particleCount = Math.min(MAX_PARTICLES, Math.max(1, Math.round(rate * TRAVERSE_TIME)))
    }
  }

  const stagger = traversalDuration / particleCount
  const edgeOffset = simpleHash(id) * Math.min(stagger, 1)
  const particleRadius = Math.max(2, sw * 0.6)

  // Stable IDs for SVG defs
  const safeId = `${id}-${uniqueId}`.replace(/[^a-zA-Z0-9-_]/g, "_")
  const pathId = `path-${safeId}`
  const gradientId = `grad-${safeId}`
  const ambientFilterId = `ambient-${safeId}`
  const glassFilterId = `glass-${safeId}`
  const bloomFilterId = `bloom-${safeId}`

  return (
    <>
      <defs>
        {/* Per-edge gradient from source → target service color */}
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1={sourceX}
          y1={sourceY}
          x2={targetX}
          y2={targetY}
        >
          <stop offset="0%" stopColor={sourceColor} />
          <stop offset="100%" stopColor={targetColor} />
        </linearGradient>

        {/* Ambient glow filter */}
        <filter id={ambientFilterId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="8" />
        </filter>

        {/* Tube glass inner highlight filter */}
        <filter id={glassFilterId} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="0.5" result="glass-blur" />
          <feMerge>
            <feMergeNode in="glass-blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        {/* Particle bloom filter — triple merge for light-bleed effect */}
        <filter id={bloomFilterId} x="-200%" y="-200%" width="500%" height="500%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="bloom-wide" />
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.5" result="bloom-tight" />
          <feMerge>
            <feMergeNode in="bloom-wide" />
            <feMergeNode in="bloom-tight" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Layer 0: Ambient glow — atmospheric halo */}
      <path
        d={edgePath}
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={sw * 3 + 12}
        strokeOpacity={0.04 + i * 0.08}
        filter={`url(#${ambientFilterId})`}
      />

      {/* Layer 1: Tube outer wall — bright rim highlight */}
      <path
        d={edgePath}
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={sw + 4}
        strokeOpacity={0.12 + i * 0.15}
      />

      {/* Layer 2: Tube dark core — hollow interior */}
      <path
        id={pathId}
        d={edgePath}
        fill="none"
        stroke="oklch(0.141 0.005 285.823)"
        strokeWidth={sw}
        strokeOpacity={0.5 + i * 0.2}
        className="react-flow__edge-path"
      />

      {/* Layer 3: Inner highlight — glass shine */}
      <path
        d={edgePath}
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={sw * 0.4}
        strokeOpacity={0.15 + i * 0.25}
        filter={`url(#${glassFilterId})`}
      />

      {/* Layer 4: Energy dashes — flowing energy */}
      <path
        d={edgePath}
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={sw * 0.25}
        strokeOpacity={0.2 + i * 0.4}
        strokeDasharray="4 20"
        className={reducedMotion ? undefined : "service-map-flowing-dash"}
      />

      {/* Layer 5: Light particles — comet shapes with bloom */}
      {!reducedMotion &&
        Array.from({ length: particleCount }).map((_, idx) => (
          <g
            key={idx}
            filter={`url(#${bloomFilterId})`}
            visibility="hidden"
          >
            <set
              attributeName="visibility"
              to="visible"
              begin={`${edgeOffset + idx * stagger}s`}
              fill="freeze"
            />
            {/* Comet tail — elongated ellipse oriented along path */}
            <ellipse
              rx={particleRadius * 3}
              ry={particleRadius * 0.8}
              fill={sourceColor}
              opacity={0.3}
            >
              <animateMotion
                dur={`${traversalDuration}s`}
                repeatCount="indefinite"
                begin={`${edgeOffset + idx * stagger}s`}
                rotate="auto"
              >
                <mpath href={`#${pathId}`} />
              </animateMotion>
            </ellipse>

            {/* Bright core */}
            <circle
              r={particleRadius * 0.7}
              fill="white"
              opacity={0.9}
            >
              <animateMotion
                dur={`${traversalDuration}s`}
                repeatCount="indefinite"
                begin={`${edgeOffset + idx * stagger}s`}
                rotate="auto"
              >
                <mpath href={`#${pathId}`} />
              </animateMotion>
            </circle>
          </g>
        ))}

      {/* Layer 6: Label */}
      <foreignObject
        x={labelX - 40}
        y={labelY - 12}
        width={80}
        height={24}
        className="overflow-visible pointer-events-none"
      >
        <div className="flex items-center justify-center" title={hasSampling ? "Based on traced requests — actual rate may be higher with sampling enabled" : undefined}>
          <span className="rounded bg-card/90 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-mono font-medium text-muted-foreground border border-border/50 whitespace-nowrap tabular-nums">
            {hasSampling ? "~" : ""}{formatCallCount(hasSampling ? estimatedCallCount : callCount)}
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
