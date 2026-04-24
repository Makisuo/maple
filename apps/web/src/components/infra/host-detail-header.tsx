import { Card } from "@maple/ui/components/ui/card"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import {
  ChartLineIcon,
  DatabaseIcon,
  FloppyDiskIcon,
  PulseIcon,
  type IconComponent,
} from "@/components/icons"
import type { HostDetailSummaryResponse } from "@maple/domain/http"

import { HostStatusBadge } from "./status-badge"
import {
  formatLoad,
  formatPercent,
  formatRelative,
  severityLevel,
  type SeverityLevel,
} from "./format"

interface HostDetailHeaderProps {
  summary: HostDetailSummaryResponse["data"]
  hostName: string
}

const VALUE_TONE: Record<SeverityLevel | "neutral", string> = {
  neutral: "text-foreground",
  ok: "text-foreground",
  warn: "text-[var(--severity-warn)]",
  crit: "text-[var(--severity-error)]",
}

interface KpiProps {
  icon: IconComponent
  label: string
  value: string
  level: SeverityLevel | "neutral"
  threshold?: string
}

function Kpi({ icon: Icon, label, value, level, threshold }: KpiProps) {
  return (
    <Card className={cn("relative overflow-hidden p-4")}>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon size={14} />
        <span className="text-[11px] font-medium tracking-wide">{label}</span>
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-3">
        <div
          className={cn(
            "font-mono text-3xl font-semibold tabular-nums leading-none",
            VALUE_TONE[level],
          )}
        >
          {value}
        </div>
        {threshold ? (
          <div className="text-[10px] text-muted-foreground">{threshold}</div>
        ) : null}
      </div>
    </Card>
  )
}

export function HostDetailHeader({ summary, hostName }: HostDetailHeaderProps) {
  if (!summary) {
    return (
      <div className="space-y-3">
        <div>
          <h2 className="font-mono text-base font-semibold tracking-tight">{hostName}</h2>
          <p className="text-muted-foreground text-sm">
            No metrics have arrived in the selected time window.
          </p>
        </div>
      </div>
    )
  }

  const cpuLevel = severityLevel(summary.cpuPct)
  const memLevel = severityLevel(summary.memoryPct)
  const diskLevel = severityLevel(summary.diskPct)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-mono text-base font-semibold tracking-tight">
          {summary.hostName}
        </h2>
        <HostStatusBadge lastSeen={summary.lastSeen} />
        <span className="text-muted-foreground text-xs">
          last reported {formatRelative(summary.lastSeen)}
        </span>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
          first seen {formatRelative(summary.firstSeen)}
        </span>
      </div>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <Kpi
          icon={PulseIcon}
          label="CPU"
          value={formatPercent(summary.cpuPct)}
          level={cpuLevel}
          threshold="warn ≥ 80%"
        />
        <Kpi
          icon={DatabaseIcon}
          label="Memory"
          value={formatPercent(summary.memoryPct)}
          level={memLevel}
          threshold="warn ≥ 80%"
        />
        <Kpi
          icon={FloppyDiskIcon}
          label="Disk"
          value={formatPercent(summary.diskPct)}
          level={diskLevel}
          threshold="warn ≥ 80%"
        />
        <Kpi
          icon={ChartLineIcon}
          label="Load 15m"
          value={formatLoad(summary.load15)}
          level="neutral"
        />
      </div>
    </div>
  )
}

export function HostDetailHeaderLoading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-6 w-48" />
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="p-4">
            <div className="flex items-center gap-1.5">
              <Skeleton className="size-3.5 rounded" />
              <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="mt-3 h-8 w-20" />
          </Card>
        ))}
      </div>
    </div>
  )
}
