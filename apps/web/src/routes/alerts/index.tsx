import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { Cause, Exit, Option, Schema } from "effect"
import { useState, useMemo } from "react"
import { toast } from "sonner"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { formatLatency, formatNumber, formatRelativeTime } from "@/lib/format"
import {
  AlertDeliveryEventDocument,
  AlertDestinationDocument,
  AlertRuleDocument,
  AlertRuleTestRequest,
  AlertRuleUpsertRequest,
  type AlertDestinationType,
  type AlertSeverity,
} from "@maple/domain/http"
import {
  severityTone,
  signalLabels,
  comparatorLabels,
  destinationTypeLabels,
  metricTypeLabels,
  metricAggregationLabels,
  formatSignalValue,
} from "@/lib/alerts/form-utils"
import {
  AlertWarningIcon,
  BellIcon,
  CheckIcon,
  CircleWarningIcon,
  DotsVerticalIcon,
  EyeIcon,
  FireIcon,
  LoaderIcon,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@maple/ui/components/ui/dialog"
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
import { Label } from "@maple/ui/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@maple/ui/components/ui/select"
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

const tabValues = ["rules", "incidents", "destinations"] as const
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

type DestinationFormState = {
  type: AlertDestinationType
  name: string
  enabled: boolean
  channelLabel: string
  webhookUrl: string
  integrationKey: string
  url: string
  signingSecret: string
}


function getExitErrorMessage(exit: Exit.Exit<unknown, unknown>, fallback: string): string {
  if (Exit.isSuccess(exit)) return fallback

  const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
  if (failure instanceof Error && failure.message.trim().length > 0) {
    return failure.message
  }
  if (
    typeof failure === "object" &&
    failure !== null &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message
  }

  const defect = Cause.squash(exit.cause)
  if (defect instanceof Error && defect.message.trim().length > 0) {
    return defect.message
  }

  return fallback
}

function formatDateTime(value: string | null): string {
  if (!value) return "Never"
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function defaultDestinationForm(type: AlertDestinationType = "slack"): DestinationFormState {
  return {
    type,
    name: "",
    enabled: true,
    channelLabel: "",
    webhookUrl: "",
    integrationKey: "",
    url: "",
    signingSecret: "",
  }
}

function destinationToFormState(destination: AlertDestination): DestinationFormState {
  return {
    type: destination.type,
    name: destination.name,
    enabled: destination.enabled,
    channelLabel: destination.channelLabel ?? "",
    webhookUrl: "",
    integrationKey: "",
    url: "",
    signingSecret: "",
  }
}

function AlertNav({
  activeTab,
  onSelect,
}: {
  activeTab: AlertsTab
  onSelect: (tab: AlertsTab) => void
}) {
  const items: Array<{ id: AlertsTab; label: string; description: string }> = [
    { id: "rules", label: "Rules", description: "Create service-first thresholds and preview evaluations." },
    { id: "incidents", label: "Incidents", description: "Track open alerts, resolutions, and notification history." },
    { id: "destinations", label: "Destinations", description: "Manage reusable Slack, PagerDuty, and webhook endpoints." },
  ]

  return (
    <nav className="flex flex-col gap-1">
      {items.map((item) => {
        const isActive = item.id === activeTab
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            className={cn(
              "rounded-lg border px-3 py-2 text-left transition-colors",
              isActive
                ? "border-primary/30 bg-primary/5"
                : "border-transparent hover:border-border hover:bg-muted/50",
            )}
          >
            <div className={cn("text-sm font-medium", isActive ? "text-foreground" : "text-muted-foreground")}>
              {item.label}
            </div>
            <div className="text-muted-foreground mt-1 text-xs leading-relaxed">
              {item.description}
            </div>
          </button>
        )
      })}
    </nav>
  )
}

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
  const refreshIncidents = useAtomRefresh(incidentsQueryAtom)
  const refreshDeliveryEvents = useAtomRefresh(deliveryEventsQueryAtom)

  const createDestination = useAtomSet(MapleApiAtomClient.mutation("alerts", "createDestination"), { mode: "promiseExit" })
  const updateDestination = useAtomSet(MapleApiAtomClient.mutation("alerts", "updateDestination"), { mode: "promiseExit" })
  const deleteDestination = useAtomSet(MapleApiAtomClient.mutation("alerts", "deleteDestination"), { mode: "promiseExit" })
  const testDestination = useAtomSet(MapleApiAtomClient.mutation("alerts", "testDestination"), { mode: "promiseExit" })

  const updateRule = useAtomSet(MapleApiAtomClient.mutation("alerts", "updateRule"), { mode: "promiseExit" })
  const deleteRule = useAtomSet(MapleApiAtomClient.mutation("alerts", "deleteRule"), { mode: "promiseExit" })

  const activeTab: AlertsTab = tabValues.includes(search.tab as AlertsTab)
    ? (search.tab as AlertsTab)
    : "rules"

  const destinations = Result.builder(destinationsResult)
    .onSuccess((response) => [...response.destinations] as AlertDestination[])
    .orElse(() => [])
  const rules = Result.builder(rulesResult)
    .onSuccess((response) => [...response.rules] as AlertRule[])
    .orElse(() => [])
  const incidents = Result.builder(incidentsResult)
    .onSuccess((response) => [...response.incidents])
    .orElse(() => [])
  const deliveryEvents = Result.builder(deliveryEventsResult)
    .onSuccess((response) => [...response.events] as AlertDeliveryEvent[])
    .orElse(() => [])

  const isAdmin = Result.builder(sessionResult)
    .onSuccess((session) => session.roles.some((role) => role === "root" || role === "org:admin"))
    .orElse(() => false)

  const destinationsById = useMemo(
    () => new Map(destinations.map((destination) => [destination.id, destination])),
    [destinations],
  )

  const [destinationDialogOpen, setDestinationDialogOpen] = useState(false)
  const [destinationForm, setDestinationForm] = useState<DestinationFormState>(defaultDestinationForm())
  const [editingDestination, setEditingDestination] = useState<AlertDestination | null>(null)
  const [savingDestination, setSavingDestination] = useState(false)
  const [testingDestinationId, setTestingDestinationId] = useState<AlertDestination["id"] | null>(null)
  const [deletingDestinationId, setDeletingDestinationId] = useState<AlertDestination["id"] | null>(null)

  const [testingRuleId, setTestingRuleId] = useState<AlertRule["id"] | null>(null)
  const [deletingRuleId, setDeletingRuleId] = useState<AlertRule["id"] | null>(null)

  function handleTabSelect(tab: AlertsTab) {
    navigate({
      search: (prev) => ({
        ...prev,
        tab,
      }),
    })
  }

  function openDestinationDialog(destination?: AlertDestination) {
    setEditingDestination(destination ?? null)
    setDestinationForm(destination ? destinationToFormState(destination) : defaultDestinationForm())
    setDestinationDialogOpen(true)
  }

  async function handleDestinationSave() {
    setSavingDestination(true)
    const form = destinationForm

    let result: Exit.Exit<unknown, unknown>

    if (editingDestination) {
      switch (form.type) {
        case "slack":
          result = await updateDestination({
            params: { destinationId: editingDestination.id },
            payload: {
              type: "slack",
              name: form.name.trim() || undefined,
              enabled: form.enabled,
              channelLabel: form.channelLabel.trim() || undefined,
              webhookUrl: form.webhookUrl.trim() || undefined,
            },
          })
          break
        case "pagerduty":
          result = await updateDestination({
            params: { destinationId: editingDestination.id },
            payload: {
              type: "pagerduty",
              name: form.name.trim() || undefined,
              enabled: form.enabled,
              integrationKey: form.integrationKey.trim() || undefined,
            },
          })
          break
        case "webhook":
          result = await updateDestination({
            params: { destinationId: editingDestination.id },
            payload: {
              type: "webhook",
              name: form.name.trim() || undefined,
              enabled: form.enabled,
              url: form.url.trim() || undefined,
              signingSecret: form.signingSecret.trim() || undefined,
            },
          })
          break
      }
    } else {
      switch (form.type) {
        case "slack":
          result = await createDestination({
            payload: {
              type: "slack",
              name: form.name.trim(),
              enabled: form.enabled,
              webhookUrl: form.webhookUrl.trim(),
              channelLabel: form.channelLabel.trim() || undefined,
            },
          })
          break
        case "pagerduty":
          result = await createDestination({
            payload: {
              type: "pagerduty",
              name: form.name.trim(),
              enabled: form.enabled,
              integrationKey: form.integrationKey.trim(),
            },
          })
          break
        case "webhook":
          result = await createDestination({
            payload: {
              type: "webhook",
              name: form.name.trim(),
              enabled: form.enabled,
              url: form.url.trim(),
              signingSecret: form.signingSecret.trim() || undefined,
            },
          })
          break
      }
    }

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
    const result = await (() => {
      switch (destination.type) {
        case "slack":
          return updateDestination({
            params: { destinationId: destination.id },
            payload: {
              type: "slack",
              enabled: !destination.enabled,
            },
          })
        case "pagerduty":
          return updateDestination({
            params: { destinationId: destination.id },
            payload: {
              type: "pagerduty",
              enabled: !destination.enabled,
            },
          })
        case "webhook":
          return updateDestination({
            params: { destinationId: destination.id },
            payload: {
              type: "webhook",
              enabled: !destination.enabled,
            },
          })
      }
    })()
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
      toast.error(getExitErrorMessage(result, "Failed to delete destination"))
    }
    setDeletingDestinationId(null)
  }

  async function handleRuleToggle(rule: AlertRule) {
    const result = await updateRule({
      params: { ruleId: rule.id },
      payload: new AlertRuleUpsertRequest({
        ...rule,
        enabled: !rule.enabled,
        serviceName: rule.serviceName ?? null,
        metricName: rule.metricName ?? null,
        metricType: rule.metricType ?? null,
        metricAggregation: rule.metricAggregation ?? null,
        apdexThresholdMs: rule.apdexThresholdMs ?? null,
        destinationIds: [...rule.destinationIds],
      }),
    })

    if (Exit.isSuccess(result)) {
      refreshRules()
    } else {
      toast.error(getExitErrorMessage(result, "Failed to update rule"))
    }
  }

  async function handleRuleSendTest(rule: AlertRule) {
    setTestingRuleId(rule.id)
    const result = await testRule({
      payload: new AlertRuleTestRequest({
        rule: new AlertRuleUpsertRequest({
          ...rule,
          serviceName: rule.serviceName ?? null,
          metricName: rule.metricName ?? null,
          metricType: rule.metricType ?? null,
          metricAggregation: rule.metricAggregation ?? null,
          apdexThresholdMs: rule.apdexThresholdMs ?? null,
          destinationIds: [...rule.destinationIds],
        }),
        sendNotification: true,
      }),
    })

    if (Exit.isSuccess(result)) {
      toast.success("Rule test sent")
      refreshDeliveryEvents()
      refreshDestinations()
    } else {
      toast.error(getExitErrorMessage(result, "Failed to send rule test"))
    }

    setTestingRuleId(null)
  }

  async function handleRuleDelete(rule: AlertRule) {
    setDeletingRuleId(rule.id)
    const result = await deleteRule({ params: { ruleId: rule.id } })
    if (Exit.isSuccess(result)) {
      toast.success("Rule deleted")
      refreshRules()
      refreshIncidents()
    } else {
      toast.error(getExitErrorMessage(result, "Failed to delete rule"))
    }
    setDeletingRuleId(null)
  }

  const title = activeTab === "rules"
    ? "Alert Rules"
    : activeTab === "incidents"
      ? "Incidents"
      : "Destinations"
  const description = activeTab === "rules"
    ? "Build threshold-based service alerts with previewable evaluations and reusable destinations."
    : activeTab === "incidents"
      ? "Track open incidents, recoveries, and every delivery attempt emitted by Maple."
      : "Manage reusable Slack, PagerDuty, and signed webhook destinations."

  return (
    <>
      <DashboardLayout
        breadcrumbs={[
          { label: "Alerts", href: "/alerts" },
          { label: title },
        ]}
        title={title}
        description={description}
        filterSidebar={<AlertNav activeTab={activeTab} onSelect={handleTabSelect} />}
      >
        <div className="space-y-6">
          {search.serviceName && activeTab === "rules" && (
            <Card>
              <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-sm font-medium">Prefilled for service</div>
                  <div className="text-muted-foreground mt-1 text-sm">
                    New rules will default to <span className="font-mono">{search.serviceName}</span>.
                  </div>
                </div>
                {isAdmin && (
                  <Button size="sm" asChild>
                    <Link to="/alerts/create" search={{ serviceName: search.serviceName }}>
                      <PlusIcon size={14} />
                      Create Rule
                    </Link>
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          {activeTab === "rules" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-muted-foreground text-sm">
                  Threshold-only rules evaluate every minute and open incidents after consecutive breaches.
                </div>
                {isAdmin && (
                  <Button size="sm" asChild>
                    <Link to="/alerts/create" search={{ serviceName: search.serviceName }}>
                      <PlusIcon size={14} />
                      Add Rule
                    </Link>
                  </Button>
                )}
              </div>

              {Result.isInitial(rulesResult) ? (
                <div className="space-y-3">
                  <Skeleton className="h-28 w-full" />
                  <Skeleton className="h-28 w-full" />
                </div>
              ) : !Result.isSuccess(rulesResult) ? (
                <div className="text-muted-foreground py-8 text-center text-sm">
                  Failed to load alert rules.
                </div>
              ) : rules.length === 0 ? (
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
                    <Button size="sm" asChild>
                      <Link to="/alerts/create" search={{ serviceName: search.serviceName }}>
                        <PlusIcon size={14} />
                        Add Rule
                      </Link>
                    </Button>
                  )}
                </Empty>
              ) : (
                <div className="space-y-3">
                  {rules.map((rule) => (
                    <Card key={rule.id}>
                      <CardContent className="space-y-4 p-4">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="text-sm font-semibold">{rule.name}</div>
                              <Badge variant="outline" className={severityTone[rule.severity]}>
                                {rule.severity}
                              </Badge>
                              <Badge variant="outline">
                                {rule.enabled ? "Enabled" : "Disabled"}
                              </Badge>
                              <Badge variant="outline">{signalLabels[rule.signalType]}</Badge>
                            </div>
                            <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                              <span>{rule.serviceName ? `Service: ${rule.serviceName}` : "Scope: all services"}</span>
                              <span>
                                Condition: {comparatorLabels[rule.comparator]} {formatSignalValue(rule.signalType, rule.threshold)}
                              </span>
                              <span>Window: {rule.windowMinutes}m</span>
                              <span>Min samples: {rule.minimumSampleCount}</span>
                              <span>Renotify: {rule.renotifyIntervalMinutes}m</span>
                            </div>
                            {rule.signalType === "metric" && (
                              <div className="text-muted-foreground text-xs">
                                Metric: <span className="font-mono">{rule.metricName}</span>
                                {" · "}
                                {rule.metricType ? metricTypeLabels[rule.metricType] : "Unknown"}
                                {" · "}
                                {rule.metricAggregation ? metricAggregationLabels[rule.metricAggregation] : "Unknown"}
                              </div>
                            )}
                            {rule.signalType === "apdex" && rule.apdexThresholdMs != null && (
                              <div className="text-muted-foreground text-xs">
                                Apdex threshold: {formatLatency(rule.apdexThresholdMs)}
                              </div>
                            )}
                            <div className="flex flex-wrap gap-2">
                              {rule.destinationIds.map((destinationId) => {
                                const destination = destinationsById.get(destinationId)
                                return (
                                  <Badge key={destinationId} variant="secondary">
                                    {destination?.name ?? destinationId}
                                  </Badge>
                                )
                              })}
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <Switch checked={rule.enabled} onCheckedChange={() => handleRuleToggle(rule)} disabled={!isAdmin} />
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleRuleSendTest(rule)}
                              disabled={!isAdmin || testingRuleId === rule.id}
                            >
                              {testingRuleId === rule.id ? <LoaderIcon size={14} className="animate-spin" /> : <EyeIcon size={14} />}
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
                                  <DropdownMenuItem
                                    onClick={() => navigate({ to: "/alerts/create", search: { ruleId: rule.id } })}
                                  >
                                    <PencilIcon size={14} />
                                    Edit
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    variant="destructive"
                                    onClick={() => handleRuleDelete(rule)}
                                    disabled={deletingRuleId === rule.id}
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
            </div>
          )}

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
                              <span>
                                Samples: {incident.lastSampleCount == null ? "n/a" : formatNumber(incident.lastSampleCount)}
                              </span>
                              <span>Triggered {formatRelativeTime(incident.lastTriggeredAt)}</span>
                              <span>Last notified {formatDateTime(incident.lastNotifiedAt)}</span>
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
                          <span>First triggered {formatDateTime(incident.firstTriggeredAt)}</span>
                          <span>Resolved {formatDateTime(incident.resolvedAt)}</span>
                          <span>Dedupe key {incident.dedupeKey}</span>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}

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
                  ) : deliveryEvents.length === 0 ? (
                    <div className="text-muted-foreground py-8 text-center text-sm">
                      No delivery events yet.
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
                                <span>{formatDateTime(event.scheduledAt)}</span>
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
            </div>
          )}

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
                            <span>{formatDateTime(destination.lastTestedAt)}</span>
                            {destination.channelLabel && <span>Channel {destination.channelLabel}</span>}
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

      <Dialog open={destinationDialogOpen} onOpenChange={setDestinationDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingDestination ? "Edit Destination" : "Add Destination"}</DialogTitle>
            <DialogDescription>
              Reuse the same destination across multiple alert rules and verify it with synthetic test events.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {!editingDestination && (
              <div className="space-y-2">
                <Label htmlFor="destination-type">Type</Label>
                <Select
                  value={destinationForm.type}
                  onValueChange={(value) => {
                    if (!value) return
                    setDestinationForm(defaultDestinationForm(value))
                  }}
                >
                  <SelectTrigger id="destination-type">
                    <SelectValue placeholder="Select destination type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="slack">Slack</SelectItem>
                    <SelectItem value="pagerduty">PagerDuty</SelectItem>
                    <SelectItem value="webhook">Webhook</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="destination-name">Name</Label>
              <Input
                id="destination-name"
                value={destinationForm.name}
                onChange={(event) => setDestinationForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Production paging"
              />
            </div>

            {destinationForm.type === "slack" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="destination-webhook">Slack webhook URL</Label>
                  <Input
                    id="destination-webhook"
                    value={destinationForm.webhookUrl}
                    onChange={(event) => setDestinationForm((current) => ({ ...current, webhookUrl: event.target.value }))}
                    placeholder={editingDestination ? "Leave blank to keep current webhook" : "https://hooks.slack.com/services/..."}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="destination-channel">Channel label</Label>
                  <Input
                    id="destination-channel"
                    value={destinationForm.channelLabel}
                    onChange={(event) => setDestinationForm((current) => ({ ...current, channelLabel: event.target.value }))}
                    placeholder="#ops-alerts"
                  />
                </div>
              </>
            )}

            {destinationForm.type === "pagerduty" && (
              <div className="space-y-2">
                <Label htmlFor="destination-integration">Integration key</Label>
                <Input
                  id="destination-integration"
                  value={destinationForm.integrationKey}
                  onChange={(event) => setDestinationForm((current) => ({ ...current, integrationKey: event.target.value }))}
                  placeholder={editingDestination ? "Leave blank to keep current key" : "Routing key"}
                />
              </div>
            )}

            {destinationForm.type === "webhook" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="destination-url">Webhook URL</Label>
                  <Input
                    id="destination-url"
                    value={destinationForm.url}
                    onChange={(event) => setDestinationForm((current) => ({ ...current, url: event.target.value }))}
                    placeholder={editingDestination ? "Leave blank to keep current URL" : "https://example.com/maple-alerts"}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="destination-secret">Signing secret</Label>
                  <Input
                    id="destination-secret"
                    value={destinationForm.signingSecret}
                    onChange={(event) => setDestinationForm((current) => ({ ...current, signingSecret: event.target.value }))}
                    placeholder={editingDestination ? "Leave blank to keep current secret" : "Optional HMAC secret"}
                  />
                </div>
              </>
            )}

            <div className="flex items-center justify-between rounded-lg border px-3 py-2">
              <div>
                <div className="text-sm font-medium">Enabled</div>
                <div className="text-muted-foreground text-xs">
                  Disabled destinations stay attached to rules but won’t receive notifications.
                </div>
              </div>
              <Switch
                checked={destinationForm.enabled}
                onCheckedChange={(enabled) => setDestinationForm((current) => ({ ...current, enabled }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDestinationDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleDestinationSave} disabled={savingDestination}>
              {savingDestination ? <LoaderIcon size={14} className="animate-spin" /> : null}
              {editingDestination ? "Save Changes" : "Create Destination"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </>
  )
}
