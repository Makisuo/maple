import { useMemo } from "react"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { Card } from "@maple/ui/components/ui/card"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import {
  CircleCheckIcon,
  DatabaseIcon,
  PulseIcon,
  ServerIcon,
  type IconComponent,
} from "@/components/icons"
import { fleetUtilizationTimeseriesResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"

import { deriveHostStatus, formatPercent, severityLevel, type SeverityLevel } from "./format"
import type { HostRow } from "./host-table"

interface HostSummaryCardsProps {
  hosts: ReadonlyArray<HostRow>
  startTime: string
  endTime: string
  bucketSeconds?: number
}

const VALUE_TONE_BY_LEVEL: Record<SeverityLevel | "neutral", string> = {
  neutral: "text-foreground",
  ok: "text-foreground",
  warn: "text-[var(--severity-warn)]",
  crit: "text-[var(--severity-error)]",
}

const BAR_COLOR_BY_LEVEL: Record<SeverityLevel | "neutral", string> = {
  neutral: "var(--primary)",
  ok: "var(--severity-info)",
  warn: "var(--severity-warn)",
  crit: "var(--severity-error)",
}

function BarSparkline({
  values,
  color,
  className,
}: {
  values: ReadonlyArray<number>
  color: string
  className?: string
}) {
  if (!values.length) {
    return <div className={className} />
  }
  const max = Math.max(...values, 0.0001)
  const count = values.length
  const gap = 2
  const barWidth = Math.max((100 - gap * (count - 1)) / count, 0.5)
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className={className}
      aria-hidden
    >
      {values.map((v, i) => {
        const safe = Number.isFinite(v) && v >= 0 ? v : 0
        const ratio = max > 0 ? safe / max : 0
        const h = Math.max(ratio * 100, safe > 0 ? 4 : 0)
        const x = i * (barWidth + gap)
        const y = 100 - h
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barWidth}
            height={h}
            rx={0.8}
            fill={color}
            opacity={0.35 + ratio * 0.65}
          />
        )
      })}
    </svg>
  )
}

interface KpiCardProps {
  icon: IconComponent
  label: string
  value: string
  subline: React.ReactNode
  level: SeverityLevel | "neutral"
  spark?: ReadonlyArray<number>
  delay?: number
}

function KpiCard({ icon: Icon, label, value, subline, level, spark, delay }: KpiCardProps) {
  const bars = useMemo(
    () => (spark && spark.length > 1 ? spark.slice(-24) : null),
    [spark],
  )
  return (
    <Card
      className={cn(
        "relative overflow-hidden p-4 transition-colors hover:bg-muted/30",
        "animate-in fade-in slide-in-from-bottom-1 duration-500",
      )}
      style={delay ? { animationDelay: `${delay}ms`, animationFillMode: "backwards" } : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Icon size={14} />
          <span className="text-[11px] font-medium tracking-wide">{label}</span>
        </div>
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div
          className={cn(
            "font-mono text-3xl font-semibold tabular-nums leading-none",
            VALUE_TONE_BY_LEVEL[level],
          )}
        >
          {value}
        </div>
        {bars ? (
          <BarSparkline
            values={bars}
            color={BAR_COLOR_BY_LEVEL[level]}
            className="h-7 w-20"
          />
        ) : (
          <div className="h-7 w-20" />
        )}
      </div>
      <div className="mt-2 text-[11px] text-muted-foreground">{subline}</div>
    </Card>
  )
}

export function HostSummaryCards({
  hosts,
  startTime,
  endTime,
  bucketSeconds = 300,
}: HostSummaryCardsProps) {
  const trendsResult = useAtomValue(
    fleetUtilizationTimeseriesResultAtom({
      data: { startTime, endTime, bucketSeconds },
    }),
  )

  const trends = Result.builder(trendsResult)
    .onSuccess((r) => r.data)
    .orElse(() => null)

  const total = hosts.length
  const active = hosts.filter((h) => deriveHostStatus(h.lastSeen) === "active").length
  const stale = total - active
  const avg = (pick: (h: HostRow) => number) => {
    if (hosts.length === 0) return 0
    const sum = hosts.reduce(
      (acc, h) => acc + (Number.isFinite(pick(h)) ? pick(h) : 0),
      0,
    )
    return sum / hosts.length
  }
  const cpuAvg = avg((h) => h.cpuPct)
  const memoryAvg = avg((h) => h.memoryPct)
  const cpuOver80 = hosts.filter((h) => (h.cpuPct ?? 0) >= 0.8).length
  const memOver80 = hosts.filter((h) => (h.memoryPct ?? 0) >= 0.8).length

  const cpuSpark = trends?.map((t) => t.avgCpu) ?? []
  const memSpark = trends?.map((t) => t.avgMemory) ?? []
  const hostsSpark = trends?.map((t) => t.activeHosts) ?? []

  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
      <KpiCard
        icon={ServerIcon}
        label="Hosts"
        value={String(total)}
        subline={
          <>
            <span className="text-foreground/80">{active}</span> active
            {stale > 0 ? (
              <>
                {" · "}
                <span className="text-foreground/80">{stale}</span> idle/down
              </>
            ) : null}
          </>
        }
        level="neutral"
        spark={hostsSpark}
        delay={0}
      />
      <KpiCard
        icon={CircleCheckIcon}
        label="Healthy"
        value={`${total === 0 ? 0 : Math.round((active / Math.max(total, 1)) * 100)}%`}
        subline={
          stale === 0 ? (
            "All hosts reporting"
          ) : (
            <>
              <span className="text-foreground/80">{stale}</span> not reporting
            </>
          )
        }
        level={stale === 0 ? "ok" : stale / Math.max(total, 1) >= 0.25 ? "crit" : "warn"}
        delay={60}
      />
      <KpiCard
        icon={PulseIcon}
        label="Avg CPU"
        value={formatPercent(cpuAvg)}
        subline={
          cpuOver80 > 0 ? (
            <>
              <span className="text-[var(--severity-warn)] font-medium">{cpuOver80}</span>{" "}
              host{cpuOver80 === 1 ? "" : "s"} over 80%
            </>
          ) : (
            "No hosts above 80% threshold"
          )
        }
        level={severityLevel(cpuAvg)}
        spark={cpuSpark}
        delay={120}
      />
      <KpiCard
        icon={DatabaseIcon}
        label="Avg memory"
        value={formatPercent(memoryAvg)}
        subline={
          memOver80 > 0 ? (
            <>
              <span className="text-[var(--severity-warn)] font-medium">{memOver80}</span>{" "}
              host{memOver80 === 1 ? "" : "s"} over 80%
            </>
          ) : (
            "No hosts above 80% threshold"
          )
        }
        level={severityLevel(memoryAvg)}
        spark={memSpark}
        delay={180}
      />
    </div>
  )
}

export function HostSummaryCardsLoading() {
  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i} className="p-4">
          <div className="flex items-center gap-1.5">
            <Skeleton className="size-3.5 rounded" />
            <Skeleton className="h-3 w-20" />
          </div>
          <div className="mt-2 flex items-end justify-between gap-3">
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-7 w-20" />
          </div>
          <Skeleton className="mt-2 h-3 w-32" />
        </Card>
      ))}
    </div>
  )
}
