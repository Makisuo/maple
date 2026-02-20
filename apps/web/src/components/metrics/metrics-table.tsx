import { Result, useAtomValue } from "@effect-atom/atom-react"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@maple/ui/components/ui/table"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Badge } from "@maple/ui/components/ui/badge"
import { MetricTypeBadge } from "./metric-type-badge"
import { type Metric, type ListMetricsInput } from "@/api/tinybird/metrics"
import { listMetricsResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"

function formatNumber(num: number): string {
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K`
  }
  return num.toLocaleString()
}

function formatTimeAgo(timestamp: string): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  if (diffSec < 60) return `${diffSec}s ago`
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHour < 24) return `${diffHour}h ago`
  return `${diffDay}d ago`
}

interface MetricsTableProps {
  search: string
  metricType: ListMetricsInput["metricType"] | null
  selectedMetric: Metric | null
  onSelectMetric: (metric: Metric | null) => void
}

function LoadingState() {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Metric Name</TableHead>
            <TableHead className="w-[100px]">Type</TableHead>
            <TableHead className="w-[120px]">Service</TableHead>
            <TableHead className="w-[100px]">Points</TableHead>
            <TableHead className="w-[100px]">Last Seen</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 10 }).map((_, i) => (
            <TableRow key={i}>
              <TableCell><Skeleton className="h-4 w-48" /></TableCell>
              <TableCell><Skeleton className="h-4 w-16" /></TableCell>
              <TableCell><Skeleton className="h-4 w-20" /></TableCell>
              <TableCell><Skeleton className="h-4 w-12" /></TableCell>
              <TableCell><Skeleton className="h-4 w-16" /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function MetricsTable({
  search,
  metricType,
  selectedMetric,
  onSelectMetric,
}: MetricsTableProps) {
  const metricsResult = useAtomValue(
    listMetricsResultAtom({
      data: {
        search: search || undefined,
        metricType: metricType || undefined,
        limit: 100,
      },
    }),
  )

  return Result.builder(metricsResult)
    .onInitial(() => <LoadingState />)
    .onError((error) => (
      <div className="rounded-md border border-red-500/50 bg-red-500/10 p-8">
        <p className="font-medium text-red-600">Failed to load metrics</p>
        <pre className="mt-2 text-xs text-red-500 whitespace-pre-wrap">{error.message}</pre>
      </div>
    ))
    .onSuccess((response, result) => (
      <div className={`space-y-4 ${result.waiting ? "opacity-60" : ""}`}>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Metric Name</TableHead>
                <TableHead className="w-[100px]">Type</TableHead>
                <TableHead className="w-[120px]">Service</TableHead>
                <TableHead className="w-[100px]">Points</TableHead>
                <TableHead className="w-[100px]">Last Seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {response.data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center">
                    No metrics found
                  </TableCell>
                </TableRow>
              ) : (
                response.data.map((metric) => {
                  const isSelected = selectedMetric?.metricName === metric.metricName &&
                    selectedMetric?.metricType === metric.metricType &&
                    selectedMetric?.serviceName === metric.serviceName

                  return (
                    <TableRow
                      key={`${metric.metricName}-${metric.metricType}-${metric.serviceName}`}
                      className={`cursor-pointer ${isSelected ? "bg-muted" : "hover:bg-muted/50"}`}
                      onClick={() => onSelectMetric(isSelected ? null : metric)}
                    >
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <span className="font-mono text-xs">{metric.metricName}</span>
                          {metric.metricDescription && (
                            <span className="text-[10px] text-muted-foreground line-clamp-1">
                              {metric.metricDescription}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <MetricTypeBadge type={metric.metricType} />
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {metric.serviceName}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {formatNumber(metric.dataPointCount)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatTimeAgo(metric.lastSeen)}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>

        <div className="text-sm text-muted-foreground">Showing {response.data.length} metrics</div>
      </div>
    ))
    .render()
}
