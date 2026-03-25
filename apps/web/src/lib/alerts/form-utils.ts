import {
  AlertDestinationDocument,
  buildAlertQueryFilterSet,
  AlertIncidentDocument,
  AlertRuleDocument,
  AlertRuleTestRequest,
  AlertRuleUpsertRequest,
  type AlertComparator,
  type AlertDestinationCreateRequest,
  type AlertDestinationId,
  type AlertDestinationType,
  type AlertDestinationUpdateRequest,
  type AlertMetricAggregation,
  type AlertMetricType,
  type AlertQueryAggregation,
  type AlertRuleTestRequest as AlertRuleTestRequestType,
  type AlertSeverity,
  type AlertSignalType,
} from "@maple/domain/http"
import { Cause, Exit, Option } from "effect"
import { formatErrorRate, formatLatency, formatNumber } from "@/lib/format"

export type RuleFormState = {
  name: string
  enabled: boolean
  severity: AlertSeverity
  serviceNames: string[]
  groupBy: "service" | null
  signalType: AlertSignalType
  comparator: AlertComparator
  threshold: string
  windowMinutes: string
  minimumSampleCount: string
  consecutiveBreachesRequired: string
  consecutiveHealthyRequired: string
  renotifyIntervalMinutes: string
  metricName: string
  metricType: AlertMetricType
  metricAggregation: AlertMetricAggregation
  apdexThresholdMs: string
  queryDataSource: "traces" | "logs" | "metrics"
  queryAggregation: string
  queryWhereClause: string
  destinationIds: AlertDestinationId[]
}

export const severityTone: Record<AlertSeverity, string> = {
  warning: "bg-severity-warn/10 text-severity-warn border-severity-warn/20",
  critical: "bg-destructive/10 text-destructive border-destructive/20",
}

export const signalLabels: Record<AlertSignalType, string> = {
  error_rate: "Error rate",
  p95_latency: "P95 latency",
  p99_latency: "P99 latency",
  apdex: "Apdex",
  throughput: "Throughput",
  metric: "Metric",
  query: "Custom Query",
}

export const comparatorLabels: Record<AlertComparator, string> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
}

export const destinationTypeLabels: Record<AlertDestinationType, string> = {
  slack: "Slack",
  pagerduty: "PagerDuty",
  webhook: "Webhook",
}

export const metricTypeLabels: Record<AlertMetricType, string> = {
  sum: "Sum",
  gauge: "Gauge",
  histogram: "Histogram",
  exponential_histogram: "Exponential histogram",
}

export const metricAggregationLabels: Record<AlertMetricAggregation, string> = {
  avg: "Average",
  min: "Minimum",
  max: "Maximum",
  sum: "Sum",
  count: "Count",
}

export function getExitErrorMessage(exit: Exit.Exit<unknown, unknown>, fallback: string): string {
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

export function formatSignalValue(signalType: AlertSignalType, value: number | null): string {
  if (value == null || Number.isNaN(value)) return "n/a"

  switch (signalType) {
    case "error_rate":
      return formatErrorRate(value)
    case "p95_latency":
    case "p99_latency":
      return formatLatency(value)
    case "apdex":
      return value.toFixed(3)
    case "throughput":
    case "metric":
    case "query":
      return formatNumber(value)
  }
}

export function parsePositiveNumber(value: string, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

export function parseNonNegativeNumber(value: string, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return parsed
}

export function defaultRuleForm(serviceName?: string): RuleFormState {
  return {
    name: "",
    enabled: true,
    severity: "warning",
    serviceNames: serviceName ? [serviceName] : [],
    groupBy: null,
    signalType: "error_rate",
    comparator: "gt",
    threshold: "5",
    windowMinutes: "5",
    minimumSampleCount: "50",
    consecutiveBreachesRequired: "2",
    consecutiveHealthyRequired: "2",
    renotifyIntervalMinutes: "30",
    metricName: "",
    metricType: "gauge",
    metricAggregation: "avg",
    apdexThresholdMs: "500",
    queryDataSource: "traces",
    queryAggregation: "count",
    queryWhereClause: "",
    destinationIds: [],
  }
}

export function ruleToFormState(rule: AlertRuleDocument): RuleFormState {
  return {
    name: rule.name,
    enabled: rule.enabled,
    severity: rule.severity,
    serviceNames: rule.serviceNames?.length > 0 ? [...rule.serviceNames] : (rule.serviceName ? [rule.serviceName] : []),
    groupBy: rule.groupBy ?? null,
    signalType: rule.signalType,
    comparator: rule.comparator,
    threshold: String(rule.threshold),
    windowMinutes: String(rule.windowMinutes),
    minimumSampleCount: String(rule.minimumSampleCount),
    consecutiveBreachesRequired: String(rule.consecutiveBreachesRequired),
    consecutiveHealthyRequired: String(rule.consecutiveHealthyRequired),
    renotifyIntervalMinutes: String(rule.renotifyIntervalMinutes),
    metricName: rule.metricName ?? "",
    metricType: rule.metricType ?? "gauge",
    metricAggregation: rule.metricAggregation ?? "avg",
    apdexThresholdMs: rule.apdexThresholdMs == null ? "500" : String(rule.apdexThresholdMs),
    queryDataSource: rule.queryDataSource ?? "traces",
    queryAggregation: rule.queryAggregation ?? "count",
    queryWhereClause: rule.queryWhereClause ?? "",
    destinationIds: [...rule.destinationIds],
  }
}

export function buildRuleRequest(form: RuleFormState): AlertRuleUpsertRequest {
  const signalType = form.signalType
  return new AlertRuleUpsertRequest({
    name: form.name.trim(),
    enabled: form.enabled,
    severity: form.severity,
    serviceNames: form.serviceNames.filter((s) => s.trim().length > 0),
    serviceName: form.serviceNames.length === 1 ? form.serviceNames[0] : null,
    groupBy: form.groupBy,
    signalType,
    comparator: form.comparator,
    threshold: Number(form.threshold),
    windowMinutes: parsePositiveNumber(form.windowMinutes, 5),
    minimumSampleCount: parseNonNegativeNumber(form.minimumSampleCount, 0),
    consecutiveBreachesRequired: parsePositiveNumber(form.consecutiveBreachesRequired, 2),
    consecutiveHealthyRequired: parsePositiveNumber(form.consecutiveHealthyRequired, 2),
    renotifyIntervalMinutes: parsePositiveNumber(form.renotifyIntervalMinutes, 30),
    metricName: signalType === "metric"
      ? (form.metricName.trim() || null)
      : signalType === "query" && form.queryDataSource === "metrics"
        ? (form.metricName.trim() || null)
        : null,
    metricType: signalType === "metric"
      ? form.metricType
      : signalType === "query" && form.queryDataSource === "metrics"
        ? form.metricType
        : null,
    metricAggregation: signalType === "metric" ? form.metricAggregation : null,
    apdexThresholdMs: signalType === "apdex" ? parsePositiveNumber(form.apdexThresholdMs, 500) : null,
    queryDataSource: signalType === "query" ? form.queryDataSource : null,
    queryAggregation: signalType === "query" ? (form.queryAggregation as AlertQueryAggregation) : null,
    queryWhereClause: signalType === "query" ? (form.queryWhereClause.trim() || null) : null,
    destinationIds: [...form.destinationIds],
  })
}

export function buildRuleTestRequest(form: RuleFormState, sendNotification: boolean): AlertRuleTestRequestType {
  return new AlertRuleTestRequest({
    rule: buildRuleRequest(form),
    sendNotification,
  })
}

export function isRulePreviewReady(form: RuleFormState): boolean {
  if (form.name.trim().length === 0) return false
  if (!Number.isFinite(Number(form.threshold))) return false
  if (form.signalType === "query" && form.queryDataSource === "metrics") {
    return form.metricName.trim().length > 0
  }
  return true
}

/** Map signal type to the query engine source and metric fields */
export function signalToQueryParams(form: RuleFormState): {
  source: "traces" | "logs" | "metrics"
  metric: string
  filters: Record<string, unknown>
} | null {
  const baseFilters = form.serviceNames.length === 1
    ? { serviceName: form.serviceNames[0] }
    : {}

  switch (form.signalType) {
    case "error_rate":
      return { source: "traces", metric: "error_rate", filters: { ...baseFilters, rootSpansOnly: true } }
    case "p95_latency":
      return { source: "traces", metric: "p95_duration", filters: { ...baseFilters, rootSpansOnly: true } }
    case "p99_latency":
      return { source: "traces", metric: "p99_duration", filters: { ...baseFilters, rootSpansOnly: true } }
    case "throughput":
      return { source: "traces", metric: "count", filters: { ...baseFilters, rootSpansOnly: true } }
    case "apdex":
      return {
        source: "traces",
        metric: "apdex",
        filters: { ...baseFilters, rootSpansOnly: true },
      }
    case "metric": {
      if (!form.metricName.trim() || !form.metricType) return null
      return {
        source: "metrics",
        metric: form.metricAggregation,
        filters: {
          metricName: form.metricName.trim(),
          metricType: form.metricType,
          ...baseFilters,
        },
      }
    }
    case "query": {
      const filterSet = buildAlertQueryFilterSet({
        queryDataSource: form.queryDataSource,
        serviceName: form.serviceNames.length === 1 ? form.serviceNames[0]! : null,
        metricName: form.metricName.trim() || null,
        metricType: form.metricType,
        queryWhereClause: form.queryWhereClause,
      })

      if (filterSet == null) return null

      const ds = filterSet.source
      return {
        source: ds,
        metric: ds === "logs" ? "count" : form.queryAggregation,
        filters: filterSet.filters ?? {},
      }
    }
  }
}

/** Flatten timeseries points into chart-ready rows, scoped to selected services. */
export function flattenAlertChartData(
  points: { bucket: string; series: Record<string, number> }[],
  serviceNames: readonly string[],
): Record<string, unknown>[] {
  return points.map((point) => {
    const base: Record<string, unknown> = { bucket: point.bucket }
    if (serviceNames.length > 1) {
      for (const svc of serviceNames) {
        if (svc in point.series) base[svc] = point.series[svc]
      }
    } else if (serviceNames.length === 1) {
      base[serviceNames[0]!] = point.series[serviceNames[0]!] ?? 0
    } else {
      Object.assign(base, point.series)
    }
    return base
  })
}

/* -------------------------------------------------------------------------- */
/*  Destination Form Helpers                                                  */
/* -------------------------------------------------------------------------- */

export type DestinationFormState = {
  type: AlertDestinationType
  name: string
  enabled: boolean
  channelLabel: string
  webhookUrl: string
  integrationKey: string
  url: string
  signingSecret: string
}

export function defaultDestinationForm(type: AlertDestinationType = "slack"): DestinationFormState {
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

export function destinationToFormState(destination: AlertDestinationDocument): DestinationFormState {
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

export function buildDestinationCreatePayload(form: DestinationFormState): AlertDestinationCreateRequest {
  switch (form.type) {
    case "slack":
      return { type: "slack", name: form.name.trim(), enabled: form.enabled, webhookUrl: form.webhookUrl.trim(), channelLabel: form.channelLabel.trim() || undefined }
    case "pagerduty":
      return { type: "pagerduty", name: form.name.trim(), enabled: form.enabled, integrationKey: form.integrationKey.trim() }
    case "webhook":
      return { type: "webhook", name: form.name.trim(), enabled: form.enabled, url: form.url.trim(), signingSecret: form.signingSecret.trim() || undefined }
  }
}

export function buildDestinationUpdatePayload(form: DestinationFormState): AlertDestinationUpdateRequest {
  switch (form.type) {
    case "slack":
      return { type: "slack", name: form.name.trim() || undefined, enabled: form.enabled, channelLabel: form.channelLabel.trim() || undefined, webhookUrl: form.webhookUrl.trim() || undefined }
    case "pagerduty":
      return { type: "pagerduty", name: form.name.trim() || undefined, enabled: form.enabled, integrationKey: form.integrationKey.trim() || undefined }
    case "webhook":
      return { type: "webhook", name: form.name.trim() || undefined, enabled: form.enabled, url: form.url.trim() || undefined, signingSecret: form.signingSecret.trim() || undefined }
  }
}

/* -------------------------------------------------------------------------- */
/*  Rule Toggle Helper                                                        */
/* -------------------------------------------------------------------------- */

export function buildRuleToggleRequest(rule: AlertRuleDocument): AlertRuleUpsertRequest {
  return new AlertRuleUpsertRequest({
    ...rule,
    enabled: !rule.enabled,
    serviceName: rule.serviceName ?? null,
    serviceNames: rule.serviceNames?.length > 0 ? [...rule.serviceNames] : undefined,
    metricName: rule.metricName ?? null,
    metricType: rule.metricType ?? null,
    metricAggregation: rule.metricAggregation ?? null,
    apdexThresholdMs: rule.apdexThresholdMs ?? null,
    destinationIds: [...rule.destinationIds],
  })
}

/* -------------------------------------------------------------------------- */
/*  Incident Stats                                                            */
/* -------------------------------------------------------------------------- */

export function computeIncidentStats(incidents: AlertIncidentDocument[]) {
  const totalTriggered = incidents.length
  const resolvedIncidents = incidents.filter((i) => i.resolvedAt && i.firstTriggeredAt)
  const avgResolutionMs = resolvedIncidents.length > 0
    ? resolvedIncidents.reduce((sum, i) => {
        const start = new Date(i.firstTriggeredAt).getTime()
        const end = new Date(i.resolvedAt!).getTime()
        return sum + (end - start)
      }, 0) / resolvedIncidents.length
    : 0

  const avgResolution = avgResolutionMs > 0
    ? avgResolutionMs < 60_000 ? `${Math.round(avgResolutionMs / 1000)}s`
      : avgResolutionMs < 3_600_000 ? `${(avgResolutionMs / 60_000).toFixed(1)}m`
      : `${(avgResolutionMs / 3_600_000).toFixed(1)}h`
    : "—"

  const serviceCounts: Record<string, number> = {}
  for (const i of incidents) {
    const svc = i.serviceName ?? "unknown"
    serviceCounts[svc] = (serviceCounts[svc] ?? 0) + 1
  }
  const topContributors = Object.entries(serviceCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)

  return { totalTriggered, avgResolution, topContributors }
}

/* -------------------------------------------------------------------------- */
/*  Shared Formatters                                                         */
/* -------------------------------------------------------------------------- */

export function formatAlertDateTime(value: string | null): string {
  if (!value) return "Never"
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function formatAlertDateTimeFull(value: string | null): string {
  if (!value) return "—"
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

export function formatAlertDuration(startStr: string | null, endStr: string | null): string {
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
