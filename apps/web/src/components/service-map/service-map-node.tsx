import { memo } from "react"
import { Handle, Position } from "@xyflow/react"
import { cn } from "@/lib/utils"
import { getServiceLegendColor } from "@/lib/colors"
import type { ServiceNodeData } from "./service-map-utils"

function formatRate(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  if (value >= 1) return value.toFixed(1)
  return value.toFixed(2)
}

function formatLatency(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${ms.toFixed(1)}ms`
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

interface ServiceMapNodeProps {
  data: ServiceNodeData
}

export const ServiceMapNode = memo(function ServiceMapNode({
  data,
}: ServiceMapNodeProps) {
  const { label, throughput, errorRate, avgLatencyMs, services } = data
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
          "w-[200px] rounded-lg shadow-sm ring-2 transition-shadow hover:shadow-md bg-card",
          getHealthClass(errorRate),
        )}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-t-lg text-xs font-semibold truncate"
          style={{ backgroundColor: color, color: "oklch(0.98 0 0)" }}
        >
          <div
            className={cn("h-2 w-2 rounded-full shrink-0", getHealthDotClass(errorRate))}
          />
          <span className="truncate">{label}</span>
        </div>

        {/* Metrics */}
        <div className="grid grid-cols-3 divide-x divide-border px-1 py-2 text-center text-[10px]">
          <div>
            <div className="font-medium text-muted-foreground">req/s</div>
            <div className="font-mono font-semibold text-foreground tabular-nums">
              {formatRate(throughput)}
            </div>
          </div>
          <div>
            <div className="font-medium text-muted-foreground">err%</div>
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
              {errorRate.toFixed(1)}%
            </div>
          </div>
          <div>
            <div className="font-medium text-muted-foreground">avg</div>
            <div className="font-mono font-semibold text-foreground tabular-nums">
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
