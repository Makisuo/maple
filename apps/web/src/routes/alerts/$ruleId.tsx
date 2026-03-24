import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Atom, Result, useAtomValue } from "@/lib/effect-atom"
import { Schema } from "effect"
import { useMemo, useState } from "react"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { AlertPreviewChart } from "@/components/alerts/alert-preview-chart"
import {
  severityTone,
  signalLabels,
  comparatorLabels,
  formatSignalValue,
  signalToQueryParams,
  defaultRuleForm,
  ruleToFormState,
} from "@/lib/alerts/form-utils"
import type { AlertRuleDocument } from "@maple/domain/http"
import {
  CheckIcon,
  PencilIcon,
  DotsVerticalIcon,
} from "@/components/icons"
import { cn } from "@maple/ui/utils"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent } from "@maple/ui/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@maple/ui/components/ui/table"
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@maple/ui/components/ui/tabs"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { getCustomChartTimeSeriesResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { computeBucketSeconds } from "@/api/tinybird/timeseries-utils"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"

const tabValues = ["overview", "history"] as const
type RuleDetailTab = (typeof tabValues)[number]

const RuleDetailSearch = Schema.Struct({
  tab: Schema.optional(Schema.Literals(tabValues)),
})

export const Route = createFileRoute("/alerts/$ruleId")({
  component: RuleDetailPage,
  validateSearch: Schema.toStandardSchemaV1(RuleDetailSearch),
})

function formatDuration(startStr: string | null, endStr: string | null): string {
  if (!startStr) return "—"
  const start = new Date(startStr).getTime()
  const end = endStr ? new Date(endStr).getTime() : Date.now()
  const diffMs = end - start
  if (diffMs < 0) return "—"
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  const remainMins = mins % 60
  if (hours < 24) return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

function formatDateTimeFull(value: string | null): string {
  if (!value) return "—"
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

const CHART_BUCKET_TARGET = 96
const emptyChartAtom = Atom.make(Result.initial())

function RuleDetailPage() {
  const { ruleId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  const rulesResult = useAtomValue(MapleApiAtomClient.query("alerts", "listRules", {}))
  const incidentsResult = useAtomValue(MapleApiAtomClient.query("alerts", "listIncidents", {}))

  const rules = Result.builder(rulesResult)
    .onSuccess((response) => [...response.rules] as AlertRuleDocument[])
    .orElse(() => [])
  const allIncidents = Result.builder(incidentsResult)
    .onSuccess((response) => [...response.incidents])
    .orElse(() => [])

  const rule = useMemo(() => rules.find((r) => r.id === ruleId) ?? null, [rules, ruleId])

  const ruleIncidents = useMemo(
    () => allIncidents.filter((i) => i.ruleId === ruleId).sort((a, b) => {
      const dateA = a.lastTriggeredAt ? new Date(a.lastTriggeredAt).getTime() : 0
      const dateB = b.lastTriggeredAt ? new Date(b.lastTriggeredAt).getTime() : 0
      return dateB - dateA
    }),
    [allIncidents, ruleId],
  )

  const activeTab: RuleDetailTab = tabValues.includes(search.tab as RuleDetailTab)
    ? (search.tab as RuleDetailTab)
    : "overview"

  const [stateFilter, setStateFilter] = useState<"all" | "open" | "resolved">("all")

  const filteredIncidents = useMemo(() => {
    if (stateFilter === "all") return ruleIncidents
    return ruleIncidents.filter((i) => i.status === stateFilter)
  }, [ruleIncidents, stateFilter])

  // Stats
  const totalTriggered = ruleIncidents.length
  const resolvedIncidents = ruleIncidents.filter((i) => i.resolvedAt && i.firstTriggeredAt)
  const avgResolutionMs = resolvedIncidents.length > 0
    ? resolvedIncidents.reduce((sum, i) => {
        const start = new Date(i.firstTriggeredAt!).getTime()
        const end = new Date(i.resolvedAt!).getTime()
        return sum + (end - start)
      }, 0) / resolvedIncidents.length
    : 0

  const avgResolution = avgResolutionMs > 0
    ? avgResolutionMs < 60_000 ? `${Math.round(avgResolutionMs / 1000)}s`
      : avgResolutionMs < 3_600_000 ? `${(avgResolutionMs / 60_000).toFixed(1)}m`
      : `${(avgResolutionMs / 3_600_000).toFixed(1)}h`
    : "—"

  // Top contributors by service
  const topContributors = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const i of ruleIncidents) {
      const svc = i.serviceName ?? "unknown"
      counts[svc] = (counts[svc] ?? 0) + 1
    }
    return Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
  }, [ruleIncidents])

  const maxContributorCount = topContributors.length > 0 ? topContributors[0][1] : 1

  // Timeline bar segments
  const timelineSegments = useMemo(() => {
    if (ruleIncidents.length === 0) return []
    const sorted = [...ruleIncidents].sort((a, b) => {
      const ta = a.firstTriggeredAt ? new Date(a.firstTriggeredAt).getTime() : 0
      const tb = b.firstTriggeredAt ? new Date(b.firstTriggeredAt).getTime() : 0
      return ta - tb
    })
    return sorted.map((i) => ({
      status: i.status as "open" | "resolved",
      start: i.firstTriggeredAt ? new Date(i.firstTriggeredAt).getTime() : Date.now(),
      end: i.resolvedAt ? new Date(i.resolvedAt).getTime() : Date.now(),
    }))
  }, [ruleIncidents])

  const timelineRange = useMemo(() => {
    if (timelineSegments.length === 0) return { min: Date.now() - 86_400_000 * 3, max: Date.now() }
    const starts = timelineSegments.map((s) => s.start)
    const ends = timelineSegments.map((s) => s.end)
    return { min: Math.min(...starts), max: Math.max(...ends, Date.now()) }
  }, [timelineSegments])

  // Overview tab chart
  const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, "24h")
  const bucketSeconds = useMemo(
    () => computeBucketSeconds(startTime, endTime, CHART_BUCKET_TARGET),
    [startTime, endTime],
  )

  const formState = useMemo(() => rule ? ruleToFormState(rule) : defaultRuleForm(), [rule])
  const queryParams = useMemo(() => signalToQueryParams(formState), [formState])

  const chartGroupBy = rule?.groupBy === "service" && !rule?.serviceName
    ? "service" as const
    : "none" as const

  const chartQueryInput = useMemo(() => {
    if (!queryParams) return null
    return {
      data: {
        source: queryParams.source as "traces" | "logs" | "metrics",
        metric: queryParams.metric,
        groupBy: chartGroupBy,
        startTime,
        endTime,
        bucketSeconds,
        filters: queryParams.filters as Record<string, string | boolean | string[] | undefined>,
      },
    }
  }, [queryParams, startTime, endTime, bucketSeconds, chartGroupBy])

  const chartResult = useAtomValue(
    chartQueryInput
      ? getCustomChartTimeSeriesResultAtom(chartQueryInput)
      : emptyChartAtom,
  )

  const chartData = useMemo(() => {
    if (!chartQueryInput) return []
    return Result.builder(chartResult)
      .onSuccess((response) =>
        response.data.map((point) => ({ bucket: point.bucket, ...point.series })),
      )
      .orElse(() => [])
  }, [chartResult, chartQueryInput])

  const chartLoading = !chartQueryInput || Result.isInitial(chartResult)

  if (Result.isInitial(rulesResult)) {
    return (
      <DashboardLayout breadcrumbs={[{ label: "Alert Rules", href: "/alerts?tab=rules" }, { label: "Loading..." }]}>
        <div className="space-y-4">
          <Skeleton className="h-12 w-1/3" />
          <Skeleton className="h-48 w-full" />
        </div>
      </DashboardLayout>
    )
  }

  if (!rule) {
    return (
      <DashboardLayout breadcrumbs={[{ label: "Alert Rules", href: "/alerts?tab=rules" }, { label: "Not Found" }]} title="Rule not found">
        <div className="text-muted-foreground py-12 text-center">
          This alert rule could not be found. It may have been deleted.
        </div>
      </DashboardLayout>
    )
  }

  const isFiring = ruleIncidents.some((i) => i.status === "open")
  const subtitle = `${signalLabels[rule.signalType]} ${comparatorLabels[rule.comparator]} ${formatSignalValue(rule.signalType, rule.threshold)} over ${rule.windowMinutes}min${rule.serviceName ? ` on ${rule.serviceName}` : ""}`

  const tabBar = (
    <Tabs
      value={activeTab}
      onValueChange={(v) => navigate({ search: (prev) => ({ ...prev, tab: v as RuleDetailTab }) })}
    >
      <TabsList variant="line">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="history">History</TabsTrigger>
      </TabsList>
    </Tabs>
  )

  return (
    <DashboardLayout
      breadcrumbs={[
        { label: "Alert Rules", href: "/alerts?tab=rules" },
        { label: rule.name },
      ]}
      titleContent={
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight truncate">{rule.name}</h1>
            <Badge variant="outline" className={severityTone[rule.severity]}>
              {rule.severity === "critical" ? "Critical" : "Warning"}
            </Badge>
            {isFiring && (
              <span className="flex items-center gap-1.5 text-sm">
                <span className="size-1.5 rounded-full bg-red-500" />
                <span className="text-red-500 font-medium">Firing</span>
              </span>
            )}
          </div>
          <p className="text-muted-foreground mt-0.5">{subtitle}</p>
        </div>
      }
      headerActions={
        <Button variant="outline" size="sm" render={<Link to="/alerts/create" search={{ ruleId: rule.id }} />}>
          <PencilIcon size={14} />
          Edit Rule
        </Button>
      }
      stickyContent={tabBar}
    >
      {/* ─── Overview Sub-Tab ─── */}
      {activeTab === "overview" && (
        <div className="space-y-6">
          <div className="space-y-2">
            <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
              {signalLabels[rule.signalType]} — Last 24h
            </span>
            <AlertPreviewChart
              data={chartData}
              threshold={rule.threshold}
              signalType={rule.signalType}
              loading={chartLoading}
              className="h-[300px] w-full"
            />
          </div>

          <Card>
            <CardContent className="p-5">
              <h3 className="text-sm font-semibold mb-3">Rule Configuration</h3>
              <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Signal</dt>
                  <dd className="font-medium">{signalLabels[rule.signalType]}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Service</dt>
                  <dd className="font-mono font-medium">
                    {rule.serviceName ?? (rule.groupBy === "service" ? "all (per service)" : "all")}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Condition</dt>
                  <dd className="font-mono font-medium">
                    {comparatorLabels[rule.comparator]} {formatSignalValue(rule.signalType, rule.threshold)} / {rule.windowMinutes}min
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Severity</dt>
                  <dd className={cn("font-medium capitalize", rule.severity === "critical" ? "text-red-500" : "text-yellow-500")}>
                    {rule.severity}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Consecutive breaches</dt>
                  <dd className="font-medium">{rule.consecutiveBreachesRequired}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Healthy to resolve</dt>
                  <dd className="font-medium">{rule.consecutiveHealthyRequired}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Min samples</dt>
                  <dd className="font-medium">{rule.minimumSampleCount}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Renotify interval</dt>
                  <dd className="font-medium">{rule.renotifyIntervalMinutes}min</dd>
                </div>
                {rule.signalType === "query" && rule.queryDataSource && (
                  <>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Data source</dt>
                      <dd className="font-mono font-medium capitalize">{rule.queryDataSource}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Aggregation</dt>
                      <dd className="font-mono font-medium">{rule.queryAggregation}</dd>
                    </div>
                    {rule.queryWhereClause && (
                      <div className="flex justify-between col-span-2">
                        <dt className="text-muted-foreground">Where</dt>
                        <dd className="font-mono font-medium text-right">{rule.queryWhereClause}</dd>
                      </div>
                    )}
                  </>
                )}
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Destinations</dt>
                  <dd className="font-medium">{rule.destinationIds.length} configured</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Status</dt>
                  <dd className="font-medium">{rule.enabled ? "Enabled" : "Disabled"}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ─── History Sub-Tab ─── */}
      {activeTab === "history" && (
        <div className="space-y-6">
          {/* Stats row */}
          <div className="grid grid-cols-3 gap-4">
            <Card>
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">Total Triggered</span>
                </div>
                <div className="mt-3">
                  <span className="text-3xl font-bold tabular-nums">{totalTriggered}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">Avg. Resolution Time</span>
                </div>
                <div className="mt-3">
                  <span className="text-3xl font-bold font-mono tabular-nums">{avgResolution}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5">
                <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">Top Contributors</span>
                <div className="mt-3 space-y-2">
                  {topContributors.length === 0 ? (
                    <span className="text-3xl font-bold">—</span>
                  ) : (
                    topContributors.map(([service, count]) => (
                      <div key={service} className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs shrink-0">{service}</Badge>
                        <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                          <div
                            className={cn(
                              "h-full rounded-full",
                              count === maxContributorCount ? "bg-red-500" : "bg-orange-500",
                            )}
                            style={{ width: `${(count / maxContributorCount) * 100}%` }}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                          {count}/{totalTriggered}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Timeline */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">Timeline</h2>
                <span className="text-muted-foreground text-sm">{totalTriggered} triggers</span>
              </div>
              <div className="flex gap-1">
                {(["all", "open", "resolved"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setStateFilter(f)}
                    className={cn(
                      "rounded-md border px-3 py-1 text-xs font-medium transition-colors",
                      stateFilter === f
                        ? "border-foreground/20 bg-foreground/5 text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {f === "all" ? "All" : f === "open" ? "Fired" : "Resolved"}
                  </button>
                ))}
              </div>
            </div>

            {/* Timeline bar */}
            {timelineSegments.length > 0 && (
              <div className="space-y-1">
                <div className="relative h-5 rounded overflow-hidden bg-green-500/20">
                  {timelineSegments.map((seg, idx) => {
                    const totalRange = timelineRange.max - timelineRange.min
                    if (totalRange <= 0) return null
                    const leftPct = ((seg.start - timelineRange.min) / totalRange) * 100
                    const widthPct = Math.max(((seg.end - seg.start) / totalRange) * 100, 0.5)
                    return (
                      <div
                        key={idx}
                        className={cn(
                          "absolute h-5",
                          seg.status === "open" ? "bg-red-500" : "bg-red-500/60",
                        )}
                        style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                      />
                    )
                  })}
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{new Date(timelineRange.min).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                  <span>{new Date(timelineRange.max).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                </div>
              </div>
            )}
          </div>

          {/* Event table */}
          {filteredIncidents.length === 0 ? (
            <Empty className="py-12">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CheckIcon size={18} />
                </EmptyMedia>
                <EmptyTitle>No incidents</EmptyTitle>
                <EmptyDescription>
                  This rule hasn't triggered any incidents yet.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[90px]">State</TableHead>
                  <TableHead className="w-[140px]">Service</TableHead>
                  <TableHead>Labels</TableHead>
                  <TableHead className="w-[160px]">Triggered At</TableHead>
                  <TableHead className="w-[100px]">Duration</TableHead>
                  <TableHead className="w-[50px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredIncidents.map((incident) => {
                  const isOpen = incident.status === "open"
                  return (
                    <TableRow key={incident.id}>
                      <TableCell>
                        <span className="flex items-center gap-1.5 text-sm">
                          <span className={cn("size-1.5 rounded-full", isOpen ? "bg-red-500" : "bg-green-500")} />
                          <span className={cn(isOpen ? "text-red-500 font-medium" : "text-green-500")}>
                            {isOpen ? "Firing" : "Resolved"}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-muted-foreground">{incident.serviceName ?? "all"}</span>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <Badge variant="secondary" className="text-xs font-mono">
                            {rule.signalType.replace("_", " ")}: {formatSignalValue(rule.signalType, incident.lastObservedValue)}
                          </Badge>
                          <Badge variant="secondary" className="text-xs font-mono">
                            threshold: {formatSignalValue(rule.signalType, incident.threshold)}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {formatDateTimeFull(incident.firstTriggeredAt)}
                      </TableCell>
                      <TableCell>
                        <span className={cn("text-sm tabular-nums", isOpen && "text-red-500 font-medium")}>
                          {formatDuration(incident.firstTriggeredAt, incident.resolvedAt)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
                            <DotsVerticalIcon size={14} />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {incident.serviceName && (
                              <DropdownMenuItem
                                onClick={() => navigate({ to: "/services/$serviceName", params: { serviceName: incident.serviceName! } })}
                              >
                                View Service
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              onClick={() => navigate({ to: "/alerts", search: { tab: "incidents" } })}
                            >
                              View All Incidents
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </div>
      )}
    </DashboardLayout>
  )
}
