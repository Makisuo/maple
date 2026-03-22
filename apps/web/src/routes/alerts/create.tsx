import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { Cause, Exit, Option, Schema } from "effect"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { AlertPreviewChart } from "@/components/alerts/alert-preview-chart"
import {
  type RuleFormState,
  defaultRuleForm,
  ruleToFormState,
  buildRuleRequest,
  buildRuleTestRequest,
  isRulePreviewReady,
  signalLabels,
  comparatorLabels,
  metricTypeLabels,
  metricAggregationLabels,
  destinationTypeLabels,
  formatSignalValue,
  signalToQueryParams,
} from "@/lib/alerts/form-utils"
import {
  AlertRuleUpsertRequest,
  AlertDestinationDocument,
  AlertRuleDocument,
  type AlertComparator,
  type AlertDestinationType,
  type AlertMetricAggregation,
  type AlertMetricType,
  type AlertSeverity,
  type AlertSignalType,
} from "@maple/domain/http"
import {
  BellIcon,
  CheckIcon,
  EyeIcon,
  LoaderIcon,
  XIcon,
} from "@/components/icons"
import { cn } from "@maple/ui/utils"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent } from "@maple/ui/components/ui/card"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@maple/ui/components/ui/select"
import { Switch } from "@maple/ui/components/ui/switch"
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@maple/ui/components/ui/tabs"
import { getCustomChartTimeSeriesResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { computeBucketSeconds } from "@/api/tinybird/timeseries-utils"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"

const AlertCreateSearch = Schema.Struct({
  serviceName: Schema.optional(Schema.String),
  ruleId: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/alerts/create")({
  component: AlertCreatePage,
  validateSearch: Schema.toStandardSchemaV1(AlertCreateSearch),
})

function getExitErrorMessage(exit: Exit.Exit<unknown, unknown>, fallback: string): string {
  if (Exit.isSuccess(exit)) return fallback
  const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
  if (failure instanceof Error && failure.message.trim().length > 0) return failure.message
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
  if (defect instanceof Error && defect.message.trim().length > 0) return defect.message
  return fallback
}

const CHART_BUCKET_TARGET = 96 // ~15min buckets for 24h

function AlertCreatePage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  // Fetch destinations and rules for the pickers / edit mode
  const destinationsQueryAtom = MapleApiAtomClient.query("alerts", "listDestinations", {})
  const rulesQueryAtom = MapleApiAtomClient.query("alerts", "listRules", {})
  const destinationsResult = useAtomValue(destinationsQueryAtom)
  const rulesResult = useAtomValue(rulesQueryAtom)

  const createRule = useAtomSet(MapleApiAtomClient.mutation("alerts", "createRule"), { mode: "promiseExit" })
  const updateRule = useAtomSet(MapleApiAtomClient.mutation("alerts", "updateRule"), { mode: "promiseExit" })
  const testRule = useAtomSet(MapleApiAtomClient.mutation("alerts", "testRule"), { mode: "promiseExit" })

  const destinations = Result.builder(destinationsResult)
    .onSuccess((response) => [...response.destinations] as AlertDestinationDocument[])
    .orElse(() => [])

  const rules = Result.builder(rulesResult)
    .onSuccess((response) => [...response.rules] as AlertRuleDocument[])
    .orElse(() => [])

  // Edit mode: find existing rule
  const editingRule = useMemo(() => {
    if (!search.ruleId) return null
    return rules.find((r) => r.id === search.ruleId) ?? null
  }, [search.ruleId, rules])

  // Form state
  const [ruleForm, setRuleForm] = useState<RuleFormState>(() =>
    defaultRuleForm(search.serviceName),
  )
  const [savingRule, setSavingRule] = useState(false)
  const [previewingRule, setPreviewingRule] = useState(false)
  const [previewResult, setPreviewResult] = useState<{
    status: "breached" | "healthy" | "skipped"
    value: number | null
    sampleCount: number
    reason: string
  } | null>(null)
  const [initialized, setInitialized] = useState(false)

  // Populate form when editing
  useEffect(() => {
    if (editingRule && !initialized) {
      setRuleForm(ruleToFormState(editingRule))
      setInitialized(true)
    }
  }, [editingRule, initialized])

  // Time range for chart: last 24 hours
  const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, "24h")
  const bucketSeconds = useMemo(
    () => computeBucketSeconds(startTime, endTime, CHART_BUCKET_TARGET),
    [startTime, endTime],
  )

  // Build chart query from form state
  const queryParams = useMemo(() => signalToQueryParams(ruleForm), [ruleForm])

  const chartQueryInput = useMemo(() => {
    if (!queryParams) return null
    return {
      data: {
        source: queryParams.source as "traces" | "metrics",
        metric: queryParams.metric,
        groupBy: "none" as const,
        startTime,
        endTime,
        bucketSeconds,
        filters: queryParams.filters as Record<string, string | boolean | string[] | undefined>,
      },
    }
  }, [queryParams, startTime, endTime, bucketSeconds])

  const chartResult = useAtomValue(
    chartQueryInput
      ? getCustomChartTimeSeriesResultAtom(chartQueryInput)
      : getCustomChartTimeSeriesResultAtom({
          data: {
            source: "traces",
            metric: "count",
            groupBy: "none",
            startTime,
            endTime,
            bucketSeconds,
          },
        }),
  )

  // Flatten chart data from { bucket, series: { key: val } } → { bucket, key: val }
  const chartData = useMemo(() => {
    if (!chartQueryInput) return []
    return Result.builder(chartResult)
      .onSuccess((response) =>
        response.data.map((point) => ({
          bucket: point.bucket,
          ...point.series,
        })),
      )
      .orElse(() => [])
  }, [chartResult, chartQueryInput])

  const chartLoading = !chartQueryInput || Result.isInitial(chartResult)
  const threshold = Number(ruleForm.threshold)

  // Handlers
  async function handleSave() {
    setSavingRule(true)
    const payload = buildRuleRequest(ruleForm)
    const result = editingRule
      ? await updateRule({ params: { ruleId: editingRule.id }, payload })
      : await createRule({ payload })

    if (Exit.isSuccess(result)) {
      toast.success(editingRule ? "Rule updated" : "Rule created")
      navigate({ to: "/alerts", search: { tab: "rules" } })
    } else {
      toast.error(getExitErrorMessage(result, "Failed to save rule"))
    }
    setSavingRule(false)
  }

  async function handleTestNotification() {
    if (!isRulePreviewReady(ruleForm)) {
      toast.error("Complete the rule name and threshold before testing")
      return
    }
    setPreviewingRule(true)
    const result = await testRule({
      payload: buildRuleTestRequest(ruleForm, ruleForm.destinationIds.length > 0),
    })
    if (Exit.isSuccess(result)) {
      setPreviewResult(result.value)
      toast.success(
        ruleForm.destinationIds.length > 0
          ? "Preview ran and sent a test notification"
          : "Preview updated",
      )
    } else {
      toast.error(getExitErrorMessage(result, "Failed to preview rule"))
    }
    setPreviewingRule(false)
  }

  const pageTitle = editingRule ? "Edit Alert Rule" : "New Alert Rule"

  return (
    <DashboardLayout
      breadcrumbs={[
        { label: "Alerts", href: "/alerts" },
        { label: pageTitle },
      ]}
      title={pageTitle}
      description="Define a threshold, preview the signal, and save the alert rule."
    >
      <div className="space-y-6 max-w-4xl">
        {/* Chart Preview */}
        <Card>
          <CardContent className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-medium text-muted-foreground">
                Signal Preview — last 24 hours
              </div>
              {previewResult && (
                <Badge
                  variant="outline"
                  className={cn(
                    previewResult.status === "breached"
                      ? "border-destructive/30 text-destructive"
                      : previewResult.status === "healthy"
                        ? "border-green-500/30 text-green-600"
                        : "text-muted-foreground",
                  )}
                >
                  {previewResult.status} · {formatSignalValue(ruleForm.signalType, previewResult.value)}
                </Badge>
              )}
            </div>
            <AlertPreviewChart
              data={chartData}
              threshold={Number.isFinite(threshold) ? threshold : 0}
              signalType={ruleForm.signalType}
              loading={chartLoading}
              className="h-[280px] w-full"
            />
          </CardContent>
        </Card>

        {/* Signal Type Tabs */}
        <div>
          <Label className="mb-2 block">Signal Type</Label>
          <Tabs
            value={ruleForm.signalType}
            onValueChange={(value) =>
              setRuleForm((current) => ({
                ...current,
                signalType: value as AlertSignalType,
              }))
            }
          >
            <TabsList variant="line">
              <TabsTrigger value="error_rate">Error Rate</TabsTrigger>
              <TabsTrigger value="p95_latency">P95 Latency</TabsTrigger>
              <TabsTrigger value="p99_latency">P99 Latency</TabsTrigger>
              <TabsTrigger value="apdex">Apdex</TabsTrigger>
              <TabsTrigger value="throughput">Throughput</TabsTrigger>
              <TabsTrigger value="metric">Metric</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* Metric-specific fields */}
        {ruleForm.signalType === "metric" && (
          <Card>
            <CardContent className="grid gap-4 p-4 sm:grid-cols-3">
              <div className="space-y-2 sm:col-span-3">
                <Label htmlFor="metric-name">Metric name</Label>
                <Input
                  id="metric-name"
                  value={ruleForm.metricName}
                  onChange={(e) => setRuleForm((c) => ({ ...c, metricName: e.target.value }))}
                  placeholder="http.server.duration"
                />
              </div>
              <div className="space-y-2">
                <Label>Metric type</Label>
                <Select
                  value={ruleForm.metricType}
                  onValueChange={(value) =>
                    setRuleForm((c) => ({ ...c, metricType: value as AlertMetricType }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(metricTypeLabels).map(([val, label]) => (
                      <SelectItem key={val} value={val}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Aggregation</Label>
                <Select
                  value={ruleForm.metricAggregation}
                  onValueChange={(value) =>
                    setRuleForm((c) => ({ ...c, metricAggregation: value as AlertMetricAggregation }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(metricAggregationLabels).map(([val, label]) => (
                      <SelectItem key={val} value={val}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Apdex threshold */}
        {ruleForm.signalType === "apdex" && (
          <div className="space-y-2">
            <Label htmlFor="apdex-threshold">Apdex threshold (ms)</Label>
            <Input
              id="apdex-threshold"
              type="number"
              value={ruleForm.apdexThresholdMs}
              onChange={(e) => setRuleForm((c) => ({ ...c, apdexThresholdMs: e.target.value }))}
              className="max-w-[200px]"
            />
          </div>
        )}

        {/* Main Form */}
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="rule-name">Rule name</Label>
              <Input
                id="rule-name"
                value={ruleForm.name}
                onChange={(e) => setRuleForm((c) => ({ ...c, name: e.target.value }))}
                placeholder="Checkout error rate"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rule-service">Service scope</Label>
              <Input
                id="rule-service"
                value={ruleForm.serviceName}
                onChange={(e) => setRuleForm((c) => ({ ...c, serviceName: e.target.value }))}
                placeholder="Leave blank for all services"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>Severity</Label>
              <Select
                value={ruleForm.severity}
                onValueChange={(value) =>
                  setRuleForm((c) => ({ ...c, severity: value as AlertSeverity }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="warning">Warning</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Comparator</Label>
              <Select
                value={ruleForm.comparator}
                onValueChange={(value) =>
                  setRuleForm((c) => ({ ...c, comparator: value as AlertComparator }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(comparatorLabels).map(([val, label]) => (
                    <SelectItem key={val} value={val}>
                      {label} ({val === "gt" ? "Greater than" : val === "gte" ? "Greater or equal" : val === "lt" ? "Less than" : "Less or equal"})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="rule-threshold">Threshold</Label>
              <Input
                id="rule-threshold"
                type="number"
                value={ruleForm.threshold}
                onChange={(e) => setRuleForm((c) => ({ ...c, threshold: e.target.value }))}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="rule-window">Window (minutes)</Label>
              <Input
                id="rule-window"
                type="number"
                value={ruleForm.windowMinutes}
                onChange={(e) => setRuleForm((c) => ({ ...c, windowMinutes: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rule-min-samples">Minimum samples</Label>
              <Input
                id="rule-min-samples"
                type="number"
                value={ruleForm.minimumSampleCount}
                onChange={(e) => setRuleForm((c) => ({ ...c, minimumSampleCount: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rule-breaches">Breaches to open</Label>
              <Input
                id="rule-breaches"
                type="number"
                value={ruleForm.consecutiveBreachesRequired}
                onChange={(e) => setRuleForm((c) => ({ ...c, consecutiveBreachesRequired: e.target.value }))}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="rule-healthy">Healthy runs to resolve</Label>
              <Input
                id="rule-healthy"
                type="number"
                value={ruleForm.consecutiveHealthyRequired}
                onChange={(e) => setRuleForm((c) => ({ ...c, consecutiveHealthyRequired: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rule-renotify">Renotify interval (min)</Label>
              <Input
                id="rule-renotify"
                type="number"
                value={ruleForm.renotifyIntervalMinutes}
                onChange={(e) => setRuleForm((c) => ({ ...c, renotifyIntervalMinutes: e.target.value }))}
              />
            </div>
          </div>
        </div>

        {/* Destinations */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Destinations</div>
                <div className="text-muted-foreground text-xs">
                  Pick one or more reusable destinations for this rule.
                </div>
              </div>
              <Badge variant="outline">{ruleForm.destinationIds.length} selected</Badge>
            </div>

            {destinations.length === 0 ? (
              <div className="text-muted-foreground mt-3 text-sm">
                <Link to="/alerts" search={{ tab: "destinations" }} className="underline">
                  Create a destination
                </Link>{" "}
                before saving this rule.
              </div>
            ) : (
              <div className="mt-3 grid gap-2">
                {destinations.map((destination) => {
                  const selected = ruleForm.destinationIds.includes(destination.id)
                  return (
                    <button
                      key={destination.id}
                      type="button"
                      className={cn(
                        "flex items-center justify-between rounded-md border px-3 py-2 text-left transition-colors",
                        selected ? "border-primary/40 bg-primary/5" : "hover:bg-muted/50",
                      )}
                      onClick={() =>
                        setRuleForm((current) => ({
                          ...current,
                          destinationIds: selected
                            ? current.destinationIds.filter((id) => id !== destination.id)
                            : [...current.destinationIds, destination.id],
                        }))
                      }
                    >
                      <div>
                        <div className="text-sm font-medium">{destination.name}</div>
                        <div className="text-muted-foreground text-xs">
                          {destinationTypeLabels[destination.type]} · {destination.summary}
                        </div>
                      </div>
                      <Badge variant={selected ? "default" : "outline"}>
                        {selected ? "Selected" : "Select"}
                      </Badge>
                    </button>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Enabled toggle */}
        <div className="flex items-center justify-between rounded-lg border px-3 py-2">
          <div>
            <div className="text-sm font-medium">Rule enabled</div>
            <div className="text-muted-foreground text-xs">
              Disabled rules stay saved but won't be evaluated by the worker.
            </div>
          </div>
          <Switch
            checked={ruleForm.enabled}
            onCheckedChange={(enabled) => setRuleForm((c) => ({ ...c, enabled }))}
          />
        </div>

        {/* Bottom action bar */}
        <div className="flex items-center justify-between border-t pt-4">
          <Button variant="outline" asChild>
            <Link to="/alerts" search={{ tab: "rules" }}>
              Discard
            </Link>
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleTestNotification}
              disabled={previewingRule}
            >
              {previewingRule ? (
                <LoaderIcon size={14} className="animate-spin" />
              ) : (
                <EyeIcon size={14} />
              )}
              Test Notification
            </Button>
            <Button
              onClick={handleSave}
              disabled={savingRule || destinations.length === 0}
            >
              {savingRule ? <LoaderIcon size={14} className="animate-spin" /> : <CheckIcon size={14} />}
              {editingRule ? "Save Changes" : "Save Alert Rule"}
            </Button>
          </div>
        </div>
      </div>
    </DashboardLayout>
  )
}
