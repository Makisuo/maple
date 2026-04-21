import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Exit, Option, Schema } from "effect"
import { useState, useMemo } from "react"
import { toast } from "sonner"

import { DestinationDialog } from "@/components/alerts/destination-dialog"
import { AlertStatusBadge } from "@/components/alerts/alert-status-badge"
import { AlertSeverityBadge } from "@/components/alerts/alert-severity-badge"
import { AlertStatCard, AlertFiringHero } from "@/components/alerts/alert-stat-card"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { formatRelativeTime } from "@/lib/format"
import {
  AlertDeliveryEventDocument,
  AlertDestinationDocument,
  AlertIncidentDocument,
  AlertRuleDocument,
} from "@maple/domain/http"
import {
  type DestinationFormState,
  signalLabels,
  comparatorLabels,
  destinationTypeLabels,
  formatSignalValue,
  formatAlertDateTime,
  getExitErrorMessage,
  defaultDestinationForm,
  destinationToFormState,
  buildDestinationCreatePayload,
  buildDestinationUpdatePayload,
  buildRuleToggleRequest,
} from "@/lib/alerts/form-utils"
import {
  AlertWarningIcon,
  BellIcon,
  CheckIcon,
  CircleWarningIcon,
  DotsVerticalIcon,
  FireIcon,
  LoaderIcon,
  MagnifierIcon,
  PaperPlaneIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from "@/components/icons"
import { cn } from "@maple/ui/utils"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent } from "@maple/ui/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@maple/ui/components/ui/empty"
import { Input } from "@maple/ui/components/ui/input"
import { Separator } from "@maple/ui/components/ui/separator"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Switch } from "@maple/ui/components/ui/switch"
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

const tabValues = ["monitor", "rules", "settings"] as const
type AlertsTab = (typeof tabValues)[number]

const legacyTabMap: Record<string, AlertsTab> = {
  overview: "monitor",
  monitor: "monitor",
  incidents: "monitor",
  rules: "rules",
  destinations: "settings",
  settings: "settings",
}

const AlertsSearch = Schema.Struct({
  tab: Schema.optional(Schema.String),
  serviceName: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/alerts/"))({
  component: AlertsPage,
  validateSearch: Schema.toStandardSchemaV1(AlertsSearch),
})

type AlertDestination = AlertDestinationDocument
type AlertRule = AlertRuleDocument
type AlertDeliveryEvent = AlertDeliveryEventDocument

/* -------------------------------------------------------------------------- */
/*  Signal badge tone                                                         */
/* -------------------------------------------------------------------------- */

const signalBadgeClass: Record<string, string> = {
  error_rate: "border-destructive/30 text-destructive",
  p95_latency: "border-primary/30 text-primary",
  p99_latency: "border-primary/30 text-primary",
  apdex: "border-severity-warn/30 text-severity-warn",
  throughput: "border-emerald-500/30 text-emerald-500",
  metric: "border-muted-foreground/30 text-muted-foreground",
  query: "border-muted-foreground/30 text-muted-foreground",
}

function SignalBadge({ signalType }: { signalType: string }) {
  return (
    <Badge variant="outline" className={cn("text-xs", signalBadgeClass[signalType])}>
      {signalLabels[signalType as keyof typeof signalLabels] ?? signalType}
    </Badge>
  )
}

/* -------------------------------------------------------------------------- */
/*  Monitor Tab                                                               */
/* -------------------------------------------------------------------------- */

function MonitorTab({
  rules,
  incidents,
  deliveryEvents,
  loading,
}: {
  rules: AlertRule[]
  incidents: AlertIncidentDocument[]
  deliveryEvents: AlertDeliveryEvent[]
  loading: boolean
}) {
  const openIncidents = useMemo(() => incidents.filter((i) => i.status === "open"), [incidents])
  const criticalCount = openIncidents.filter((i) => i.severity === "critical").length
  const warningCount = openIncidents.filter((i) => i.severity === "warning").length
  const enabledRules = rules.filter((r) => r.enabled).length

  // Triggered in the last 24h = incidents whose firstTriggeredAt is within 24h
  const triggered24h = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    return incidents.filter((i) => {
      if (!i.firstTriggeredAt) return false
      return new Date(i.firstTriggeredAt).getTime() >= cutoff
    }).length
  }, [incidents])

  const mttr = useMemo(() => {
    const resolved = incidents.filter((i) => i.resolvedAt && i.firstTriggeredAt)
    if (resolved.length === 0) return "—"
    const avg = resolved.reduce((sum, i) => {
      return sum + (new Date(i.resolvedAt!).getTime() - new Date(i.firstTriggeredAt).getTime())
    }, 0) / resolved.length
    if (avg < 60_000) return `${Math.round(avg / 1000)}s`
    if (avg < 3_600_000) return `${(avg / 60_000).toFixed(1)}m`
    return `${(avg / 3_600_000).toFixed(1)}h`
  }, [incidents])

  const rulesById = useMemo(() => new Map(rules.map((r) => [r.id, r])), [rules])

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-[112px] w-full" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Skeleton className="h-[88px]" />
          <Skeleton className="h-[88px]" />
          <Skeleton className="h-[88px]" />
        </div>
        <Skeleton className="h-48" />
      </div>
    )
  }

  const lastEvaluatedHint =
    deliveryEvents[0]?.scheduledAt
      ? `Last evaluated ${formatRelativeTime(deliveryEvents[0].scheduledAt)}`
      : undefined

  return (
    <div className="space-y-8">
      {/* Hero firing card */}
      <AlertFiringHero
        openCount={openIncidents.length}
        criticalCount={criticalCount}
        warningCount={warningCount}
        rulesEnabled={enabledRules}
        rulesTotal={rules.length}
        lastEvaluatedHint={lastEvaluatedHint}
      />

      {/* Slim stats row */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <AlertStatCard
          label="Triggered (24h)"
          value={triggered24h}
          hint={triggered24h === 1 ? "incident" : "incidents"}
        />
        <AlertStatCard
          label="Avg MTTR"
          value={mttr}
          hint="across resolved"
        />
        <AlertStatCard
          label="Rules enabled"
          value={enabledRules}
          hint={`of ${rules.length} total`}
        />
      </div>

      {/* No-activity hint — the hero already covers the "all clear" feeling */}
      {openIncidents.length === 0 && deliveryEvents.length === 0 && (
        <div className="rounded-md border border-dashed border-border/60 py-8 text-center text-muted-foreground text-sm">
          No recent notifications. Quiet is good.
        </div>
      )}

      {/* Active Incidents */}
      {openIncidents.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Active incidents</h2>
            <Badge variant="secondary" className="rounded-full tabular-nums">
              {openIncidents.length}
            </Badge>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[90px]">Severity</TableHead>
                <TableHead>Rule</TableHead>
                <TableHead>Group</TableHead>
                <TableHead>Current value</TableHead>
                <TableHead className="w-[110px]">Duration</TableHead>
                <TableHead>Last notified</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {openIncidents.map((incident) => {
                const duration = incident.lastTriggeredAt
                  ? formatRelativeTime(incident.lastTriggeredAt)
                  : "—"
                return (
                  <TableRow
                    key={incident.id}
                    className="cursor-pointer"
                  >
                    <TableCell>
                      <AlertSeverityBadge severity={incident.severity} />
                    </TableCell>
                    <TableCell>
                      <Link
                        to="/alerts/$ruleId"
                        params={{ ruleId: incident.ruleId }}
                        className="font-medium hover:underline"
                      >
                        {incident.ruleName}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-muted-foreground">{incident.groupKey ?? "all"}</span>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-destructive">
                        {formatSignalValue(incident.signalType, incident.lastObservedValue)}
                      </span>
                      <span className="text-muted-foreground text-xs ml-1">
                        / {formatSignalValue(incident.signalType, incident.threshold)}
                      </span>
                    </TableCell>
                    <TableCell>{duration}</TableCell>
                    <TableCell>
                      {incident.lastNotifiedAt ? formatRelativeTime(incident.lastNotifiedAt) : "Never"}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Recent Activity — compact Table */}
      {deliveryEvents.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Recent activity</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[110px]">Event</TableHead>
                <TableHead>Rule</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead className="w-[140px]">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveryEvents.slice(0, 10).map((event) => {
                const rule = rulesById.get(event.ruleId)
                const toneClass =
                  event.eventType === "trigger" ? "text-destructive"
                  : event.eventType === "resolve" ? "text-emerald-500"
                  : event.eventType === "renotify" ? "text-amber-500"
                  : "text-muted-foreground"
                const dotClass =
                  event.eventType === "trigger" ? "bg-destructive"
                  : event.eventType === "resolve" ? "bg-emerald-500"
                  : event.eventType === "renotify" ? "bg-amber-500"
                  : "bg-muted-foreground"
                const label =
                  event.eventType === "trigger" ? "Triggered"
                  : event.eventType === "resolve" ? "Resolved"
                  : event.eventType === "renotify" ? "Renotify"
                  : "Test"

                return (
                  <TableRow key={event.id}>
                    <TableCell>
                      <span className={cn("flex items-center gap-1.5 text-xs font-medium", toneClass)}>
                        <span className={cn("size-1.5 rounded-full", dotClass)} />
                        {label}
                      </span>
                    </TableCell>
                    <TableCell className="truncate">
                      {rule ? (
                        <Link to="/alerts/$ruleId" params={{ ruleId: rule.id }} className="hover:underline">
                          {rule.name}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {event.destinationName}
                      <span className="ml-1 text-xs">· {destinationTypeLabels[event.destinationType]}</span>
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {event.scheduledAt ? formatRelativeTime(event.scheduledAt) : "—"}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Main Page                                                                 */
/* -------------------------------------------------------------------------- */

function AlertsPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  const sessionResult = useAtomValue(MapleApiAtomClient.query("auth", "session", {}))
  const destinationsQueryAtom = MapleApiAtomClient.query("alerts", "listDestinations", { reactivityKeys: ["alertDestinations"] })
  const rulesQueryAtom = MapleApiAtomClient.query("alerts", "listRules", { reactivityKeys: ["alertRules"] })
  const incidentsQueryAtom = MapleApiAtomClient.query("alerts", "listIncidents", { reactivityKeys: ["alertIncidents"] })
  const deliveryEventsQueryAtom = MapleApiAtomClient.query("alerts", "listDeliveryEvents", { reactivityKeys: ["alertDeliveryEvents"] })

  const destinationsResult = useAtomValue(destinationsQueryAtom)
  const rulesResult = useAtomValue(rulesQueryAtom)
  const incidentsResult = useAtomValue(incidentsQueryAtom)
  const deliveryEventsResult = useAtomValue(deliveryEventsQueryAtom)

  const createDestination = useAtomSet(MapleApiAtomClient.mutation("alerts", "createDestination"), { mode: "promiseExit" })
  const updateDestination = useAtomSet(MapleApiAtomClient.mutation("alerts", "updateDestination"), { mode: "promiseExit" })
  const deleteDestination = useAtomSet(MapleApiAtomClient.mutation("alerts", "deleteDestination"), { mode: "promiseExit" })
  const testDestination = useAtomSet(MapleApiAtomClient.mutation("alerts", "testDestination"), { mode: "promiseExit" })

  const updateRule = useAtomSet(MapleApiAtomClient.mutation("alerts", "updateRule"), { mode: "promiseExit" })

  const activeTab: AlertsTab = legacyTabMap[search.tab ?? ""] ?? "monitor"

  const destinations = Result.builder(destinationsResult)
    .onSuccess((response) => [...response.destinations] as AlertDestination[])
    .orElse(() => [])
  const rules = Result.builder(rulesResult)
    .onSuccess((response) => [...response.rules] as AlertRule[])
    .orElse(() => [])
  const incidents = Result.builder(incidentsResult)
    .onSuccess((response) => [...response.incidents] as AlertIncidentDocument[])
    .orElse(() => [] as AlertIncidentDocument[])
  const deliveryEvents = Result.builder(deliveryEventsResult)
    .onSuccess((response) => [...response.events] as AlertDeliveryEvent[])
    .orElse(() => [])

  const isAdmin = Result.builder(sessionResult)
    .onSuccess((session) => session.roles.some((role) => role === "root" || role === "org:admin"))
    .orElse(() => false)

  // Rules tab: build firing status from open incidents
  const firingRuleIds = useMemo(() => {
    const ids = new Set<string>()
    for (const incident of incidents) {
      if (incident.status === "open") ids.add(incident.ruleId)
    }
    return ids
  }, [incidents])

  const [searchQuery, setSearchQuery] = useState("")
  const [destinationDialogOpen, setDestinationDialogOpen] = useState(false)
  const [destinationForm, setDestinationForm] = useState<DestinationFormState>(defaultDestinationForm())
  const [editingDestination, setEditingDestination] = useState<AlertDestination | null>(null)
  const [savingDestination, setSavingDestination] = useState(false)
  const [testingDestinationId, setTestingDestinationId] = useState<AlertDestination["id"] | null>(null)
  const [deletingDestinationId, setDeletingDestinationId] = useState<AlertDestination["id"] | null>(null)

  function handleTabSelect(tab: AlertsTab) {
    navigate({ search: (prev) => ({ ...prev, tab }) })
  }

  function openDestinationDialog(destination?: AlertDestination) {
    setEditingDestination(destination ?? null)
    setDestinationForm(destination ? destinationToFormState(destination) : defaultDestinationForm())
    setDestinationDialogOpen(true)
  }

  async function handleDestinationSave() {
    setSavingDestination(true)
    const result = editingDestination
      ? await updateDestination({
          params: { destinationId: editingDestination.id },
          payload: buildDestinationUpdatePayload(destinationForm) as never,
          reactivityKeys: ["alertDestinations"],
        })
      : await createDestination({
          payload: buildDestinationCreatePayload(destinationForm) as never,
          reactivityKeys: ["alertDestinations"],
        })

    if (Exit.isSuccess(result)) {
      toast.success(editingDestination ? "Destination updated" : "Destination created")
      setDestinationDialogOpen(false)
    } else {
      toast.error(getExitErrorMessage(result, "Failed to save destination"))
    }
    setSavingDestination(false)
  }

  async function handleDestinationTest(destination: AlertDestination) {
    setTestingDestinationId(destination.id)
    const result = await testDestination({ params: { destinationId: destination.id }, reactivityKeys: ["alertDestinations", "alertDeliveryEvents"] })
    if (Exit.isSuccess(result)) {
      toast.success(result.value.message)
    } else {
      toast.error(getExitErrorMessage(result, "Failed to send test notification"))
    }
    setTestingDestinationId(null)
  }

  async function handleDestinationToggle(destination: AlertDestination) {
    const form = destinationToFormState(destination)
    form.enabled = !destination.enabled
    const result = await updateDestination({
      params: { destinationId: destination.id },
      payload: buildDestinationUpdatePayload(form) as never,
      reactivityKeys: ["alertDestinations"],
    })
    if (!Exit.isSuccess(result)) {
      toast.error(getExitErrorMessage(result, "Failed to update destination"))
    }
  }

  async function handleDestinationDelete(destination: AlertDestination) {
    setDeletingDestinationId(destination.id)
    const result = await deleteDestination({ params: { destinationId: destination.id }, reactivityKeys: ["alertDestinations", "alertRules"] })
    if (Exit.isSuccess(result)) {
      toast.success("Destination deleted")
    } else {
      const failure = Option.getOrUndefined(Exit.findErrorOption(result))
      if (
        typeof failure === "object" &&
        failure !== null &&
        "_tag" in failure &&
        failure._tag === "@maple/http/errors/AlertDestinationInUseError" &&
        "ruleNames" in failure &&
        Array.isArray(failure.ruleNames)
      ) {
        const ruleNames = failure.ruleNames.filter((name): name is string => typeof name === "string")
        toast.error(
          ruleNames.length > 0
            ? `Remove this destination from these rules first: ${ruleNames.join(", ")}`
            : getExitErrorMessage(result, "Failed to delete destination"),
        )
      } else {
        toast.error(getExitErrorMessage(result, "Failed to delete destination"))
      }
    }
    setDeletingDestinationId(null)
  }

  async function handleRuleToggle(rule: AlertRule) {
    const result = await updateRule({
      params: { ruleId: rule.id },
      payload: buildRuleToggleRequest(rule),
      reactivityKeys: ["alertRules"],
    })
    if (!Exit.isSuccess(result)) {
      toast.error(getExitErrorMessage(result, "Failed to update rule"))
    }
  }

  const filteredRules = useMemo(() => {
    if (!searchQuery.trim()) return rules
    const q = searchQuery.toLowerCase()
    return rules.filter((r) =>
      r.name.toLowerCase().includes(q) ||
      (r.serviceNames?.some((s) => s.toLowerCase().includes(q)))
    )
  }, [rules, searchQuery])

  const tabBar = (
    <Tabs value={activeTab} onValueChange={(v) => handleTabSelect(v as AlertsTab)}>
      <TabsList variant="line">
        <TabsTrigger value="monitor">Monitor</TabsTrigger>
        <TabsTrigger value="rules">Rules</TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
      </TabsList>
    </Tabs>
  )

  return (
    <>
      <DashboardLayout
        breadcrumbs={[{ label: "Alerts" }]}
        titleContent={
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight truncate">Alerts</h1>
              <Badge variant="secondary" className="text-xs font-medium">Beta</Badge>
            </div>
            <p className="text-muted-foreground">Monitor your services and get notified when things go wrong.</p>
          </div>
        }
        headerActions={
          <Button size="sm" nativeButton={false} render={<Link to="/alerts/create" search={{ serviceName: search.serviceName }} />}>
            <PlusIcon size={14} />
            New rule
          </Button>
        }
        stickyContent={tabBar}
      >
        <div className="space-y-6">
          {/* ─── Monitor Tab ─── */}
          {activeTab === "monitor" && (
            <MonitorTab
              rules={rules}
              incidents={incidents}
              deliveryEvents={deliveryEvents}
              loading={Result.isInitial(rulesResult) || Result.isInitial(incidentsResult)}
            />
          )}

          {/* ─── Rules Tab ─── */}
          {activeTab === "rules" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="relative flex-1 max-w-xs">
                  <MagnifierIcon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search rules..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9"
                  />
                </div>
              </div>

              {Result.isInitial(rulesResult) ? (
                <div className="space-y-3">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : !Result.isSuccess(rulesResult) ? (
                <Empty className="py-12">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <CircleWarningIcon size={18} />
                    </EmptyMedia>
                    <EmptyTitle>Failed to load alert rules</EmptyTitle>
                    <EmptyDescription>
                      Refresh the page or check your connection.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : filteredRules.length === 0 && rules.length === 0 ? (
                <Empty className="py-12">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <BellIcon size={18} />
                    </EmptyMedia>
                    <EmptyTitle>No alert rules</EmptyTitle>
                    <EmptyDescription>
                      Create a threshold rule to open incidents for latency, error rate, throughput, Apdex, or exact metrics.
                    </EmptyDescription>
                  </EmptyHeader>
                  {isAdmin && (
                    <Button size="sm" nativeButton={false} render={<Link to="/alerts/create" search={{ serviceName: search.serviceName }} />}>
                      <PlusIcon size={14} />
                      Add rule
                    </Button>
                  )}
                </Empty>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[40px]" />
                      <TableHead className="min-w-[200px]">Name</TableHead>
                      <TableHead className="w-[110px]">Signal</TableHead>
                      <TableHead className="w-[160px]">Scope</TableHead>
                      <TableHead className="w-[180px]">Condition</TableHead>
                      <TableHead className="w-[100px]">Severity</TableHead>
                      <TableHead className="w-[70px]">Notify</TableHead>
                      <TableHead className="w-[100px]">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredRules.map((rule) => {
                      const status: "firing" | "ok" | "disabled" = !rule.enabled
                        ? "disabled"
                        : firingRuleIds.has(rule.id)
                          ? "firing"
                          : "ok"

                      return (
                        <TableRow
                          key={rule.id}
                          className="cursor-pointer"
                          onClick={() => navigate({ to: "/alerts/$ruleId", params: { ruleId: rule.id } })}
                        >
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <Switch
                              checked={rule.enabled}
                              onCheckedChange={() => handleRuleToggle(rule)}
                              disabled={!isAdmin}
                            />
                          </TableCell>
                          <TableCell className={cn("font-medium", !rule.enabled && "text-muted-foreground")}>
                            {rule.name}
                          </TableCell>
                          <TableCell>
                            <SignalBadge signalType={rule.signalType} />
                          </TableCell>
                          <TableCell>
                            {rule.serviceNames?.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {rule.serviceNames.map((s) => (
                                  <Badge key={s} variant="outline" className="text-xs">
                                    {s}
                                  </Badge>
                                ))}
                              </div>
                            ) : (
                              <span className="font-mono text-muted-foreground text-xs">
                                {rule.groupBy && rule.groupBy.length > 0 ? `all · per ${rule.groupBy.join(" · ")}` : "all"}
                              </span>
                            )}
                            {rule.excludeServiceNames?.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-0.5">
                                {rule.excludeServiceNames.map((s) => (
                                  <Badge key={s} variant="outline" className="text-xs text-muted-foreground line-through">
                                    {s}
                                  </Badge>
                                ))}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            <span className="font-mono text-xs">
                              {comparatorLabels[rule.comparator]} {formatSignalValue(rule.signalType, rule.threshold)} / {rule.windowMinutes}min
                            </span>
                          </TableCell>
                          <TableCell>
                            <AlertSeverityBadge severity={rule.severity} />
                          </TableCell>
                          <TableCell>
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              {rule.destinationIds.length}
                              <PaperPlaneIcon size={12} />
                            </span>
                          </TableCell>
                          <TableCell>
                            <AlertStatusBadge state={status} />
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              )}
            </div>
          )}

          {/* ─── Settings Tab ─── */}
          {activeTab === "settings" && (
            <div className="space-y-10">
              {/* Destinations section */}
              <section className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold">Destinations</h2>
                    <p className="text-muted-foreground text-sm">
                      Destinations are reusable across rules and keep provider retries and failures auditable.
                    </p>
                  </div>
                  {isAdmin && (
                    <Button size="sm" onClick={() => openDestinationDialog()}>
                      <PlusIcon size={14} />
                      Add destination
                    </Button>
                  )}
                </div>

                {Result.isInitial(destinationsResult) ? (
                  <div className="space-y-3">
                    <Skeleton className="h-24 w-full" />
                    <Skeleton className="h-24 w-full" />
                  </div>
                ) : !Result.isSuccess(destinationsResult) ? (
                  <Empty className="py-12">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <CircleWarningIcon size={18} />
                      </EmptyMedia>
                      <EmptyTitle>Failed to load alert destinations</EmptyTitle>
                      <EmptyDescription>
                        Refresh the page or check your connection.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : destinations.length === 0 ? (
                  <Empty className="py-12">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <FireIcon size={18} />
                      </EmptyMedia>
                      <EmptyTitle>No destinations configured</EmptyTitle>
                      <EmptyDescription>
                        Add Slack, PagerDuty, or webhook destinations before creating alert rules.
                      </EmptyDescription>
                    </EmptyHeader>
                    {isAdmin && (
                      <Button size="sm" onClick={() => openDestinationDialog()}>
                        <PlusIcon size={14} />
                        Add destination
                      </Button>
                    )}
                  </Empty>
                ) : (
                  <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                    {destinations.map((destination) => (
                      <Card key={destination.id}>
                        <CardContent className="p-5">
                          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                            <div className="space-y-2 min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="text-sm font-semibold truncate">{destination.name}</div>
                                <Badge variant="outline" className="text-xs">{destinationTypeLabels[destination.type]}</Badge>
                                <AlertStatusBadge state={destination.enabled ? "ok" : "disabled"} label={destination.enabled ? "Enabled" : "Disabled"} />
                              </div>
                              <div className="text-muted-foreground text-sm truncate">{destination.summary}</div>
                              <div className="text-muted-foreground text-xs">
                                Last tested {destination.lastTestedAt ? formatRelativeTime(destination.lastTestedAt) : "never"}
                              </div>
                              {destination.lastTestError && (
                                <div className="flex items-center gap-2 text-xs text-destructive">
                                  <AlertWarningIcon size={12} />
                                  <span className="truncate">{destination.lastTestError}</span>
                                </div>
                              )}
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              <Switch
                                checked={destination.enabled}
                                onCheckedChange={() => handleDestinationToggle(destination)}
                                disabled={!isAdmin}
                              />
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleDestinationTest(destination)}
                                disabled={!isAdmin || testingDestinationId === destination.id}
                              >
                                {testingDestinationId === destination.id ? (
                                  <LoaderIcon size={14} className="animate-spin" />
                                ) : (
                                  <CheckIcon size={14} />
                                )}
                                Send test
                              </Button>
                              {isAdmin && (
                                <DropdownMenu>
                                  <DropdownMenuTrigger
                                    render={<Button variant="ghost" size="icon-sm" className="shrink-0" />}
                                  >
                                    <DotsVerticalIcon size={14} />
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuItem onClick={() => openDestinationDialog(destination)}>
                                      <PencilIcon size={14} />
                                      Edit
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      variant="destructive"
                                      onClick={() => handleDestinationDelete(destination)}
                                      disabled={deletingDestinationId === destination.id}
                                    >
                                      <TrashIcon size={14} />
                                      Delete
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              )}
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </section>

              <Separator />

              {/* Delivery log section */}
              <section className="space-y-4">
                <div>
                  <h2 className="text-lg font-semibold">Delivery log</h2>
                  <p className="text-muted-foreground text-sm">
                    Every queued, retried, and completed notification attempt across alert destinations.
                  </p>
                </div>

                {Result.isInitial(deliveryEventsResult) ? (
                  <div className="space-y-2">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ) : !Result.isSuccess(deliveryEventsResult) ? (
                  <Empty className="py-12">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <CircleWarningIcon size={18} />
                      </EmptyMedia>
                      <EmptyTitle>Failed to load delivery history</EmptyTitle>
                      <EmptyDescription>
                        Refresh the page or check your connection.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : deliveryEvents.length === 0 ? (
                  <Empty className="py-12">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <PaperPlaneIcon size={18} />
                      </EmptyMedia>
                      <EmptyTitle>No notifications sent yet</EmptyTitle>
                      <EmptyDescription>
                        Once rules start triggering, delivery attempts will show up here.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Destination</TableHead>
                        <TableHead>Event</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Attempt</TableHead>
                        <TableHead>Scheduled</TableHead>
                        <TableHead>Result</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {deliveryEvents.map((event) => (
                        <TableRow key={event.id}>
                          <TableCell>
                            <div className="flex flex-col">
                              <span className="font-medium">{event.destinationName}</span>
                              <span className="text-muted-foreground text-xs">
                                {destinationTypeLabels[event.destinationType]}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="capitalize">{event.eventType}</TableCell>
                          <TableCell>
                            <Badge variant={event.status === "success" ? "secondary" : event.status === "failed" ? "destructive" : "outline"}>
                              {event.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="tabular-nums">{event.attemptNumber}</TableCell>
                          <TableCell>
                            <div className="flex flex-col">
                              <span>{formatAlertDateTime(event.scheduledAt)}</span>
                              <span className="text-muted-foreground text-xs">
                                {formatRelativeTime(event.scheduledAt)}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="max-w-[320px]">
                            <div className="text-sm truncate">
                              {event.providerMessage ?? event.errorMessage ?? "Queued"}
                            </div>
                            {event.providerReference && (
                              <div className="text-muted-foreground truncate text-xs">
                                Ref: {event.providerReference}
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </section>
            </div>
          )}
        </div>
      </DashboardLayout>

      <DestinationDialog
        open={destinationDialogOpen}
        onOpenChange={setDestinationDialogOpen}
        form={destinationForm}
        onFormChange={setDestinationForm}
        isEditing={editingDestination != null}
        saving={savingDestination}
        onSave={handleDestinationSave}
      />
    </>
  )
}
