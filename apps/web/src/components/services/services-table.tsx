import React from "react"
import { Result } from "@effect-atom/atom-react"
import { Link, useNavigate } from "@tanstack/react-router"

import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@maple/ui/components/ui/table"
import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Sparkline } from "@maple/ui/components/ui/gradient-chart"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@maple/ui/components/ui/tooltip"
import {
  type ServiceOverview,
  type CommitBreakdown,
} from "@/api/tinybird/services"
import {
  getCustomChartServiceSparklinesResultAtom,
  getServiceOverviewResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"
import type { ServicesSearchParams } from "@/routes/services/index"

function formatLatency(ms: number): string {
  if (ms == null || Number.isNaN(ms)) {
    return "-"
  }
  if (ms < 1) {
    return `${(ms * 1000).toFixed(0)}μs`
  }
  if (ms < 1000) {
    return `${ms.toFixed(1)}ms`
  }
  return `${(ms / 1000).toFixed(2)}s`
}

function formatThroughput(rate: number): string {
  if (rate == null || Number.isNaN(rate) || rate === 0) {
    return "0/s"
  }
  if (rate >= 1000) {
    return `${(rate / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k/s`
  }
  if (rate >= 1) {
    return `${rate.toLocaleString(undefined, { maximumFractionDigits: 1 })}/s`
  }
  return `${rate.toLocaleString(undefined, { maximumFractionDigits: 3 })}/s`
}

function formatErrorRate(rate: number): string {
  if (rate < 0.01) {
    return "0%"
  }
  if (rate < 1) {
    return `${rate.toFixed(2)}%`
  }
  return `${rate.toFixed(1)}%`
}

const ENVIRONMENT_PRIORITY: Record<string, number> = {
  production: 0,
  staging: 1,
  development: 2,
}

function groupByEnvironment(services: ServiceOverview[]): [string, ServiceOverview[]][] {
  const groups = new Map<string, ServiceOverview[]>()
  for (const service of services) {
    const env = service.environment
    if (!groups.has(env)) groups.set(env, [])
    groups.get(env)!.push(service)
  }
  return [...groups.entries()].sort(([a], [b]) => {
    const pa = ENVIRONMENT_PRIORITY[a.toLowerCase()] ?? (a === "unknown" ? 999 : 3)
    const pb = ENVIRONMENT_PRIORITY[b.toLowerCase()] ?? (b === "unknown" ? 999 : 3)
    if (pa !== pb) return pa - pb
    return a.localeCompare(b)
  })
}

function truncateCommitSha(sha: string, length = 7): string {
  if (sha === "N/A" || sha === "unknown" || !sha) {
    return "N/A"
  }
  if (sha.length <= length) return sha
  return sha.slice(0, length)
}

function CommitsList({ commits }: { commits: CommitBreakdown[] }) {
  if (commits.length === 0) {
    return <span className="text-muted-foreground">N/A</span>
  }

  if (commits.length === 1) {
    const sha = commits[0].commitSha
    return <span>{truncateCommitSha(sha)}</span>
  }

  const top2 = commits.slice(0, 2)
  const remaining = commits.length - 2

  return (
    <Tooltip>
      <TooltipTrigger className="flex flex-wrap items-center gap-1">
        {top2.map((c) => (
          <span key={c.commitSha} className="inline-flex items-center gap-0.5">
            <span>{truncateCommitSha(c.commitSha)}</span>
            <Badge variant="secondary" className="px-1 py-0 text-[10px] leading-tight">
              {c.percentage}%
            </Badge>
          </span>
        ))}
        {remaining > 0 && (
          <span className="text-muted-foreground text-[10px]">+{remaining} more</span>
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        <div className="flex flex-col gap-1">
          {commits.map((c) => (
            <div key={c.commitSha} className="flex items-center justify-between gap-3">
              <span className="font-mono">{truncateCommitSha(c.commitSha)}</span>
              <span>{c.percentage}%</span>
            </div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function EnvironmentBadge({ environment }: { environment: string }) {
  const getVariant = () => {
    switch (environment.toLowerCase()) {
      case "production":
        return "bg-severity-warn/15 text-severity-warn"
      case "staging":
        return "bg-chart-p50/15 text-chart-p50"
      case "development":
        return "bg-severity-debug/15 text-severity-debug"
      default:
        return ""
    }
  }

  return (
    <Badge variant="secondary" className={getVariant()}>
      {environment}
    </Badge>
  )
}

interface ServicesTableProps {
  filters?: ServicesSearchParams
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Service</TableHead>
              <TableHead className="w-[90px]">P50</TableHead>
              <TableHead className="w-[90px]">P95</TableHead>
              <TableHead className="w-[90px]">P99</TableHead>
              <TableHead className="w-[180px]">Error Rate</TableHead>
              <TableHead className="w-[180px]">Throughput</TableHead>
              <TableHead className="w-[140px]">Commit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 5 }).map((_, i) => (
              <TableRow key={i}>
                <TableCell>
                  <Skeleton className="h-4 w-32" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-14" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-14" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-14" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-8 w-full" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-8 w-full" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-16" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

export function ServicesTable({ filters }: ServicesTableProps) {
  const navigate = useNavigate()
  const { startTime: effectiveStartTime, endTime: effectiveEndTime } =
    useEffectiveTimeRange(filters?.startTime, filters?.endTime, filters?.timePreset ?? "12h")

  const overviewResult = useRefreshableAtomValue(
    getServiceOverviewResultAtom({
      data: {
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
        environments: filters?.environments,
        commitShas: filters?.commitShas,
      },
    }),
  )

  const timeSeriesResult = useRefreshableAtomValue(
    getCustomChartServiceSparklinesResultAtom({
      data: {
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
        environments: filters?.environments,
        commitShas: filters?.commitShas,
      },
    }),
  )

  return Result.builder(Result.all([overviewResult, timeSeriesResult]))
    .onInitial(() => <LoadingState />)
    .onError((error) => (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-8">
        <p className="font-medium text-destructive">Failed to load services</p>
        <pre className="mt-2 text-xs text-destructive/80 whitespace-pre-wrap">{error.message}</pre>
      </div>
    ))
    .onSuccess(([overviewResponse, timeSeriesResponse], combinedResult) => {
      const services = overviewResponse.data
      const timeSeriesMap = timeSeriesResponse.data

      return (
        <div className={`space-y-4 transition-opacity ${combinedResult.waiting ? "opacity-60" : ""}`}>
          <div className="rounded-md border">
            <Table aria-label="Services">
              <TableHeader>
                <TableRow>
                  <TableHead>Service</TableHead>
                  <TableHead className="hidden lg:table-cell w-[90px]">P50</TableHead>
                  <TableHead className="hidden lg:table-cell w-[90px]">P95</TableHead>
                  <TableHead className="w-[90px]">P99</TableHead>
                  <TableHead className="w-[180px]">Error Rate</TableHead>
                  <TableHead className="hidden md:table-cell w-[180px]">Throughput</TableHead>
                  <TableHead className="hidden lg:table-cell w-[140px]">Commit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {services.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center">
                      No services found
                    </TableCell>
                  </TableRow>
                ) : (
                  groupByEnvironment(services).map(([environment, envServices]) => (
                    <React.Fragment key={environment}>
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableCell colSpan={7} className="py-2">
                          <div className="flex items-center gap-2">
                            <EnvironmentBadge environment={environment} />
                            <span className="text-xs text-muted-foreground">
                              {envServices.length} {envServices.length === 1 ? "service" : "services"}
                            </span>
                          </div>
                        </TableCell>
                      </TableRow>
                      {envServices.map((service: ServiceOverview) => {
                        const serviceSeries = timeSeriesMap[service.serviceName]
                        const throughputData = serviceSeries?.map((p) => ({ value: p.throughput })) ?? []
                        const errorRateData = serviceSeries?.map((p) => ({ value: p.errorRate })) ?? []

                        return (
                          <TableRow
                            key={`${service.serviceName}-${service.environment}`}
                            className="cursor-pointer hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
                            tabIndex={0}
                            onClick={() => navigate({
                              to: "/services/$serviceName",
                              params: { serviceName: service.serviceName },
                              search: {
                                    startTime: filters?.startTime,
                                    endTime: filters?.endTime,
                                    timePreset: filters?.timePreset,
                                  },
                            })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault()
                                navigate({
                                  to: "/services/$serviceName",
                                  params: { serviceName: service.serviceName },
                                  search: {
                                    startTime: filters?.startTime,
                                    endTime: filters?.endTime,
                                    timePreset: filters?.timePreset,
                                  },
                                })
                              }
                            }}
                          >
                            <TableCell>
                              <Link
                                to="/services/$serviceName"
                                params={{ serviceName: service.serviceName }}
                                search={{
                                  startTime: filters?.startTime,
                                  endTime: filters?.endTime,
                                  timePreset: filters?.timePreset,
                                }}
                                className="font-medium text-primary hover:underline"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {service.serviceName}
                              </Link>
                            </TableCell>
                            <TableCell className="hidden lg:table-cell font-mono text-xs">
                              {formatLatency(service.p50LatencyMs)}
                            </TableCell>
                            <TableCell className="hidden lg:table-cell font-mono text-xs">
                              {formatLatency(service.p95LatencyMs)}
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {formatLatency(service.p99LatencyMs)}
                            </TableCell>
                            <TableCell>
                              <div className="relative w-[120px] h-8" role="img" aria-label={`Error rate: ${formatErrorRate(service.errorRate)}`}>
                                <Sparkline
                                  data={errorRateData}
                                  color="var(--color-destructive, #ef4444)"
                                  className="absolute inset-0 h-full w-full"
                                />
                                <div className="absolute inset-0 flex items-center justify-center">
                                  <span className="font-mono text-xs font-semibold [text-shadow:0_0_6px_var(--background),0_0_12px_var(--background),0_0_18px_var(--background)]">
                                    {formatErrorRate(service.errorRate)}
                                  </span>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell className="hidden md:table-cell">
                              <Tooltip>
                                <TooltipTrigger className="relative w-[120px] h-8 block" aria-label={`Throughput: ${formatThroughput(service.throughput)}`}>
                                  <Sparkline
                                    data={throughputData}
                                    color="var(--color-primary, #3b82f6)"
                                    className="absolute inset-0 h-full w-full"
                                  />
                                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                                    <span className="font-mono text-xs font-semibold [text-shadow:0_0_6px_var(--background),0_0_12px_var(--background),0_0_18px_var(--background)]">
                                      {service.hasSampling ? "~" : ""}{formatThroughput(service.throughput)}
                                    </span>
                                    {service.hasSampling && (
                                      <span className="font-mono text-[9px] text-muted-foreground [text-shadow:0_0_6px_var(--background),0_0_12px_var(--background),0_0_18px_var(--background)]">
                                        ~{formatThroughput(service.tracedThroughput)} traced
                                      </span>
                                    )}
                                  </div>
                                </TooltipTrigger>
                                {service.hasSampling && (
                                  <TooltipContent side="bottom">
                                    <p>Estimated from {((1 / service.samplingWeight) * 100).toFixed(0)}% sampled traces (x{service.samplingWeight.toFixed(0)} extrapolation)</p>
                                  </TooltipContent>
                                )}
                              </Tooltip>
                            </TableCell>
                            <TableCell className="hidden lg:table-cell font-mono text-xs text-muted-foreground">
                              <CommitsList commits={service.commits} />
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </React.Fragment>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <div className="text-sm text-muted-foreground">Showing {services.length} services</div>
        </div>
      )
    })
    .render()
}
