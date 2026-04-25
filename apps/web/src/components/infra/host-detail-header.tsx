import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import type { HostDetailSummaryResponse } from "@maple/domain/http"

import { HostStatusBadge } from "./status-badge"
import { HeroChip, PageHero } from "./primitives/page-hero"
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

export function HostDetailHeader({ summary, hostName }: HostDetailHeaderProps) {
  if (!summary) {
    return (
      <PageHero
        title={<span className="font-mono">{hostName}</span>}
        description="No metrics have arrived in the selected time window."
      />
    )
  }

  const cpuLevel = severityLevel(summary.cpuPct)
  const memLevel = severityLevel(summary.memoryPct)
  const diskLevel = severityLevel(summary.diskPct)

  const meta = (
    <>
      {summary.osType && <HeroChip>os {summary.osType}</HeroChip>}
      {summary.hostArch && <HeroChip>arch {summary.hostArch}</HeroChip>}
      {summary.cloudProvider && <HeroChip>cloud {summary.cloudProvider}</HeroChip>}
      {summary.cloudRegion && <HeroChip>region {summary.cloudRegion}</HeroChip>}
      <span className="text-[11px] text-muted-foreground/80">
        last reported {formatRelative(summary.lastSeen)}
      </span>
    </>
  )

  return (
    <div className="space-y-6">
      <PageHero
        title={<span className="font-mono">{summary.hostName}</span>}
        meta={meta}
        trailing={<HostStatusBadge lastSeen={summary.lastSeen} />}
      />
      <div className="grid grid-cols-2 divide-x divide-y divide-border rounded-md border bg-card md:grid-cols-4 md:divide-y-0">
        <Kpi
          label="CPU"
          value={formatPercent(summary.cpuPct)}
          level={cpuLevel}
          threshold="warn ≥ 80%"
        />
        <Kpi
          label="Memory"
          value={formatPercent(summary.memoryPct)}
          level={memLevel}
          threshold="warn ≥ 80%"
        />
        <Kpi
          label="Disk"
          value={formatPercent(summary.diskPct)}
          level={diskLevel}
          threshold="warn ≥ 80%"
        />
        <Kpi label="Load 15m" value={formatLoad(summary.load15)} level="neutral" />
      </div>
    </div>
  )
}

function Kpi({
  label,
  value,
  level,
  threshold,
}: {
  label: string
  value: string
  level: SeverityLevel | "neutral"
  threshold?: string
}) {
  return (
    <div className="px-5 py-4">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-2 font-mono text-[26px] font-semibold tabular-nums leading-none tracking-[-0.01em]",
          VALUE_TONE[level],
        )}
        style={{ fontFeatureSettings: "'tnum' 1" }}
      >
        {value}
      </div>
      {threshold ? (
        <div className="mt-2 text-[11px] text-muted-foreground/70">{threshold}</div>
      ) : null}
    </div>
  )
}

export function HostDetailHeaderLoading() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-7 w-72" />
        <Skeleton className="mt-2 h-3 w-96" />
      </div>
      <div className="grid grid-cols-2 divide-x divide-y divide-border rounded-md border bg-card md:grid-cols-4 md:divide-y-0">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="px-5 py-4">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="mt-3 h-7 w-20" />
            <Skeleton className="mt-3 h-3 w-20" />
          </div>
        ))}
      </div>
    </div>
  )
}
