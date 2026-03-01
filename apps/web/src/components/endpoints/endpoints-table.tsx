import { Result, useAtomValue } from "@effect-atom/atom-react"
import { Link } from "@tanstack/react-router"

import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@maple/ui/components/ui/table"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Sparkline } from "@maple/ui/components/ui/gradient-chart"
import type { HttpEndpointOverview } from "@/api/tinybird/endpoints-overview"
import { MethodBadge } from "@/components/endpoints/method-badge"
import {
  getHttpEndpointsOverviewResultAtom,
  getHttpEndpointsSparklinesResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"

function formatLatency(ms: number): string {
  if (ms == null || Number.isNaN(ms)) return "-"
  if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`
  if (ms < 1000) return `${ms.toFixed(1)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function formatThroughput(count: number, durationSeconds: number): string {
  if (durationSeconds <= 0) return `${count}`
  const rate = count / durationSeconds
  if (rate >= 1_000_000) return `${(rate / 1_000_000).toFixed(1)}M/s`
  if (rate >= 1_000) return `${(rate / 1_000).toFixed(1)}k/s`
  if (rate >= 100) return `${rate.toFixed(0)}/s`
  if (rate >= 10) return `${rate.toFixed(1)}/s`
  if (rate >= 1) return `${rate.toFixed(1)}/s`
  if (rate >= 0.01) return `${rate.toFixed(2)}/s`
  return `${rate.toFixed(3)}/s`
}

function formatErrorRate(rate: number): string {
  if (rate < 0.01) return "0%"
  if (rate < 1) return `${rate.toFixed(2)}%`
  return `${rate.toFixed(1)}%`
}

export interface EndpointsTableProps {
  filters?: {
    startTime?: string
    endTime?: string
    services?: string[]
    httpMethods?: string[]
    environments?: string[]
  }
}

function LoadingState() {
  return (
    <div className="rounded-md border">
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[80px]">Method</TableHead>
            <TableHead>Endpoint</TableHead>
            <TableHead className="w-[140px]">Service</TableHead>
            <TableHead className="w-[80px] text-right">P50</TableHead>
            <TableHead className="w-[80px] text-right">P95</TableHead>
            <TableHead className="w-[80px] text-right">P99</TableHead>
            <TableHead className="w-[140px]">Throughput</TableHead>
            <TableHead className="w-[140px]">Error Rate</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 8 }).map((_, i) => (
            <TableRow key={i}>
              <TableCell><Skeleton className="h-5 w-12" /></TableCell>
              <TableCell className="truncate max-w-0"><Skeleton className="h-4 w-48" /></TableCell>
              <TableCell><Skeleton className="h-4 w-24" /></TableCell>
              <TableCell><Skeleton className="h-4 w-14 ml-auto" /></TableCell>
              <TableCell><Skeleton className="h-4 w-14 ml-auto" /></TableCell>
              <TableCell><Skeleton className="h-4 w-14 ml-auto" /></TableCell>
              <TableCell><Skeleton className="h-8 w-full" /></TableCell>
              <TableCell><Skeleton className="h-8 w-full" /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function endpointKey(endpoint: HttpEndpointOverview): string {
  return `${endpoint.serviceName}::${endpoint.endpointName}::${endpoint.httpMethod}`
}

export function EndpointsTable({ filters }: EndpointsTableProps) {
  const { startTime: effectiveStartTime, endTime: effectiveEndTime } =
    useEffectiveTimeRange(filters?.startTime, filters?.endTime)

  const durationSeconds = Math.max(
    (new Date(effectiveEndTime).getTime() - new Date(effectiveStartTime).getTime()) / 1000,
    1,
  )

  const overviewResult = useAtomValue(
    getHttpEndpointsOverviewResultAtom({
      data: {
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
        services: filters?.services,
        httpMethods: filters?.httpMethods,
        environments: filters?.environments,
      },
    }),
  )

  const sparklinesResult = useAtomValue(
    getHttpEndpointsSparklinesResultAtom({
      data: {
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
        services: filters?.services,
        httpMethods: filters?.httpMethods,
        environments: filters?.environments,
      },
    }),
  )

  return Result.builder(Result.all([overviewResult, sparklinesResult]))
    .onInitial(() => <LoadingState />)
    .onError((error) => (
      <div className="rounded-md border border-red-500/50 bg-red-500/10 p-8">
        <p className="font-medium text-red-600">Failed to load endpoints</p>
        <pre className="mt-2 text-xs text-red-500 whitespace-pre-wrap">{error.message}</pre>
      </div>
    ))
    .onSuccess(([overviewResponse, sparklinesResponse], combinedResult) => {
      const endpoints = overviewResponse.data
      const sparklinesMap = sparklinesResponse.data

      return (
        <div className={`space-y-4 transition-opacity ${combinedResult.waiting ? "opacity-60" : ""}`}>
          <div className="rounded-md border">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[80px]">Method</TableHead>
                  <TableHead>Endpoint</TableHead>
                  <TableHead className="w-[140px]">Service</TableHead>
                  <TableHead className="w-[80px] text-right">P50</TableHead>
                  <TableHead className="w-[80px] text-right">P95</TableHead>
                  <TableHead className="w-[80px] text-right">P99</TableHead>
                  <TableHead className="w-[140px]">Throughput</TableHead>
                  <TableHead className="w-[140px]">Error Rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {endpoints.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="h-24 text-center">
                      No HTTP endpoints found in traces
                    </TableCell>
                  </TableRow>
                ) : (
                  endpoints.map((endpoint: HttpEndpointOverview) => {
                    const key = endpointKey(endpoint)
                    const series = sparklinesMap[key]
                    const throughputData = series?.map((p) => ({ value: p.throughput })) ?? []
                    const errorRateData = series?.map((p) => ({ value: p.errorRate })) ?? []

                    return (
                      <TableRow
                        key={key}
                        className="hover:bg-muted/50"
                      >
                        <TableCell>
                          <MethodBadge method={endpoint.httpMethod} />
                        </TableCell>
                        <TableCell className="truncate max-w-0">
                          <Link
                            to="/endpoints/detail"
                            search={{
                              service: endpoint.serviceName,
                              endpoint: endpoint.endpointName,
                              method: endpoint.httpMethod,
                              startTime: filters?.startTime,
                              endTime: filters?.endTime,
                            }}
                            className="font-mono text-sm text-primary hover:underline"
                            title={endpoint.endpointName}
                          >
                            {endpoint.endpointName}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Link
                            to="/services/$serviceName"
                            params={{ serviceName: endpoint.serviceName }}
                            search={{
                              startTime: filters?.startTime,
                              endTime: filters?.endTime,
                            }}
                            className="text-sm text-muted-foreground hover:text-primary hover:underline"
                          >
                            {endpoint.serviceName}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {formatLatency(endpoint.p50Duration)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {formatLatency(endpoint.p95Duration)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {formatLatency(endpoint.p99Duration)}
                        </TableCell>
                        <TableCell>
                          <div className="relative h-8 w-full">
                            <Sparkline
                              data={throughputData}
                              color="var(--color-primary, #3b82f6)"
                              className="absolute inset-0 h-full w-full"
                            />
                            <div className="absolute inset-0 flex items-center justify-center">
                              <span className="font-mono text-xs font-semibold [text-shadow:0_0_6px_var(--background),0_0_12px_var(--background),0_0_18px_var(--background)]">
                                {formatThroughput(endpoint.count, durationSeconds)}
                              </span>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="relative h-8 w-full">
                            <Sparkline
                              data={errorRateData}
                              color="var(--color-destructive, #ef4444)"
                              className="absolute inset-0 h-full w-full"
                            />
                            <div className="absolute inset-0 flex items-center justify-center">
                              <span className="font-mono text-xs font-semibold [text-shadow:0_0_6px_var(--background),0_0_12px_var(--background),0_0_18px_var(--background)]">
                                {formatErrorRate(endpoint.errorRate)}
                              </span>
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>

          <div className="text-sm text-muted-foreground">
            Showing {endpoints.length} endpoint{endpoints.length !== 1 ? "s" : ""}
          </div>
        </div>
      )
    })
    .render()
}
