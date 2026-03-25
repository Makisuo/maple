import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { Exit, Option, Schema } from "effect"
import { useState, useMemo } from "react"
import { toast } from "sonner"

import { DestinationDialog } from "@/components/alerts/destination-dialog"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { formatRelativeTime } from "@/lib/format"
import {
  AlertDeliveryEventDocument,
  AlertDestinationDocument,
  AlertIncidentDocument,
  AlertRuleDocument,
  type AlertDestinationType,
} from "@maple/domain/http"
import {
  type DestinationFormState,
  severityTone,
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
  ClockIcon,
  DotsVerticalIcon,
  FireIcon,
  LoaderIcon,
  MagnifierIcon,
  PaperPlaneIcon,
  PencilIcon,
  PlusIcon,
  ServerIcon,
  TrashIcon,
} from "@/components/icons"
import { cn } from "@maple/ui/utils"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@maple/ui/components/ui/card"
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

const tabValues = ["overview", "rules", "incidents", "destinations"] as const
type AlertsTab = (typeof tabValues)[number]

const AlertsSearch = Schema.Struct({
  tab: Schema.optional(Schema.Literals(tabValues)),
  serviceName: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/alerts/")({
  component: AlertsPage,
  validateSearch: Schema.toStandardSchemaV1(AlertsSearch),
})

type AlertDestination = AlertDestinationDocument
type AlertRule = AlertRuleDocument
type AlertDeliveryEvent = AlertDeliveryEventDocument

/* -------------------------------------------------------------------------- */
/*  Signal badge colors                                                       */
/* -------------------------------------------------------------------------- */

const signalBadgeClass: Record<string, string> = {
  error_rate: "border-red-500/30 text-red-500",
  p95_latency: "border-blue-500/30 text-blue-500",
  p99_latency: "border-blue-500/30 text-blue-500",
  apdex: "border-yellow-500/30 text-yellow-500",
  throughput: "border-emerald-500/30 text-emerald-500",
  metric: "border-zinc-400/30 text-zinc-400",
}

/* -------------------------------------------------------------------------- */
/*  Overview Tab                                                              */
/* -------------------------------------------------------------------------- */

function OverviewTab({
  rules,
  incidents,
  destinations,
  deliveryEvents,
  loading,
  onTabSelect,
}: {
  rules: AlertRule[]
  incidents: AlertIncidentDocument[]
  destinations: AlertDestination[]
  deliveryEvents: AlertDeliveryEvent[]
  loading: boolean
  onTabSelect: (tab: AlertsTab) => void
}) {
  const openIncidents = useMemo(() => incidents.filter((i) => i.status === "open"), [incidents])
  const criticalCount = openIncidents.filter((i) => i.severity === "critical").length
  const warningCount = openIncidents.filter((i) => i.severity === "warning").length
  const enabledRules = rules.filter((r) => r.enabled).length

  const destinationSummary = useMemo(() => {
    const byType: Record<string, number> = {}
    for (const d of destinations) {
      byType[d.type] = (byType[d.type] ?? 0) + 1
    }
    return Object.entries(byType)
      .map(([type, count]) => `${count} ${destinationTypeLabels[type as AlertDestinationType]}`)
      .join(", ")
  }, [destinations])

  const rulesById = useMemo(
    () => new Map(rules.map((r) => [r.id, r])),
    [rules],
  )


  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-3 gap-4">
          <Skeleton className="h-[98px]" />
          <Skeleton className="h-[98px]" />
          <Skeleton className="h-[98px]" />
        </div>
        <Skeleton className="h-48" />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Stats strip */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">Active Incidents</span>
              {openIncidents.length > 0 && (
                <span className="size-2 rounded-full bg-red-500" />
              )}
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="text-3xl font-bold tabular-nums">{openIncidents.length}</span>
              <span className="text-muted-foreground text-sm">
                {criticalCount > 0 && `${criticalCount} critical`}
                {criticalCount > 0 && warningCount > 0 && ", "}
                {warningCount > 0 && `${warningCount} warning`}
                {openIncidents.length === 0 && "all clear"}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">Rules Enabled</span>
              <ClockIcon size={16} className="text-muted-foreground" />
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="text-3xl font-bold tabular-nums">{enabledRules}</span>
              <span className="text-muted-foreground text-sm">of {rules.length} rules</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">Destinations</span>
              <PaperPlaneIcon size={16} className="text-muted-foreground" />
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="text-3xl font-bold tabular-nums">{destinations.length}</span>
              <span className="text-muted-foreground text-sm">{destinationSummary || "none configured"}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Combined empty state when nothing to show */}
      {openIncidents.length === 0 && deliveryEvents.length === 0 && (
        <Empty className="py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CheckIcon size={18} />
            </EmptyMedia>
            <EmptyTitle>All clear</EmptyTitle>
            <EmptyDescription>
              No active incidents or recent notifications. Rules are evaluating normally.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {/* Active Incidents — only shown when there are incidents */}
      {openIncidents.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">Active Incidents</h2>
              <Badge variant="secondary" className="rounded-full tabular-nums">{openIncidents.length}</Badge>
            </div>
            <button
              type="button"
              className="text-sm text-primary hover:underline"
              onClick={() => onTabSelect("incidents")}
            >
              View all incidents
            </button>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[90px]">Severity</TableHead>
                <TableHead>Rule</TableHead>
                <TableHead>Service</TableHead>
                <TableHead>Current Value</TableHead>
                <TableHead className="w-[100px]">Duration</TableHead>
                <TableHead>Last Notified</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {openIncidents.map((incident, idx) => {
                const duration = incident.lastTriggeredAt
                  ? formatRelativeTime(incident.lastTriggeredAt)
                  : "—"
                return (
                  <TableRow key={idx}>
                    <TableCell>
                      <Badge variant="outline" className={severityTone[incident.severity]}>
                        {incident.severity === "critical" ? "Critical" : "Warning"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium">
                      {incident.ruleName}
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-muted-foreground">{incident.serviceName ?? "all"}</span>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-orange-500">
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

      {/* Recent Activity — only shown when there are events */}
      {deliveryEvents.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Recent Activity</h2>
            <button
              type="button"
              className="text-sm text-primary hover:underline"
              onClick={() => onTabSelect("incidents")}
            >
              View delivery log
            </button>
          </div>

          <div className="space-y-1">
            {deliveryEvents.slice(0, 5).map((event, idx) => {
              const rule = rulesById.get(event.ruleId)
              const typeLabel =
                event.eventType === "trigger" ? "Triggered"
                : event.eventType === "resolve" ? "Resolved"
                : event.eventType === "renotify" ? "Renotify"
                : "Test"
              const dotColor =
                event.eventType === "trigger" ? "bg-red-500"
                : event.eventType === "resolve" ? "bg-green-500"
                : event.eventType === "renotify" ? "bg-orange-500"
                : "bg-zinc-400"
              const textColor =
                event.eventType === "trigger" ? "text-red-500"
                : event.eventType === "resolve" ? "text-green-500"
                : event.eventType === "renotify" ? "text-orange-500"
                : "text-muted-foreground"

              const description = rule
                ? `${rule.name} on ${rule.serviceNames?.length > 0 ? rule.serviceNames.join(", ") : "all services"}${event.eventType === "renotify" ? ` via ${event.destinationName}` : ""}`
                : event.destinationName

              return (
                <div key={idx} className="flex items-center gap-3 py-2">
                  <span className={cn("size-1.5 shrink-0 rounded-full", dotColor)} />
                  <span className={cn("text-sm font-medium w-[80px] shrink-0", textColor)}>{typeLabel}</span>
                  <span className="text-sm text-muted-foreground truncate flex-1">{description}</span>
                  <span className="text-sm text-muted-foreground shrink-0 tabular-nums">
                    {event.scheduledAt ? formatRelativeTime(event.scheduledAt) : "—"}
                  </span>
                </div>
              )
            })}
          </div>
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
  const destinationsQueryAtom = MapleApiAtomClient.query("alerts", "listDestinations", {})
  const rulesQueryAtom = MapleApiAtomClient.query("alerts", "listRules", {})
  const incidentsQueryAtom = MapleApiAtomClient.query("alerts", "listIncidents", {})
  const deliveryEventsQueryAtom = MapleApiAtomClient.query("alerts", "listDeliveryEvents", {})

  const destinationsResult = useAtomValue(destinationsQueryAtom)
  const rulesResult = useAtomValue(rulesQueryAtom)
  const incidentsResult = useAtomValue(incidentsQueryAtom)
  const deliveryEventsResult = useAtomValue(deliveryEventsQueryAtom)

  const refreshDestinations = useAtomRefresh(destinationsQueryAtom)
  const refreshRules = useAtomRefresh(rulesQueryAtom)

  const refreshDeliveryEvents = useAtomRefresh(deliveryEventsQueryAtom)

  const createDestination = useAtomSet(MapleApiAtomClient.mutation("alerts", "createDestination"), { mode: "promiseExit" })
  const updateDestination = useAtomSet(MapleApiAtomClient.mutation("alerts", "updateDestination"), { mode: "promiseExit" })
  const deleteDestination = useAtomSet(MapleApiAtomClient.mutation("alerts", "deleteDestination"), { mode: "promiseExit" })
  const testDestination = useAtomSet(MapleApiAtomClient.mutation("alerts", "testDestination"), { mode: "promiseExit" })

  const updateRule = useAtomSet(MapleApiAtomClient.mutation("alerts", "updateRule"), { mode: "promiseExit" })

  const activeTab: AlertsTab = tabValues.includes(search.tab as AlertsTab)
    ? (search.tab as AlertsTab)
    : "overview"

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
        })
      : await createDestination({
          payload: buildDestinationCreatePayload(destinationForm) as never,
        })

    if (Exit.isSuccess(result)) {
      toast.success(editingDestination ? "Destination updated" : "Destination created")
      setDestinationDialogOpen(false)
      refreshDestinations()
    } else {
      toast.error(getExitErrorMessage(result, "Failed to save destination"))
    }
    setSavingDestination(false)
  }

  async function handleDestinationTest(destination: AlertDestination) {
    setTestingDestinationId(destination.id)
    const result = await testDestination({ params: { destinationId: destination.id } })
    if (Exit.isSuccess(result)) {
      toast.success(result.value.message)
      refreshDestinations()
      refreshDeliveryEvents()
    } else {
      toast.error(getExitErrorMessage(result, "Failed to send test notification"))
      refreshDestinations()
    }
    setTestingDestinationId(null)
  }

  async function handleDestinationToggle(destination: AlertDestination) {
    const form = destinationToFormState(destination)
    form.enabled = !destination.enabled
    const result = await updateDestination({
      params: { destinationId: destination.id },
      payload: buildDestinationUpdatePayload(form) as never,
    })
    if (Exit.isSuccess(result)) {
      refreshDestinations()
    } else {
      toast.error(getExitErrorMessage(result, "Failed to update destination"))
    }
  }

  async function handleDestinationDelete(destination: AlertDestination) {
    setDeletingDestinationId(destination.id)
    const result = await deleteDestination({ params: { destinationId: destination.id } })
    if (Exit.isSuccess(result)) {
      toast.success("Destination deleted")
      refreshDestinations()
      refreshRules()
    } else {
      const failure = Option.getOrUndefined(Exit.findErrorOption(result))
      if (
        typeof failure === "object" &&
        failure !== null &&
        "_tag" in failure &&
        failure._tag === "AlertDestinationInUseError" &&
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
    })
    if (Exit.isSuccess(result)) {
      refreshRules()
    } else {
      toast.error(getExitErrorMessage(result, "Failed to update rule"))
    }
  }

  const filteredRules = useMemo(() => {
    if (!searchQuery.trim()) return rules
    const q = searchQuery.toLowerCase()
    return rules.filter((r) =>
      r.name.toLowerCase().includes(q) ||
      (r.serviceNames?.some((s) => s.toLowerCase().includes(q))) ||
      (r.serviceName && r.serviceName.toLowerCase().includes(q))
    )
  }, [rules, searchQuery])

  const tabBar = (
    <Tabs value={activeTab} onValueChange={(v) => handleTabSelect(v as AlertsTab)}>
      <TabsList variant="line">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="rules">Rules</TabsTrigger>
        <TabsTrigger value="incidents">Incidents</TabsTrigger>
        <TabsTrigger value="destinations">Destinations</TabsTrigger>
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
          <Button size="sm" render={<Link to="/alerts/create" search={{ serviceName: search.serviceName }} />}>
            <PlusIcon size={14} />
            New Rule
          </Button>
        }
        stickyContent={tabBar}
      >
        <div className="space-y-6">
          {/* ─── Overview Tab ─── */}
          {activeTab === "overview" && (
            <OverviewTab
              rules={rules}
              incidents={incidents}
              destinations={destinations}
              deliveryEvents={deliveryEvents}
              loading={Result.isInitial(rulesResult) || Result.isInitial(incidentsResult)}
              onTabSelect={handleTabSelect}
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
                <div className="text-muted-foreground py-8 text-center text-sm">
                  Failed to load alert rules.
                </div>
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
                    <Button size="sm" render={<Link to="/alerts/create" search={{ serviceName: search.serviceName }} />}>
                      <PlusIcon size={14} />
                      Add Rule
                    </Button>
                  )}
                </Empty>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[40px]" />
                      <TableHead className="min-w-[200px]">Name</TableHead>
                      <TableHead className="w-[100px]">Signal</TableHead>
                      <TableHead className="w-[130px]">Service</TableHead>
                      <TableHead className="w-[160px]">Condition</TableHead>
                      <TableHead className="w-[80px]">Severity</TableHead>
                      <TableHead className="w-[70px]">Notify</TableHead>
                      <TableHead className="w-[90px]">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredRules.map((rule) => {
                      const isFiring = firingRuleIds.has(rule.id)
                      const status = !rule.enabled
                        ? { label: "Disabled", dot: "bg-zinc-400" }
                        : isFiring
                          ? { label: "Firing", dot: "bg-red-500" }
                          : { label: "OK", dot: "bg-green-500" }

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
                            <Badge variant="outline" className={cn("text-xs", signalBadgeClass[rule.signalType])}>
                              {signalLabels[rule.signalType]}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {rule.serviceNames?.length > 0
                              ? <div className="flex flex-wrap gap-1">{rule.serviceNames.map((s) => <Badge key={s} variant="outline" className="text-xs">{s}</Badge>)}</div>
                              : <span className="font-mono text-muted-foreground text-sm">all</span>}
                          </TableCell>
                          <TableCell>
                            <span className="font-mono text-sm">
                              {comparatorLabels[rule.comparator]} {formatSignalValue(rule.signalType, rule.threshold)} / {rule.windowMinutes}min
                            </span>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={severityTone[rule.severity]}>
                              {rule.severity === "critical" ? "Critical" : "Warning"}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <span className="flex items-center gap-1 text-sm text-muted-foreground">
                              {rule.destinationIds.length}
                              <PaperPlaneIcon size={12} />
                            </span>
                          </TableCell>
                          <TableCell>
                            <span className="flex items-center gap-1.5 text-sm">
                              <span className={cn("size-1.5 rounded-full", status.dot)} />
                              <span className={cn(
                                status.label === "Firing" && "text-red-500 font-medium",
                                status.label === "Disabled" && "text-muted-foreground",
                                status.label === "OK" && "text-green-500",
                              )}>
                                {status.label}
                              </span>
                            </span>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              )}
            </div>
          )}

          {/* ─── Incidents Tab ─── */}
          {activeTab === "incidents" && (
            <div className="space-y-4">
              {Result.isInitial(incidentsResult) ? (
                <div className="space-y-3">
                  <Skeleton className="h-28 w-full" />
                  <Skeleton className="h-28 w-full" />
                </div>
              ) : !Result.isSuccess(incidentsResult) ? (
                <div className="text-muted-foreground py-8 text-center text-sm">
                  Failed to load incidents.
                </div>
              ) : incidents.length === 0 ? (
                <Empty className="py-12">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <CircleWarningIcon size={18} />
                    </EmptyMedia>
                    <EmptyTitle>No incidents yet</EmptyTitle>
                    <EmptyDescription>
                      Open incidents and recovery events will appear here once rules start evaluating against live traffic.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="space-y-3">
                  {incidents.map((incident) => (
                    <Card key={incident.id}>
                      <CardContent className="space-y-3 p-4">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="text-sm font-semibold">{incident.ruleName}</div>
                              <Badge variant="outline" className={severityTone[incident.severity]}>
                                {incident.severity}
                              </Badge>
                              <Badge variant={incident.status === "open" ? "default" : "secondary"}>
                                {incident.status}
                              </Badge>
                              <Badge variant="outline">{signalLabels[incident.signalType]}</Badge>
                            </div>
                            <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                              <span>
                                Current: {formatSignalValue(incident.signalType, incident.lastObservedValue)}
                              </span>
                              <span>
                                Threshold: {comparatorLabels[incident.comparator]} {formatSignalValue(incident.signalType, incident.threshold)}
                              </span>
                              <span>Triggered {formatRelativeTime(incident.lastTriggeredAt)}</span>
                              <span>Last notified {formatAlertDateTime(incident.lastNotifiedAt)}</span>
                            </div>
                          </div>
                          {incident.serviceName ? (
                            <Button variant="outline" size="sm" render={<Link to="/services/$serviceName" params={{ serviceName: incident.serviceName }} />}>
                              <ServerIcon size={14} />
                              Open Service
                            </Button>
                          ) : (
                            <Button variant="outline" size="sm" render={<Link to="/alerts" search={{ tab: "rules" }} />}>
                              <BellIcon size={14} />
                              Open Rules
                            </Button>
                          )}
                        </div>
                        <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                          <span>First triggered {formatAlertDateTime(incident.firstTriggeredAt)}</span>
                          <span>Resolved {formatAlertDateTime(incident.resolvedAt)}</span>
                          <span>Dedupe key {incident.dedupeKey}</span>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}

              {deliveryEvents.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Delivery History</CardTitle>
                  <CardDescription>
                    Every queued, retried, and completed notification attempt across alert destinations.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {Result.isInitial(deliveryEventsResult) ? (
                    <div className="space-y-2">
                      <Skeleton className="h-12 w-full" />
                      <Skeleton className="h-12 w-full" />
                    </div>
                  ) : !Result.isSuccess(deliveryEventsResult) ? (
                    <div className="text-muted-foreground py-8 text-center text-sm">
                      Failed to load delivery history.
                    </div>
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
                            <TableCell>{event.eventType}</TableCell>
                            <TableCell>
                              <Badge variant={event.status === "success" ? "secondary" : event.status === "failed" ? "destructive" : "outline"}>
                                {event.status}
                              </Badge>
                            </TableCell>
                            <TableCell>{event.attemptNumber}</TableCell>
                            <TableCell>
                              <div className="flex flex-col">
                                <span>{formatAlertDateTime(event.scheduledAt)}</span>
                                <span className="text-muted-foreground text-xs">
                                  {formatRelativeTime(event.scheduledAt)}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell className="max-w-[320px]">
                              <div className="text-sm">
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
                </CardContent>
              </Card>
              )}
            </div>
          )}

          {/* ─── Destinations Tab ─── */}
          {activeTab === "destinations" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-muted-foreground text-sm">
                  Destinations are reusable across rules and keep provider retries and failures auditable.
                </div>
                {isAdmin && (
                  <Button size="sm" onClick={() => openDestinationDialog()}>
                    <PlusIcon size={14} />
                    Add Destination
                  </Button>
                )}
              </div>

              {Result.isInitial(destinationsResult) ? (
                <div className="space-y-3">
                  <Skeleton className="h-28 w-full" />
                  <Skeleton className="h-28 w-full" />
                </div>
              ) : !Result.isSuccess(destinationsResult) ? (
                <div className="text-muted-foreground py-8 text-center text-sm">
                  Failed to load alert destinations.
                </div>
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
                      Add Destination
                    </Button>
                  )}
                </Empty>
              ) : (
                <div className="space-y-3">
                  {destinations.map((destination) => (
                    <Card key={destination.id}>
                      <CardContent className="flex flex-col gap-4 p-4 lg:flex-row lg:items-start lg:justify-between">
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="text-sm font-semibold">{destination.name}</div>
                            <Badge variant="outline">{destinationTypeLabels[destination.type]}</Badge>
                            <Badge variant="outline">{destination.enabled ? "Enabled" : "Disabled"}</Badge>
                          </div>
                          <div className="text-muted-foreground text-sm">{destination.summary}</div>
                          <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                            <span>
                              Last tested {destination.lastTestedAt ? formatRelativeTime(destination.lastTestedAt) : "never"}
                            </span>
                          </div>
                          {destination.lastTestError && (
                            <div className="flex items-center gap-2 text-xs text-destructive">
                              <AlertWarningIcon size={12} />
                              <span>{destination.lastTestError}</span>
                            </div>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <Switch checked={destination.enabled} onCheckedChange={() => handleDestinationToggle(destination)} disabled={!isAdmin} />
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleDestinationTest(destination)}
                            disabled={!isAdmin || testingDestinationId === destination.id}
                          >
                            {testingDestinationId === destination.id ? <LoaderIcon size={14} className="animate-spin" /> : <CheckIcon size={14} />}
                            Send Test
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
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
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
