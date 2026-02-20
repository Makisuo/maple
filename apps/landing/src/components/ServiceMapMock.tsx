import { memo, useId } from "react"
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  getSmoothStepPath,
  type EdgeProps,
  type NodeProps,
  type Node,
  type Edge,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { cn } from "@maple/ui/utils"
import { getServiceLegendColor } from "@maple/ui/colors"

// --- TYPES ---

interface MockNodeData extends Record<string, unknown> {
  label: string
  throughput: number
  errorRate: number
  avgLatencyMs: number
  services: string[]
}

interface MockEdgeData extends Record<string, unknown> {
  callCount: number
  callsPerSecond: number
  errorRate: number
  services: string[]
}

// --- UTILS ---

function formatRate(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  if (value >= 1) return value.toFixed(1)
  return value.toFixed(2)
}

function formatLatency(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${ms.toFixed(0)}ms`
}

function getHealthClass(errorRate: number): string {
  if (errorRate > 5) return "ring-red-500/60"
  if (errorRate > 1) return "ring-amber-500/60"
  return "ring-emerald-500/40"
}

function getHealthDotClass(errorRate: number): string {
  if (errorRate > 5) return "bg-red-500"
  if (errorRate > 1) return "bg-amber-500"
  return "bg-emerald-500"
}

// --- CUSTOM NODE ---

const MockNode = memo(function MockNode({ data }: NodeProps<Node>) {
  const mockData = data as unknown as MockNodeData
  const { label, throughput, errorRate, avgLatencyMs, services } = mockData
  const color = getServiceLegendColor(label, services)

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!opacity-0 !w-0 !h-0 !min-w-0 !min-h-0"
        isConnectable={false}
      />
      <div
        className={cn(
          "w-[140px] rounded-lg shadow-sm ring-2 transition-shadow hover:shadow-md bg-card",
          getHealthClass(errorRate),
        )}
      >
        <div
          className="flex items-center justify-center gap-2 px-3 py-1.5 rounded-t-lg text-[10px] font-semibold truncate"
          style={{ backgroundColor: color, color: "oklch(0.98 0 0)" }}
        >
          <div className={cn("h-1.5 w-1.5 rounded-full shrink-0", getHealthDotClass(errorRate))} />
          <span className="truncate">{label}</span>
        </div>
        <div className="grid grid-cols-2 divide-x divide-border px-1 py-1.5 text-center text-[9px]">
          <div>
            <div className="font-medium text-muted-foreground">req/s</div>
            <div className="font-mono font-semibold text-foreground tabular-nums">
              {formatRate(throughput)}
            </div>
          </div>
          <div>
            <div className="font-medium text-muted-foreground">P95</div>
            <div
              className={cn(
                "font-mono font-semibold tabular-nums",
                errorRate > 5
                  ? "text-red-600 dark:text-red-400"
                  : errorRate > 1
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-foreground",
              )}
            >
              {formatLatency(avgLatencyMs)}
            </div>
          </div>
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!opacity-0 !w-0 !h-0 !min-w-0 !min-h-0"
        isConnectable={false}
      />
    </>
  )
})

// --- CUSTOM EDGE ---

function getStrokeWidth(callCount: number): number {
  if (callCount <= 0) return 2
  return Math.min(6, Math.max(2, 2 + Math.log10(callCount) * 1.5))
}

function getEdgeIntensity(callsPerSecond: number): number {
  if (callsPerSecond <= 0) return 0.15
  return Math.min(1, 0.3 + 0.7 * (Math.log10(1 + callsPerSecond) / Math.log10(100)))
}

function simpleHash(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0
  }
  return (Math.abs(h) % 1000) / 1000
}

const TRAVERSE_TIME = 2
const MAX_DUR = 20
const MAX_PARTICLES = 5

const MockEdge = memo(function MockEdge({
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
}: EdgeProps<Edge>) {
  const uniqueId = useId()
  const edgeData = data as unknown as MockEdgeData

  const callCount = edgeData?.callCount ?? 0
  const callsPerSecond = edgeData?.callsPerSecond ?? 0
  const services = edgeData?.services ?? []

  const [edgePath] = getSmoothStepPath({
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

  const safeId = `${id}-${uniqueId}`.replace(/[^a-zA-Z0-9-_]/g, "_")
  const pathId = `path-${safeId}`
  const gradientId = `grad-${safeId}`
  const ambientFilterId = `ambient-${safeId}`
  const glassFilterId = `glass-${safeId}`
  const bloomFilterId = `bloom-${safeId}`

  return (
    <>
      <defs>
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

        <filter id={ambientFilterId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="6" />
        </filter>

        <filter id={glassFilterId} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="0.5" result="glass-blur" />
          <feMerge>
            <feMergeNode in="glass-blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        <filter id={bloomFilterId} x="-200%" y="-200%" width="500%" height="500%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="bloom-wide" />
          <feGaussianBlur in="SourceGraphic" stdDeviation="1" result="bloom-tight" />
          <feMerge>
            <feMergeNode in="bloom-wide" />
            <feMergeNode in="bloom-tight" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <path
        d={edgePath}
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={sw * 3 + 8}
        strokeOpacity={0.04 + i * 0.08}
        filter={`url(#${ambientFilterId})`}
      />
      <path
        d={edgePath}
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={sw + 3}
        strokeOpacity={0.12 + i * 0.15}
      />
      <path
        id={pathId}
        d={edgePath}
        fill="none"
        stroke="oklch(0.141 0.005 285.823)"
        strokeWidth={sw}
        strokeOpacity={0.5 + i * 0.2}
      />
      <path
        d={edgePath}
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={sw * 0.4}
        strokeOpacity={0.15 + i * 0.25}
        filter={`url(#${glassFilterId})`}
      />
      <path
        d={edgePath}
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={sw * 0.25}
        strokeOpacity={0.2 + i * 0.4}
        strokeDasharray="4 20"
        className="service-map-flowing-dash"
        style={{
          animation: `flow 2s linear infinite`,
        }}
      />

      <style>{`
        @keyframes flow {
          from { stroke-dashoffset: 24; }
          to { stroke-dashoffset: 0; }
        }
      `}</style>

      {Array.from({ length: particleCount }).map((_, idx) => (
        <g key={idx} filter={`url(#${bloomFilterId})`} visibility="hidden">
          <set
            attributeName="visibility"
            to="visible"
            begin={`${edgeOffset + idx * stagger}s`}
            fill="freeze"
          />
          <ellipse rx={particleRadius * 2.5} ry={particleRadius * 0.8} fill={sourceColor} opacity={0.4}>
            <animateMotion
              dur={`${traversalDuration}s`}
              repeatCount="indefinite"
              begin={`${edgeOffset + idx * stagger}s`}
              rotate="auto"
            >
              <mpath href={`#${pathId}`} />
            </animateMotion>
          </ellipse>
          <circle r={particleRadius * 0.6} fill="white" opacity={0.9}>
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
    </>
  )
})

// --- DATA ---

const ALL_SERVICES = ["api-gateway", "auth-svc", "order-svc", "payment-svc", "user-db"]

const initialNodes = [
  {
    id: "api-gateway",
    type: "serviceNode",
    position: { x: 180, y: 20 },
    data: { label: "api-gateway", throughput: 1200, errorRate: 0, avgLatencyMs: 480, services: ALL_SERVICES },
  },
  {
    id: "auth-svc",
    type: "serviceNode",
    position: { x: 0, y: 140 },
    data: { label: "auth-svc", throughput: 850, errorRate: 0, avgLatencyMs: 22, services: ALL_SERVICES },
  },
  {
    id: "order-svc",
    type: "serviceNode",
    position: { x: 180, y: 140 },
    data: { label: "order-svc", throughput: 420, errorRate: 2, avgLatencyMs: 85, services: ALL_SERVICES },
  },
  {
    id: "payment-svc",
    type: "serviceNode",
    position: { x: 360, y: 140 },
    data: { label: "payment-svc", throughput: 120, errorRate: 4, avgLatencyMs: 280, services: ALL_SERVICES },
  },
  {
    id: "user-db",
    type: "serviceNode",
    position: { x: 180, y: 260 },
    data: { label: "user-db", throughput: 1800, errorRate: 100, avgLatencyMs: 450, services: ALL_SERVICES },
  },
]

const initialEdges = [
  {
    id: "api-auth",
    source: "api-gateway",
    target: "auth-svc",
    type: "serviceEdge",
    data: { callCount: 850, callsPerSecond: 14, errorRate: 0, services: ALL_SERVICES },
  },
  {
    id: "api-order",
    source: "api-gateway",
    target: "order-svc",
    type: "serviceEdge",
    data: { callCount: 420, callsPerSecond: 7, errorRate: 2, services: ALL_SERVICES },
  },
  {
    id: "api-payment",
    source: "api-gateway",
    target: "payment-svc",
    type: "serviceEdge",
    data: { callCount: 120, callsPerSecond: 2, errorRate: 4, services: ALL_SERVICES },
  },
  {
    id: "auth-db",
    source: "auth-svc",
    target: "user-db",
    type: "serviceEdge",
    data: { callCount: 850, callsPerSecond: 14, errorRate: 100, services: ALL_SERVICES },
  },
  {
    id: "order-db",
    source: "order-svc",
    target: "user-db",
    type: "serviceEdge",
    data: { callCount: 840, callsPerSecond: 14, errorRate: 100, services: ALL_SERVICES },
  },
  {
    id: "payment-db",
    source: "payment-svc",
    target: "user-db",
    type: "serviceEdge",
    data: { callCount: 120, callsPerSecond: 2, errorRate: 100, services: ALL_SERVICES },
  },
]

const nodeTypes = { serviceNode: MockNode }
const edgeTypes = { serviceEdge: MockEdge }

export function ServiceMapMock() {
  return (
    <div className="w-full h-full min-h-[300px] relative pointer-events-none">
      <ReactFlow
        nodes={initialNodes}
        edges={initialEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="currentColor" className="opacity-5" />
      </ReactFlow>
    </div>
  )
}
