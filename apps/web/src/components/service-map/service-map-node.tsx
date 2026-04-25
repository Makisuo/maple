import { memo } from "react"
import { Handle, Position } from "@xyflow/react"
import { cn } from "@maple/ui/utils"
import { getServiceLegendColor } from "@maple/ui/colors"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@maple/ui/components/ui/tooltip"
import { CubeIcon } from "@/components/icons"
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

function getHealthDotClass(errorRate: number): string {
  if (errorRate > 0.05) return "bg-severity-error"
  if (errorRate > 0.01) return "bg-severity-warn"
  return "bg-severity-info"
}

function getSelectedBorderClass(errorRate: number): string {
  if (errorRate > 0.05) return "border-severity-error shadow-[0_0_0_3px_oklch(0.5_0.2_25/0.15)]"
  if (errorRate > 0.01) return "border-severity-warn shadow-[0_0_0_3px_oklch(0.6_0.15_60/0.15)]"
  return "border-border-active shadow-[0_0_0_3px_oklch(0.3_0.02_60/0.2)]"
}

interface ServiceMapNodeProps {
  data: ServiceNodeData
}

export const ServiceMapNode = memo(function ServiceMapNode({
  data,
}: ServiceMapNodeProps) {
  const { label, throughput, tracedThroughput, hasSampling, samplingWeight, errorRate, avgLatencyMs, services, selected, infra } = data
  const accentColor = getServiceLegendColor(label, services)

  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        className="!opacity-0 !w-0 !h-0 !min-w-0 !min-h-0"
        isConnectable={false}
      />

      <div
        className={cn(
          "w-[220px] rounded-lg bg-card border overflow-hidden flex cursor-pointer transition-[border-color,box-shadow] duration-150",
          selected
            ? getSelectedBorderClass(errorRate)
            : "border-border hover:border-border-active",
        )}
      >
        {/* Left accent stripe */}
        <div
          className="w-[3px] shrink-0"
          style={{ backgroundColor: accentColor }}
        />

        <div className="flex flex-col gap-2 px-3 py-2.5 flex-1 min-w-0">
          {/* Service name + health dot */}
          <div className="flex items-center gap-1.5">
            <div
              className={cn("h-1.5 w-1.5 rounded-full shrink-0", getHealthDotClass(errorRate))}
            />
            <span className="text-xs font-medium text-foreground truncate">{label}</span>
          </div>

          {/* Metrics row */}
          <div className="flex gap-4">
            <Tooltip>
              <TooltipTrigger>
                <div className="flex flex-col gap-px">
                  <span className="text-[9px] font-medium tracking-wide text-muted-foreground/60 uppercase">req/s</span>
                  <span className="text-[11px] font-medium text-secondary-foreground font-mono tabular-nums">
                    {hasSampling ? "~" : ""}{formatRate(throughput)}
                  </span>
                </div>
              </TooltipTrigger>
              {hasSampling && (
                <TooltipContent side="bottom">
                  <p>Estimated x{samplingWeight.toFixed(0)} from {formatRate(tracedThroughput)} traced req/s</p>
                </TooltipContent>
              )}
            </Tooltip>

            <div className="flex flex-col gap-px">
              <span className="text-[9px] font-medium tracking-wide text-muted-foreground/60 uppercase">err%</span>
              <span
                className={cn(
                  "text-[11px] font-medium font-mono tabular-nums",
                  errorRate > 0.05
                    ? "text-severity-error"
                    : errorRate > 0.01
                      ? "text-severity-warn"
                      : "text-secondary-foreground",
                )}
              >
                {(errorRate * 100).toFixed(1)}%
              </span>
            </div>

            <div className="flex flex-col gap-px">
              <span className="text-[9px] font-medium tracking-wide text-muted-foreground/60 uppercase">avg</span>
              <span className="text-[11px] font-medium text-secondary-foreground font-mono tabular-nums">
                {formatLatency(avgLatencyMs)}
              </span>
            </div>

            {/* Pods badge — empty placeholder when no infra so widths stay stable */}
            <div className="flex flex-col gap-px ml-auto items-end">
              <span className="text-[9px] font-medium tracking-wide text-muted-foreground/60 uppercase">pods</span>
              {infra ? (
                <Tooltip>
                  <TooltipTrigger>
                    <span className="flex items-center gap-1 text-[11px] font-medium text-secondary-foreground font-mono tabular-nums">
                      <CubeIcon size={10} className="text-muted-foreground/70" />
                      {infra.podCount}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p>
                      {infra.workloadCount === 1
                        ? `1 Kubernetes workload`
                        : `${infra.workloadCount} Kubernetes workloads`}
                      {", "}
                      {infra.podCount === 1 ? "1 pod" : `${infra.podCount} pods`}
                    </p>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <span className="text-[11px] font-mono tabular-nums text-muted-foreground/30">—</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!opacity-0 !w-0 !h-0 !min-w-0 !min-h-0"
        isConnectable={false}
      />
    </>
  )
})
