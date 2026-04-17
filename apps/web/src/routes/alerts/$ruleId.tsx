import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"
import { useMemo, useState } from "react"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { AlertPreviewChart } from "@/components/alerts/alert-preview-chart"
import { CheckHistoryStrip } from "@/components/alerts/check-history-strip"
import { CheckHistorySparkline } from "@/components/alerts/check-history-sparkline"
import {
  severityTone,
  signalLabels,
  comparatorLabels,
  formatSignalValue,
  defaultRuleForm,
  ruleToFormState,
  formatAlertDateTimeFull,
  formatAlertDuration,
  computeIncidentStats,
} from "@/lib/alerts/form-utils"
import { AlertIncidentDocument, AlertRuleId, type AlertCheckDocument, type AlertRuleDocument } from "@maple/domain/http"
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
import { useAlertRuleChart } from "@/hooks/use-alert-rule-chart"

const tabValues = ["overview", "history", "checks"] as const
type RuleDetailTab = (typeof tabValues)[number]

const RuleDetailSearch = Schema.Struct({
  tab: Schema.optional(Schema.Literals(tabValues)),
})

export const Route = effectRoute(createFileRoute("/alerts/$ruleId"))({
  component: RuleDetailPage,
  validateSearch: Schema.toStandardSchemaV1(RuleDetailSearch),
})


function RuleDetailPage() {
  const { ruleId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  const rulesResult = useAtomValue(MapleApiAtomClient.query("alerts", "listRules", { reactivityKeys: ["alertRules"] }))
  const incidentsResult = useAtomValue(MapleApiAtomClient.query("alerts", "listIncidents", { reactivityKeys: ["alertIncidents"] }))
  const checksResult = useAtomValue(
    MapleApiAtomClient.query("alerts", "listRuleChecks", {
      params: { ruleId: ruleId as AlertRuleId },
      query: {},
      reactivityKeys: ["alertChecks", ruleId],
    }),
  )

  const rules = Result.builder(rulesResult)
    .onSuccess((response) => [...response.rules] as AlertRuleDocument[])
    .orElse(() => [])
  const allIncidents = Result.builder(incidentsResult)
    .onSuccess((response) => [...response.incidents] as AlertIncidentDocument[])
    .orElse(() => [] as AlertIncidentDocument[])
  const checks = Result.builder(checksResult)
    .onSuccess((response) => [...response.checks] as AlertCheckDocument[])
    .orElse(() => [] as AlertCheckDocument[])

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
  const [checkStatusFilter, setCheckStatusFilter] = useState<
    "all" | "breached" | "healthy" | "skipped"
  >("all")

  const filteredIncidents = useMemo(() => {
    if (stateFilter === "all") return ruleIncidents
    return ruleIncidents.filter((i) => i.status === stateFilter)
  }, [ruleIncidents, stateFilter])

  const stats = useMemo(() => computeIncidentStats(ruleIncidents), [ruleIncidents])
  const maxContributorCount = stats.topContributors.length > 0 ? stats.topContributors[0][1] : 1

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

  const formState = useMemo(() => rule ? ruleToFormState(rule) : defaultRuleForm(), [rule])
  const { chartData, chartLoading } = useAlertRuleChart(formState)

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
  const subtitle = `${signalLabels[rule.signalType]} ${comparatorLabels[rule.comparator]} ${formatSignalValue(rule.signalType, rule.threshold)} over ${rule.windowMinutes}min${rule.serviceNames?.length > 0 ? ` on ${rule.serviceNames.join(", ")}` : ""}${rule.excludeServiceNames?.length > 0 ? ` (excl. ${rule.excludeServiceNames.join(", ")})` : ""}`

  const tabBar = (
    <Tabs
      value={activeTab}
      onValueChange={(v) => navigate({ search: (prev) => ({ ...prev, tab: v as RuleDetailTab }) })}
    >
      <TabsList variant="line">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="history">History</TabsTrigger>
        <TabsTrigger value="checks">Checks</TabsTrigger>
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
            <Badge variant="secondary" className="text-xs font-medium">Beta</Badge>
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
        <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/alerts/create" search={{ ruleId: rule.id }} />}>
          <PencilIcon size={14} />
          Edit Rule
        </Button>
      }
      stickyContent={
        <div className="space-y-3">
          {tabBar}
          <div className="space-y-1">
            <div className="flex items-center gap-[3px]">
              {Array.from({ length: 45 }, (_, i) => {
                const totalRange = timelineRange.max - timelineRange.min
                const bucketStart = timelineRange.min + (i / 45) * totalRange
                const bucketEnd = timelineRange.min + ((i + 1) / 45) * totalRange
                const hit = timelineSegments.find(
                  (seg) => seg.end > bucketStart && seg.start < bucketEnd,
                )
                return (
                  <div
                    key={i}
                    className={cn(
                      "h-4 flex-1 rounded-[2px]",
                      hit
                        ? hit.status === "open"
                          ? "bg-destructive"
                          : "bg-destructive/50"
                        : "bg-chart-apdex/60",
                    )}
                  />
                )
              })}
            </div>
            <div className="flex justify-between text-[11px] text-muted-foreground font-mono">
              <span>{new Date(timelineRange.min).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
              <span>{new Date(timelineRange.max).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
            </div>
          </div>
        </div>
      }
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
                  <dt className="text-muted-foreground">Scope</dt>
                  <dd className="flex flex-wrap gap-1 justify-end">
                    {rule.serviceNames?.length > 0
                      ? rule.serviceNames.map((s) => <Badge key={s} variant="outline" className="text-xs">{s}</Badge>)
                      : <span className="font-mono font-medium">{rule.groupBy && rule.groupBy.length > 0 ? `all (per ${rule.groupBy.join(" \u00b7 ")})` : "all"}</span>}
                  </dd>
                </div>
                {rule.excludeServiceNames?.length > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Excluded</dt>
                    <dd className="flex flex-wrap gap-1 justify-end">
                      {rule.excludeServiceNames.map((s) => <Badge key={s} variant="outline" className="text-xs line-through">{s}</Badge>)}
                    </dd>
                  </div>
                )}
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
                  <span className="text-3xl font-bold tabular-nums">{stats.totalTriggered}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">Avg. Resolution Time</span>
                </div>
                <div className="mt-3">
                  <span className="text-3xl font-bold font-mono tabular-nums">{stats.avgResolution}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5">
                <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">Top Contributors</span>
                <div className="mt-3 space-y-2">
                  {stats.topContributors.length === 0 ? (
                    <span className="text-3xl font-bold">—</span>
                  ) : (
                    stats.topContributors.map(([groupKey, count]) => (
                      <div key={groupKey} className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs shrink-0">{groupKey}</Badge>
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
                          {count}/{stats.totalTriggered}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Timeline header + filters */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">Timeline</h2>
                <span className="text-muted-foreground text-sm">{stats.totalTriggered} triggers</span>
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
                  <TableHead className="w-[180px]">Group</TableHead>
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
                        <span className="font-mono text-muted-foreground">{incident.groupKey ?? "all"}</span>
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
                        {formatAlertDateTimeFull(incident.firstTriggeredAt)}
                      </TableCell>
                      <TableCell>
                        <span className={cn("text-sm tabular-nums", isOpen && "text-red-500 font-medium")}>
                          {formatAlertDuration(incident.firstTriggeredAt, incident.resolvedAt)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
                            <DotsVerticalIcon size={14} />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
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

      {/* ─── Checks Sub-Tab ─── */}
      {activeTab === "checks" && (
        <ChecksPanel
          rule={rule}
          checks={checks}
          loading={Result.isInitial(checksResult)}
          statusFilter={checkStatusFilter}
          setStatusFilter={setCheckStatusFilter}
        />
      )}
    </DashboardLayout>
  )
}

function ChecksPanel({
  rule,
  checks,
  loading,
  statusFilter,
  setStatusFilter,
}: {
  rule: AlertRuleDocument
  checks: AlertCheckDocument[]
  loading: boolean
  statusFilter: "all" | "breached" | "healthy" | "skipped"
  setStatusFilter: (v: "all" | "breached" | "healthy" | "skipped") => void
}) {
  const totals = useMemo(() => {
    let breached = 0
    let healthy = 0
    let skipped = 0
    let transitions = 0
    for (const c of checks) {
      if (c.status === "breached") breached += 1
      else if (c.status === "healthy") healthy += 1
      else skipped += 1
      if (c.incidentTransition !== "none") transitions += 1
    }
    return { breached, healthy, skipped, transitions, total: checks.length }
  }, [checks])

  const filteredChecks = useMemo(() => {
    if (statusFilter === "all") return checks
    return checks.filter((c) => c.status === statusFilter)
  }, [checks, statusFilter])

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (checks.length === 0) {
    return (
      <Empty className="py-12">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CheckIcon size={18} />
          </EmptyMedia>
          <EmptyTitle>No checks recorded yet</EmptyTitle>
          <EmptyDescription>
            Once this rule is evaluated the scheduler will record one check per minute here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="space-y-6">
      {/* Stats row */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-5">
            <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
              Total Checks
            </span>
            <div className="mt-3">
              <span className="text-3xl font-bold tabular-nums">{totals.total}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
              Breached
            </span>
            <div className="mt-3">
              <span className="text-3xl font-bold tabular-nums text-red-500">
                {totals.breached}
              </span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
              Healthy
            </span>
            <div className="mt-3">
              <span className="text-3xl font-bold tabular-nums text-emerald-500">
                {totals.healthy}
              </span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
              Incident transitions
            </span>
            <div className="mt-3">
              <span className="text-3xl font-bold tabular-nums">{totals.transitions}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Status strip */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Status timeline</h2>
          <span className="text-xs text-muted-foreground">
            {totals.total} checks · oldest → newest
          </span>
        </div>
        <CheckHistoryStrip checks={checks} signalType={rule.signalType} />
      </div>

      {/* Sparkline */}
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Observed value</h2>
        <div className="rounded-md border bg-card p-4">
          <CheckHistorySparkline
            checks={checks}
            threshold={rule.threshold}
            signalType={rule.signalType}
            className="h-[200px] w-full"
          />
        </div>
      </div>

      {/* Filters + table */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Checks</h2>
          <div className="flex gap-1">
            {(["all", "breached", "healthy", "skipped"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setStatusFilter(f)}
                className={cn(
                  "rounded-md border px-3 py-1 text-xs font-medium transition-colors capitalize",
                  statusFilter === f
                    ? "border-foreground/20 bg-foreground/5 text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[180px]">Time</TableHead>
              <TableHead className="w-[100px]">Status</TableHead>
              <TableHead className="w-[100px]">Value</TableHead>
              <TableHead className="w-[100px]">Threshold</TableHead>
              <TableHead className="w-[90px]">Samples</TableHead>
              <TableHead>Group</TableHead>
              <TableHead className="w-[140px]">Incident</TableHead>
              <TableHead className="w-[80px]">Eval ms</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredChecks.slice(0, 200).map((check, idx) => {
              const tone =
                check.status === "breached"
                  ? "text-red-500"
                  : check.status === "healthy"
                    ? "text-emerald-500"
                    : "text-amber-500"
              const transitionTone =
                check.incidentTransition === "opened"
                  ? "text-red-500"
                  : check.incidentTransition === "resolved"
                    ? "text-emerald-500"
                    : check.incidentTransition === "continued"
                      ? "text-muted-foreground"
                      : ""
              return (
                <TableRow key={`${check.timestamp}-${check.groupKey}-${idx}`}>
                  <TableCell className="font-mono text-xs">
                    {new Date(check.timestamp).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <span className={cn("flex items-center gap-1.5 text-sm", tone)}>
                      <span
                        className={cn(
                          "size-1.5 rounded-full",
                          check.status === "breached"
                            ? "bg-red-500"
                            : check.status === "healthy"
                              ? "bg-emerald-500"
                              : "bg-amber-500",
                        )}
                      />
                      <span className="capitalize">{check.status}</span>
                    </span>
                  </TableCell>
                  <TableCell className="font-mono tabular-nums">
                    {check.observedValue == null
                      ? "—"
                      : formatSignalValue(rule.signalType, check.observedValue)}
                  </TableCell>
                  <TableCell className="font-mono tabular-nums text-muted-foreground">
                    {formatSignalValue(rule.signalType, check.threshold)}
                  </TableCell>
                  <TableCell className="tabular-nums">{check.sampleCount}</TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {check.groupKey || "all"}
                  </TableCell>
                  <TableCell>
                    {check.incidentTransition === "none" ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <Badge variant="outline" className={cn("text-xs capitalize", transitionTone)}>
                        {check.incidentTransition}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {check.evaluationDurationMs}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        {filteredChecks.length > 200 && (
          <p className="text-xs text-muted-foreground text-center">
            Showing first 200 of {filteredChecks.length} matching checks.
          </p>
        )}
      </div>
    </div>
  )
}
