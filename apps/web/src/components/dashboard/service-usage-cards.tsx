import { Result } from "@/lib/effect-atom"
import {
  FileIcon,
  PulseIcon,
  ChartLineIcon,
  DatabaseIcon,
} from "@/components/icons"

import { Card, CardContent, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { getServiceUsageResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import type { ServiceUsageResponse } from "@/api/tinybird/service-usage"

function formatNumber(num: number): string {
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K`
  }
  return num.toLocaleString()
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) {
    return `${(bytes / 1_000_000_000).toFixed(2)} GB`
  }
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(2)} MB`
  }
  if (bytes >= 1_000) {
    return `${(bytes / 1_000).toFixed(2)} KB`
  }
  return `${bytes} B`
}

type CardKey = "logs" | "traces" | "metrics" | "dataSize"

const cardConfig: Array<{
  title: string
  key: CardKey
  icon: typeof FileIcon
  format: (n: number) => string
}> = [
  { title: "Total Logs", key: "logs", icon: FileIcon, format: formatNumber },
  { title: "Total Traces", key: "traces", icon: PulseIcon, format: formatNumber },
  { title: "Total Metrics", key: "metrics", icon: ChartLineIcon, format: formatNumber },
  { title: "Data Size", key: "dataSize", icon: DatabaseIcon, format: formatBytes },
]

interface ServiceUsageCardsProps {
  startTime?: string
  endTime?: string
}

function sumTotals(response: ServiceUsageResponse) {
  return response.data.reduce(
    (acc, service) => ({
      logs: acc.logs + service.totalLogs,
      traces: acc.traces + service.totalTraces,
      metrics: acc.metrics + service.totalMetrics,
      dataSize: acc.dataSize + service.dataSizeBytes,
    }),
    { logs: 0, traces: 0, metrics: 0, dataSize: 0 },
  )
}

function shiftRangeBack(startTime?: string, endTime?: string) {
  if (!startTime || !endTime) return { startTime: undefined, endTime: undefined }
  const start = new Date(startTime.replace(" ", "T") + "Z")
  const end = new Date(endTime.replace(" ", "T") + "Z")
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { startTime: undefined, endTime: undefined }
  }
  const duration = end.getTime() - start.getTime()
  const prevEnd = new Date(start.getTime())
  const prevStart = new Date(start.getTime() - duration)
  const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19)
  return { startTime: fmt(prevStart), endTime: fmt(prevEnd) }
}

function DeltaChip({ current, previous }: { current: number; previous: number }) {
  if (previous <= 0 || !Number.isFinite(previous)) {
    return <span className="text-[10px] text-muted-foreground/60 tabular-nums">—</span>
  }
  const pct = ((current - previous) / previous) * 100
  if (!Number.isFinite(pct)) {
    return <span className="text-[10px] text-muted-foreground/60 tabular-nums">—</span>
  }
  const rounded = Math.abs(pct) < 0.05 ? 0 : pct
  const up = rounded > 0
  const neutral = rounded === 0
  const arrow = neutral ? "·" : up ? "↑" : "↓"
  const color = neutral
    ? "text-muted-foreground/70"
    : up
      ? "text-[color:var(--severity-info)]"
      : "text-[color:var(--severity-warn)]"
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] tabular-nums ${color}`}>
      <span className="font-medium">{arrow}</span>
      <span>{Math.abs(rounded).toFixed(rounded === 0 ? 0 : 1)}%</span>
      <span className="text-muted-foreground/50">vs prev</span>
    </span>
  )
}

export function ServiceUsageCards({ startTime, endTime }: ServiceUsageCardsProps = {}) {
  const responseResult = useRefreshableAtomValue(
    getServiceUsageResultAtom({ data: { startTime, endTime } }),
  )

  const { startTime: prevStart, endTime: prevEnd } = shiftRangeBack(startTime, endTime)
  const previousResult = useRefreshableAtomValue(
    getServiceUsageResultAtom({ data: { startTime: prevStart, endTime: prevEnd } }),
  )

  const previousTotals = Result.builder(previousResult)
    .onSuccess((r) => sumTotals(r))
    .orElse(() => null as null | ReturnType<typeof sumTotals>)

  return Result.builder(responseResult)
    .onInitial(() => (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {cardConfig.map((card) => (
          <Card key={card.title} className="overflow-hidden">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-4" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-10 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>
    ))
    .onError(() => (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {cardConfig.map((card) => (
          <Card key={card.title}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
              <card.icon size={16} className="text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-sm text-muted-foreground">Unable to load</div>
            </CardContent>
          </Card>
        ))}
      </div>
    ))
    .onSuccess((response) => {
      const totals = sumTotals(response)

      return (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {cardConfig.map((card) => {
            const current = totals[card.key]
            const previous = previousTotals?.[card.key]
            return (
              <Card
                key={card.title}
                className="relative overflow-hidden transition-colors hover:border-foreground/20"
              >
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-1">
                  <CardTitle className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    {card.title}
                  </CardTitle>
                  <card.icon size={14} className="text-muted-foreground/70" />
                </CardHeader>
                <CardContent className="pt-0 pb-4">
                  <div className="flex items-baseline gap-3">
                    <div className="font-mono text-3xl font-semibold leading-none tracking-tight text-foreground tabular-nums">
                      {card.format(current)}
                    </div>
                  </div>
                  <div className="mt-2 h-[14px] flex items-center">
                    {previous !== undefined ? (
                      <DeltaChip current={current} previous={previous} />
                    ) : (
                      <Skeleton className="h-3 w-20" />
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )
    })
    .render()
}
