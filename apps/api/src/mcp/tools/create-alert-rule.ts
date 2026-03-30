import {
  McpQueryError,
  optionalBooleanParam,
  optionalNumberParam,
  optionalStringParam,
  requiredStringParam,
  type McpToolRegistrar,
} from "./types"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveTenant } from "@/mcp/lib/query-tinybird"
import { AlertsService } from "@/services/AlertsService"
import { AlertRuleUpsertRequest } from "@maple/domain/http"

const decodeAlertRuleRequest = Schema.decodeUnknownSync(AlertRuleUpsertRequest)

const splitCsv = (value: string): string[] =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

interface AlertTemplate {
  signalType: string
  comparator: string
  defaultThreshold: number
  defaults: Record<string, unknown>
}

const ALERT_TEMPLATES: Record<string, AlertTemplate> = {
  high_error_rate: {
    signalType: "error_rate",
    comparator: "gt",
    defaultThreshold: 5,
    defaults: {},
  },
  slow_p95: {
    signalType: "p95_latency",
    comparator: "gt",
    defaultThreshold: 1000,
    defaults: {},
  },
  slow_p99: {
    signalType: "p99_latency",
    comparator: "gt",
    defaultThreshold: 2000,
    defaults: {},
  },
  low_apdex: {
    signalType: "apdex",
    comparator: "lt",
    defaultThreshold: 0.8,
    defaults: { apdexThresholdMs: 500 },
  },
  throughput_drop: {
    signalType: "throughput",
    comparator: "lt",
    defaultThreshold: 100,
    defaults: {},
  },
}

// ---------------------------------------------------------------------------
// Build request from raw params (custom mode)
// ---------------------------------------------------------------------------

interface CreateAlertRuleParams {
  name: string
  severity?: string
  signal_type?: string
  comparator?: string
  threshold?: number
  window_minutes?: number
  destination_ids: string
  template?: string
  service_name?: string
  enabled?: boolean
  group_by?: string
  minimum_sample_count?: number
  consecutive_breaches?: number
  consecutive_healthy?: number
  renotify_interval_minutes?: number
  metric_name?: string
  metric_type?: string
  metric_aggregation?: string
  apdex_threshold_ms?: number
  query_data_source?: string
  query_aggregation?: string
  query_where_clause?: string
}

function buildAlertRuleRequest(
  params: CreateAlertRuleParams,
): { request: Record<string, unknown> } | { error: string } {
  const destinationIds = splitCsv(params.destination_ids)

  // Resolve template or use raw params
  let signalType = params.signal_type
  let comparator = params.comparator
  let threshold = params.threshold
  let windowMinutes = params.window_minutes ?? 5
  let templateDefaults: Record<string, unknown> = {}

  if (params.template && params.template !== "custom") {
    const tmpl = ALERT_TEMPLATES[params.template]
    if (!tmpl) {
      return {
        error: `Unknown template "${params.template}". Available: ${Object.keys(ALERT_TEMPLATES).join(", ")}, custom`,
      }
    }
    signalType = tmpl.signalType
    comparator = tmpl.comparator
    threshold = params.threshold ?? tmpl.defaultThreshold
    templateDefaults = tmpl.defaults
  }

  if (!signalType) return { error: "signal_type is required (or use a template)" }
  if (!comparator) return { error: "comparator is required (or use a template)" }
  if (threshold === undefined) return { error: "threshold is required (or use a template)" }

  if (signalType === "metric") {
    if (!params.metric_name || !params.metric_type || !params.metric_aggregation) {
      return {
        error:
          "signal_type=metric requires metric_name, metric_type, and metric_aggregation",
      }
    }
  }

  if (signalType === "apdex") {
    if (!params.apdex_threshold_ms && !templateDefaults.apdexThresholdMs) {
      return { error: "signal_type=apdex requires apdex_threshold_ms" }
    }
  }

  if (signalType === "query") {
    if (!params.query_data_source || !params.query_aggregation) {
      return {
        error:
          "signal_type=query requires query_data_source and query_aggregation",
      }
    }
  }

  const request: Record<string, unknown> = {
    name: params.name,
    severity: params.severity ?? "warning",
    signalType,
    comparator,
    threshold,
    windowMinutes,
    destinationIds,
    ...templateDefaults,
  }

  if (params.enabled !== undefined) request.enabled = params.enabled
  if (params.service_name) request.serviceName = params.service_name
  if (params.group_by) request.groupBy = params.group_by
  if (params.minimum_sample_count !== undefined)
    request.minimumSampleCount = params.minimum_sample_count
  if (params.consecutive_breaches !== undefined)
    request.consecutiveBreachesRequired = params.consecutive_breaches
  if (params.consecutive_healthy !== undefined)
    request.consecutiveHealthyRequired = params.consecutive_healthy
  if (params.renotify_interval_minutes !== undefined)
    request.renotifyIntervalMinutes = params.renotify_interval_minutes

  // Metric-specific fields
  if (params.metric_name) request.metricName = params.metric_name
  if (params.metric_type) request.metricType = params.metric_type
  if (params.metric_aggregation) request.metricAggregation = params.metric_aggregation

  // Apdex-specific fields
  if (params.apdex_threshold_ms !== undefined)
    request.apdexThresholdMs = params.apdex_threshold_ms

  // Query-specific fields
  if (params.query_data_source) request.queryDataSource = params.query_data_source
  if (params.query_aggregation) request.queryAggregation = params.query_aggregation
  if (params.query_where_clause) request.queryWhereClause = params.query_where_clause

  return { request }
}

const comparatorLabel: Record<string, string> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
}

export function registerCreateAlertRuleTool(server: McpToolRegistrar) {
  server.tool(
    "create_alert_rule",
    "Create an alert rule. Use a template for common cases (high_error_rate, slow_p95, slow_p99, low_apdex, throughput_drop) or template='custom' for full control. " +
      "Templates auto-fill signal_type, comparator, and a sensible default threshold. " +
      "Use list_alert_rules to find destination_ids.",
    Schema.Struct({
      name: requiredStringParam("Rule name"),
      destination_ids: requiredStringParam(
        "Comma-separated destination IDs to notify (use list_alert_rules to find IDs)",
      ),
      template: optionalStringParam(
        "Template: high_error_rate, slow_p95, slow_p99, low_apdex, throughput_drop, or custom (default: custom)",
      ),
      severity: optionalStringParam("Alert severity: warning or critical (default: warning)"),
      threshold: optionalNumberParam(
        "Threshold value (overrides template default). E.g. 5 for 5% error rate, 1000 for 1s latency",
      ),
      window_minutes: optionalNumberParam("Evaluation window in minutes (default: 5)"),
      service_name: optionalStringParam("Scope the alert to a specific service"),
      enabled: optionalBooleanParam("Whether the rule is enabled (default: true)"),
      // Custom-mode params (used when template is 'custom' or omitted)
      signal_type: optionalStringParam(
        "Signal type (for custom): error_rate, p95_latency, p99_latency, apdex, throughput, metric, query",
      ),
      comparator: optionalStringParam(
        "Comparison operator (for custom): gt (>), gte (>=), lt (<), lte (<=)",
      ),
      group_by: optionalStringParam("Group by dimension: service"),
      minimum_sample_count: optionalNumberParam(
        "Minimum sample count before evaluating (default: 0)",
      ),
      consecutive_breaches: optionalNumberParam(
        "Consecutive breaches before alerting (default: 1)",
      ),
      consecutive_healthy: optionalNumberParam(
        "Consecutive healthy evaluations before resolving (default: 1)",
      ),
      renotify_interval_minutes: optionalNumberParam(
        "Re-notification interval in minutes (default: 60)",
      ),
      metric_name: optionalStringParam(
        "Metric name (required when signal_type=metric)",
      ),
      metric_type: optionalStringParam(
        "Metric type: sum, gauge, histogram, exponential_histogram (required when signal_type=metric)",
      ),
      metric_aggregation: optionalStringParam(
        "Metric aggregation: avg, min, max, sum, count (required when signal_type=metric)",
      ),
      apdex_threshold_ms: optionalNumberParam(
        "Apdex threshold in milliseconds (required when signal_type=apdex)",
      ),
      query_data_source: optionalStringParam(
        "Query data source: traces, logs, metrics (required when signal_type=query)",
      ),
      query_aggregation: optionalStringParam(
        "Query aggregation function (required when signal_type=query)",
      ),
      query_where_clause: optionalStringParam(
        "Query WHERE clause for filtering (optional, for signal_type=query)",
      ),
    }),
    (params) =>
      Effect.gen(function* () {
        const built = buildAlertRuleRequest(params)
        if ("error" in built) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: built.error }],
          }
        }

        let decoded: AlertRuleUpsertRequest
        try {
          decoded = decodeAlertRuleRequest(built.request)
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Invalid alert rule: ${String(error)}`,
              },
            ],
          }
        }

        const tenant = yield* resolveTenant
        const alerts = yield* AlertsService

        const rule = yield* alerts
          .createRule(tenant.orgId, tenant.userId, tenant.roles, decoded)
          .pipe(
            Effect.mapError((error) => {
              const details =
                "details" in error
                  ? `\n${(error.details as string[]).join("\n")}`
                  : ""
              return new McpQueryError({
                message: `${error._tag}: ${error.message}${details}`,
                pipe: "create_alert_rule",
              })
            }),
          )

        const lines: string[] = [
          `## Alert Rule Created`,
          `ID: ${rule.id}`,
          `Name: ${rule.name}`,
          `Severity: ${rule.severity}`,
          `Signal: ${rule.signalType}`,
          `Condition: ${comparatorLabel[rule.comparator] ?? rule.comparator} ${rule.threshold}`,
          `Window: ${rule.windowMinutes}m`,
          `Enabled: ${rule.enabled ? "Yes" : "No"}`,
          `Destinations: ${rule.destinationIds.length}`,
        ]

        if (rule.serviceName) {
          lines.splice(3, 0, `Service: ${rule.serviceName}`)
        }

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "create_alert_rule",
            data: {
              rule: {
                id: rule.id,
                name: rule.name,
                enabled: rule.enabled,
                severity: rule.severity,
                serviceName: rule.serviceName,
                signalType: rule.signalType,
                comparator: rule.comparator,
                threshold: rule.threshold,
                windowMinutes: rule.windowMinutes,
                destinationIds: [...rule.destinationIds],
                createdAt: rule.createdAt,
                updatedAt: rule.updatedAt,
              },
            },
          }),
        }
      }),
  )
}
