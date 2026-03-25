import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { Exit, Schema } from "effect"
import { useEffect, useMemo, useRef, useState } from "react"
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
  getExitErrorMessage,
  comparatorLabels,
  metricTypeLabels,
  metricAggregationLabels,
  destinationTypeLabels,
  signalLabels,
  formatSignalValue,
} from "@/lib/alerts/form-utils"
import {
  AlertDestinationDocument,
  AlertRuleDocument,
  type AlertComparator,
  type AlertMetricAggregation,
  type AlertMetricType,
  type AlertSignalType,
} from "@maple/domain/http"
import {
  EyeIcon,
  LoaderIcon,
} from "@/components/icons"
import { cn } from "@maple/ui/utils"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent } from "@maple/ui/components/ui/card"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
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
  Combobox,
  ComboboxChips,
  ComboboxChip,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
} from "@maple/ui/components/ui/combobox"
import {
  getLogsFacetsResultAtom,
  getTracesFacetsResultAtom,
  getSpanAttributeKeysResultAtom,
  getSpanAttributeValuesResultAtom,
  getResourceAttributeKeysResultAtom,
  getResourceAttributeValuesResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useAlertRuleChart } from "@/hooks/use-alert-rule-chart"
import { AGGREGATIONS_BY_SOURCE, QUERY_BUILDER_METRIC_TYPES } from "@/lib/query-builder/model"
import type { WhereClauseAutocompleteValues } from "@/lib/query-builder/where-clause-autocomplete"
import { WhereClauseEditor } from "@/components/query-builder/where-clause-editor"

const AlertCreateSearch = Schema.Struct({
  serviceName: Schema.optional(Schema.String),
  ruleId: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/alerts/create")({
  component: AlertCreatePage,
  validateSearch: Schema.toStandardSchemaV1(AlertCreateSearch),
})

const signalTypes = Object.entries(signalLabels).map(([value, label]) => ({
  value: value as AlertSignalType,
  label,
}))

function AlertCreatePage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  const destinationsQueryAtom = MapleApiAtomClient.query("alerts", "listDestinations", {})
  const rulesQueryAtom = MapleApiAtomClient.query("alerts", "listRules", {})
  const destinationsResult = useAtomValue(destinationsQueryAtom)
  const rulesResult = useAtomValue(rulesQueryAtom)

  const createRule = useAtomSet(MapleApiAtomClient.mutation("alerts", "createRule"), { mode: "promiseExit" })
  const updateRule = useAtomSet(MapleApiAtomClient.mutation("alerts", "updateRule"), { mode: "promiseExit" })
  const testRule = useAtomSet(MapleApiAtomClient.mutation("alerts", "testRule"), { mode: "promiseExit" })

  const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, "24h")
  const [activeAttributeKey, setActiveAttributeKey] = useState<string | null>(null)
  const [activeResourceAttributeKey, setActiveResourceAttributeKey] = useState<string | null>(null)

  const facetsResult = useAtomValue(getTracesFacetsResultAtom({ data: {} }))
  const serviceNameOptions = useMemo(() =>
    Result.builder(facetsResult)
      .onSuccess((response) => response.data.services.map((s) => s.name))
      .orElse(() => [] as string[]),
    [facetsResult],
  )

  const logsFacetsResult = useAtomValue(getLogsFacetsResultAtom({ data: {} }))

  const spanAttributeKeysResult = useAtomValue(
    getSpanAttributeKeysResultAtom({ data: { startTime, endTime } }),
  )
  const spanAttributeValuesResult = useAtomValue(
    getSpanAttributeValuesResultAtom({
      data: { startTime, endTime, attributeKey: activeAttributeKey ?? "" },
    }),
  )
  const resourceAttributeKeysResult = useAtomValue(
    getResourceAttributeKeysResultAtom({ data: { startTime, endTime } }),
  )
  const resourceAttributeValuesResult = useAtomValue(
    getResourceAttributeValuesResultAtom({
      data: { startTime, endTime, attributeKey: activeResourceAttributeKey ?? "" },
    }),
  )

  const attributeKeys = useMemo(
    () =>
      Result.builder(spanAttributeKeysResult)
        .onSuccess((response) => response.data.map((row) => row.attributeKey))
        .orElse(() => [] as string[]),
    [spanAttributeKeysResult],
  )
  const attributeValues = useMemo(
    () =>
      activeAttributeKey
        ? Result.builder(spanAttributeValuesResult)
            .onSuccess((response) => response.data.map((row) => row.attributeValue))
            .orElse(() => [] as string[])
        : [],
    [activeAttributeKey, spanAttributeValuesResult],
  )
  const resourceAttributeKeys = useMemo(
    () =>
      Result.builder(resourceAttributeKeysResult)
        .onSuccess((response) => response.data.map((row) => row.attributeKey))
        .orElse(() => [] as string[]),
    [resourceAttributeKeysResult],
  )
  const resourceAttributeValues = useMemo(
    () =>
      activeResourceAttributeKey
        ? Result.builder(resourceAttributeValuesResult)
            .onSuccess((response) => response.data.map((row) => row.attributeValue))
            .orElse(() => [] as string[])
        : [],
    [activeResourceAttributeKey, resourceAttributeValuesResult],
  )

  const autocompleteValues = useMemo(() => {
    const tracesFacets = Result.builder(facetsResult)
      .onSuccess((response) => response.data)
      .orElse(() => ({ services: [] as { name: string }[], spanNames: [] as { name: string }[], deploymentEnvs: [] as { name: string }[] }))

    const logsFacets = Result.builder(logsFacetsResult)
      .onSuccess((response) => response.data)
      .orElse(() => ({ services: [] as { name: string }[], severities: [] as { name: string }[] }))

    const toNames = (items: Array<{ name: string }>): string[] => {
      const seen = new Set<string>()
      const values: string[] = []
      for (const item of items) {
        const next = item.name.trim()
        if (!next || seen.has(next)) continue
        seen.add(next)
        values.push(next)
      }
      return values
    }

    return {
      traces: {
        services: toNames(tracesFacets.services),
        spanNames: toNames(tracesFacets.spanNames),
        environments: toNames(tracesFacets.deploymentEnvs),
        attributeKeys,
        attributeValues,
        resourceAttributeKeys,
        resourceAttributeValues,
      } satisfies WhereClauseAutocompleteValues,
      logs: {
        services: toNames(logsFacets.services),
        severities: toNames(logsFacets.severities),
        attributeKeys,
        attributeValues,
        resourceAttributeKeys,
        resourceAttributeValues,
      } satisfies WhereClauseAutocompleteValues,
      metrics: {
        services: toNames(tracesFacets.services),
        metricTypes: [...QUERY_BUILDER_METRIC_TYPES],
      } satisfies WhereClauseAutocompleteValues,
    }
  }, [facetsResult, logsFacetsResult, attributeKeys, attributeValues, resourceAttributeKeys, resourceAttributeValues])

  const destinations = Result.builder(destinationsResult)
    .onSuccess((response) => [...response.destinations] as AlertDestinationDocument[])
    .orElse(() => [])

  const rules = Result.builder(rulesResult)
    .onSuccess((response) => [...response.rules] as AlertRuleDocument[])
    .orElse(() => [])

  const editingRule = useMemo(() => {
    if (!search.ruleId) return null
    return rules.find((r) => r.id === search.ruleId) ?? null
  }, [search.ruleId, rules])

  const [ruleForm, setRuleForm] = useState<RuleFormState>(() => defaultRuleForm(search.serviceName))
  const [savingRule, setSavingRule] = useState(false)
  const [previewingRule, setPreviewingRule] = useState(false)
  const [previewResult, setPreviewResult] = useState<{
    status: "breached" | "healthy" | "skipped"
    value: number | null
    sampleCount: number
    reason: string
  } | null>(null)
  const [initialized, setInitialized] = useState(false)

  useEffect(() => {
    if (editingRule && !initialized) {
      setRuleForm(ruleToFormState(editingRule))
      setInitialized(true)
    }
  }, [editingRule, initialized])

  const { chartData, chartLoading } = useAlertRuleChart(ruleForm)
  const threshold = Number(ruleForm.threshold)

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

  const pageTitle = editingRule ? "Edit Alert Rule" : "Create Alert Rule"

  return (
    <DashboardLayout
      breadcrumbs={[
        { label: "Alert Rules", href: "/alerts?tab=rules" },
        { label: editingRule ? "Edit Rule" : "New Rule" },
      ]}
      titleContent={
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight truncate">{pageTitle}</h1>
          <Badge variant="secondary" className="text-xs font-medium">Beta</Badge>
        </div>
      }
      headerActions={
        <div className="flex items-center gap-2">
          <Button variant="outline" render={<Link to="/alerts" search={{ tab: "rules" }} />}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={savingRule || destinations.length === 0}
          >
            {savingRule && <LoaderIcon size={14} className="animate-spin" />}
            Save Rule
          </Button>
        </div>
      }
    >
      <div className="flex gap-6">
        {/* ─── Left Column: Form ─── */}
        <div className="flex-1 min-w-0 space-y-6">
          {/* Signal Type */}
          <div>
            <Label className="mb-2 block">Signal Type</Label>
            <div className="flex flex-wrap gap-1.5">
              {signalTypes.map((st) => (
                <button
                  key={st.value}
                  type="button"
                  onClick={() => setRuleForm((c) => ({ ...c, signalType: st.value }))}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                    ruleForm.signalType === st.value
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                  )}
                >
                  {st.label}
                </button>
              ))}
            </div>
          </div>

          {/* Condition - inline builder */}
          <div>
            <Label className="mb-2 block">Condition</Label>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="shrink-0 text-sm py-1.5 px-3">
                {ruleForm.signalType === "query"
                  ? `${ruleForm.queryDataSource}.${ruleForm.queryAggregation}`
                  : signalLabels[ruleForm.signalType]}
              </Badge>
              <Select
                value={ruleForm.comparator}
                onValueChange={(value) => setRuleForm((c) => ({ ...c, comparator: value as AlertComparator }))}
              >
                <SelectTrigger className="w-[70px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(comparatorLabels).map(([val, label]) => (
                    <SelectItem key={val} value={val}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="number"
                value={ruleForm.threshold}
                onChange={(e) => setRuleForm((c) => ({ ...c, threshold: e.target.value }))}
                className="w-[100px]"
                placeholder="5"
              />
              <span className="text-muted-foreground text-sm shrink-0">over</span>
              <Input
                type="number"
                value={ruleForm.windowMinutes}
                onChange={(e) => setRuleForm((c) => ({ ...c, windowMinutes: e.target.value }))}
                className="w-[80px]"
                placeholder="5"
              />
              <span className="text-muted-foreground text-sm shrink-0">min</span>
            </div>
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
                    onValueChange={(value) => setRuleForm((c) => ({ ...c, metricType: value as AlertMetricType }))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
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
                    onValueChange={(value) => setRuleForm((c) => ({ ...c, metricAggregation: value as AlertMetricAggregation }))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
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

          {/* Custom Query builder */}
          {ruleForm.signalType === "query" && (
            <Card>
              <CardContent className="grid gap-4 p-4">
                <div className="space-y-2">
                  <Label>Data Source</Label>
                  <div className="flex gap-1.5">
                    {(["traces", "logs", "metrics"] as const).map((ds) => (
                      <button
                        key={ds}
                        type="button"
                        onClick={() =>
                          setRuleForm((c) => ({
                            ...c,
                            queryDataSource: ds,
                            queryAggregation: AGGREGATIONS_BY_SOURCE[ds][0].value,
                          }))
                        }
                        className={cn(
                          "rounded-md border px-3 py-1.5 text-sm font-medium capitalize transition-colors",
                          ruleForm.queryDataSource === ds
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                        )}
                      >
                        {ds}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Aggregation</Label>
                  <Select
                    value={ruleForm.queryAggregation}
                    onValueChange={(value) => { if (value) setRuleForm((c) => ({ ...c, queryAggregation: value })) }}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {AGGREGATIONS_BY_SOURCE[ruleForm.queryDataSource].map((agg) => (
                        <SelectItem key={agg.value} value={agg.value}>{agg.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {ruleForm.queryDataSource === "metrics" && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2 sm:col-span-2">
                      <Label htmlFor="query-metric-name">Metric name</Label>
                      <Input
                        id="query-metric-name"
                        value={ruleForm.metricName}
                        onChange={(e) => setRuleForm((c) => ({ ...c, metricName: e.target.value }))}
                        placeholder="http.server.duration"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Metric type</Label>
                      <Select
                        value={ruleForm.metricType}
                        onValueChange={(value) => setRuleForm((c) => ({ ...c, metricType: value as AlertMetricType }))}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {Object.entries(metricTypeLabels).map(([val, label]) => (
                            <SelectItem key={val} value={val}>{label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <Label>Where</Label>
                  <WhereClauseEditor
                    dataSource={ruleForm.queryDataSource}
                    value={ruleForm.queryWhereClause}
                    onChange={(value) => setRuleForm((c) => ({ ...c, queryWhereClause: value }))}
                    values={autocompleteValues[ruleForm.queryDataSource]}
                    onActiveAttributeKey={setActiveAttributeKey}
                    onActiveResourceAttributeKey={setActiveResourceAttributeKey}
                    rows={2}
                    placeholder='service.name = "payments" AND has_error = true'
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Rule Name + Service */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="rule-name">Rule Name</Label>
              <Input
                id="rule-name"
                value={ruleForm.name}
                onChange={(e) => setRuleForm((c) => ({ ...c, name: e.target.value }))}
                placeholder="Error Rate — Payments"
              />
            </div>
            <div className="space-y-2">
              <Label>Services</Label>
              <ServiceCombobox
                serviceNames={ruleForm.serviceNames}
                options={serviceNameOptions}
                onChange={(values) => setRuleForm((c) => ({
                  ...c,
                  serviceNames: values,
                  groupBy: values.length > 0 ? null : c.groupBy,
                }))}
              />
              {ruleForm.serviceNames.length === 0 && (
                <div className="flex items-center gap-2 mt-1">
                  <Switch
                    checked={ruleForm.groupBy === "service"}
                    onCheckedChange={(checked) =>
                      setRuleForm((c) => ({ ...c, groupBy: checked ? "service" : null }))
                    }
                  />
                  <span className="text-sm">Evaluate each service independently</span>
                </div>
              )}
            </div>
          </div>

          {/* Severity + Consecutive Breaches */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Severity</Label>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setRuleForm((c) => ({ ...c, severity: "warning" }))}
                  className={cn(
                    "rounded-md border px-4 py-1.5 text-sm font-medium transition-colors",
                    ruleForm.severity === "warning"
                      ? "border-yellow-500/50 bg-yellow-500/10 text-yellow-500"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  Warning
                </button>
                <button
                  type="button"
                  onClick={() => setRuleForm((c) => ({ ...c, severity: "critical" }))}
                  className={cn(
                    "rounded-md border px-4 py-1.5 text-sm font-medium transition-colors",
                    ruleForm.severity === "critical"
                      ? "border-red-500/50 bg-red-500/10 text-red-500"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  Critical
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="rule-breaches">Consecutive Breaches</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="rule-breaches"
                  type="number"
                  value={ruleForm.consecutiveBreachesRequired}
                  onChange={(e) => setRuleForm((c) => ({ ...c, consecutiveBreachesRequired: e.target.value }))}
                  className="w-[80px]"
                />
                <span className="text-sm text-muted-foreground">times before alerting</span>
              </div>
            </div>
          </div>

          {/* Notify via */}
          <div>
            <Label className="mb-2 block">Notify via</Label>
            {destinations.length === 0 ? (
              <div className="text-muted-foreground text-sm">
                <Link to="/alerts" search={{ tab: "destinations" }} className="underline">
                  Create a destination
                </Link>{" "}
                before saving this rule.
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {destinations.map((destination) => {
                  const selected = ruleForm.destinationIds.includes(destination.id)
                  return (
                    <button
                      key={destination.id}
                      type="button"
                      className={cn(
                        "flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                        selected
                          ? "border-primary/40 bg-primary/5"
                          : "border-border hover:border-foreground/30",
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
                      <Checkbox checked={selected} />
                      <span className="font-medium">{destination.name}</span>
                      <span className="text-muted-foreground text-xs">{destinationTypeLabels[destination.type]}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* ─── Right Column: Live Preview ─── */}
        <div className="w-[380px] shrink-0 hidden lg:block">
          <Card className="sticky top-0">
            <CardContent className="p-5 space-y-5">
              {/* Header */}
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">Live Preview</h3>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTestNotification}
                  disabled={previewingRule}
                >
                  {previewingRule ? (
                    <LoaderIcon size={14} className="animate-spin" />
                  ) : (
                    <EyeIcon size={14} />
                  )}
                  Test Rule
                </Button>
              </div>

              {/* Current Value */}
              {previewResult && (
                <div className="space-y-1">
                  <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">Current Value</span>
                  <div className="flex items-baseline gap-2">
                    <span className={cn(
                      "text-2xl font-bold font-mono tabular-nums",
                      previewResult.status === "breached" ? "text-red-500" : "text-green-500",
                    )}>
                      {formatSignalValue(ruleForm.signalType, previewResult.value)}
                    </span>
                    <span className="text-muted-foreground text-sm">
                      threshold: {formatSignalValue(ruleForm.signalType, threshold)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-sm">
                    <span className={cn(
                      "size-1.5 rounded-full",
                      previewResult.status === "breached" ? "bg-red-500" : "bg-green-500",
                    )} />
                    <span className={cn(
                      previewResult.status === "breached" ? "text-red-500" : "text-green-500",
                    )}>
                      {previewResult.status === "breached" ? "Would trigger alert" : "Within threshold"}
                    </span>
                  </div>
                </div>
              )}

              {/* Chart */}
              <div className="space-y-2">
                <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                  {signalLabels[ruleForm.signalType]} — Last 24h
                </span>
                <AlertPreviewChart
                  data={chartData}
                  threshold={Number.isFinite(threshold) ? threshold : 0}
                  signalType={ruleForm.signalType}
                  loading={chartLoading}
                  className="h-[180px] w-full"
                />
              </div>

              {/* Rule Summary */}
              <div className="space-y-2">
                <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">Rule Summary</span>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Signal</dt>
                    <dd className="font-medium">{signalLabels[ruleForm.signalType]}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Condition</dt>
                    <dd className="font-mono font-medium">
                      {comparatorLabels[ruleForm.comparator]} {ruleForm.threshold} over {ruleForm.windowMinutes}min
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Service</dt>
                    <dd className="flex flex-wrap gap-1 justify-end">
                      {ruleForm.serviceNames.length > 0
                        ? ruleForm.serviceNames.map((s) => <Badge key={s} variant="outline" className="text-xs">{s}</Badge>)
                        : <span className="font-mono font-medium">{ruleForm.groupBy === "service" ? "all (per service)" : "all"}</span>}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Severity</dt>
                    <dd className={cn(
                      "font-medium capitalize",
                      ruleForm.severity === "critical" ? "text-red-500" : "text-yellow-500",
                    )}>
                      {ruleForm.severity}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Destinations</dt>
                    <dd className="font-medium">{ruleForm.destinationIds.length} selected</dd>
                  </div>
                </dl>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  )
}

function ServiceCombobox({
  serviceNames,
  options,
  onChange,
}: {
  serviceNames: string[]
  options: string[]
  onChange: (values: string[]) => void
}) {
  const anchor = useRef<HTMLDivElement | null>(null)
  return (
    <Combobox multiple value={serviceNames} onValueChange={onChange}>
      <ComboboxChips ref={anchor}>
        {serviceNames.map((name) => (
          <ComboboxChip key={name}>
            {name}
          </ComboboxChip>
        ))}
        <ComboboxChipsInput placeholder={serviceNames.length === 0 ? "All services" : "Add service..."} />
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>No services found.</ComboboxEmpty>
        <ComboboxList>
          {options.map((svc) => (
            <ComboboxItem key={svc} value={svc}>
              {svc}
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
