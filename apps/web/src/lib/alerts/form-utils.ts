import {
  AlertRuleDocument,
  AlertRuleTestRequest,
  AlertRuleUpsertRequest,
  type AlertComparator,
  type AlertDestinationId,
  type AlertDestinationType,
  type AlertMetricAggregation,
  type AlertMetricType,
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
  serviceName: string
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
    serviceName: serviceName ?? "",
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
    destinationIds: [],
  }
}

export function ruleToFormState(rule: AlertRuleDocument): RuleFormState {
  return {
    name: rule.name,
    enabled: rule.enabled,
    severity: rule.severity,
    serviceName: rule.serviceName ?? "",
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
    destinationIds: [...rule.destinationIds],
  }
}

export function buildRuleRequest(form: RuleFormState): AlertRuleUpsertRequest {
  const signalType = form.signalType
  return new AlertRuleUpsertRequest({
    name: form.name.trim(),
    enabled: form.enabled,
    severity: form.severity,
    serviceName: form.serviceName.trim() ? form.serviceName.trim() : null,
    groupBy: form.groupBy,
    signalType,
    comparator: form.comparator,
    threshold: Number(form.threshold),
    windowMinutes: parsePositiveNumber(form.windowMinutes, 5),
    minimumSampleCount: parseNonNegativeNumber(form.minimumSampleCount, 0),
    consecutiveBreachesRequired: parsePositiveNumber(form.consecutiveBreachesRequired, 2),
    consecutiveHealthyRequired: parsePositiveNumber(form.consecutiveHealthyRequired, 2),
    renotifyIntervalMinutes: parsePositiveNumber(form.renotifyIntervalMinutes, 30),
    metricName: signalType === "metric" ? (form.metricName.trim() || null) : null,
    metricType: signalType === "metric" ? form.metricType : null,
    metricAggregation: signalType === "metric" ? form.metricAggregation : null,
    apdexThresholdMs: signalType === "apdex" ? parsePositiveNumber(form.apdexThresholdMs, 500) : null,
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
  return form.name.trim().length > 0 && Number.isFinite(Number(form.threshold))
}

/** Map signal type to the query engine source and metric fields */
export function signalToQueryParams(form: RuleFormState): {
  source: "traces" | "metrics"
  metric: string
  filters: Record<string, unknown>
} | null {
  const baseFilters = form.serviceName.trim()
    ? { serviceName: form.serviceName.trim() }
    : {}

  switch (form.signalType) {
    case "error_rate":
      return { source: "traces", metric: "error_rate", filters: baseFilters }
    case "p95_latency":
      return { source: "traces", metric: "p95_duration", filters: baseFilters }
    case "p99_latency":
      return { source: "traces", metric: "p99_duration", filters: baseFilters }
    case "throughput":
      return { source: "traces", metric: "count", filters: baseFilters }
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
  }
}
