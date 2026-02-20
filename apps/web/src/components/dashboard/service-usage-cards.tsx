import { Result, useAtomValue } from "@effect-atom/atom-react"
import {
  FileIcon,
  PulseIcon,
  ChartLineIcon,
  DatabaseIcon,
} from "@/components/icons"

import { Card, CardContent, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { getServiceUsageResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"

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

const cardConfig = [
  {
    title: "Total Logs",
    key: "logs" as const,
    icon: FileIcon,
    format: formatNumber,
  },
  {
    title: "Total Traces",
    key: "traces" as const,
    icon: PulseIcon,
    format: formatNumber,
  },
  {
    title: "Total Metrics",
    key: "metrics" as const,
    icon: ChartLineIcon,
    format: formatNumber,
  },
  {
    title: "Data Size",
    key: "dataSize" as const,
    icon: DatabaseIcon,
    format: formatBytes,
  },
]

interface ServiceUsageCardsProps {
  startTime?: string
  endTime?: string
}

export function ServiceUsageCards({ startTime, endTime }: ServiceUsageCardsProps = {}) {
  const responseResult = useAtomValue(
    getServiceUsageResultAtom({ data: { startTime, endTime } }),
  )

  return Result.builder(responseResult)
    .onInitial(() => (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {cardConfig.map((card) => (
          <Card key={card.title}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-4" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-20" />
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
      const totals = response.data.reduce(
        (acc: { logs: number; traces: number; metrics: number; dataSize: number }, service) => ({
          logs: acc.logs + service.totalLogs,
          traces: acc.traces + service.totalTraces,
          metrics: acc.metrics + service.totalMetrics,
          dataSize: acc.dataSize + service.dataSizeBytes,
        }),
        { logs: 0, traces: 0, metrics: 0, dataSize: 0 },
      )

      return (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {cardConfig.map((card) => (
            <Card key={card.title}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
                <card.icon size={16} className="text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{card.format(totals[card.key])}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )
    })
    .render()
}
