import { Metric } from "effect"

// --- Counters ---

export const rulesEvaluatedTotal = Metric.counter("alerting.rules_evaluated_total", {
  description: "Total number of alert rules evaluated",
  incremental: true,
})

export const rulesBreachedTotal = Metric.counter("alerting.rules_breached_total", {
  description: "Total number of alert rule evaluations that resulted in breach",
  incremental: true,
})

export const rulesHealthyTotal = Metric.counter("alerting.rules_healthy_total", {
  description: "Total number of alert rule evaluations that were healthy",
  incremental: true,
})

export const rulesSkippedTotal = Metric.counter("alerting.rules_skipped_total", {
  description: "Total number of alert rule evaluations that were skipped",
  incremental: true,
})

export const evaluationFailuresTotal = Metric.counter("alerting.evaluation_failures_total", {
  description: "Total number of rule evaluation failures (errors)",
  incremental: true,
})

export const incidentsOpenedTotal = Metric.counter("alerting.incidents_opened_total", {
  description: "Total number of incidents opened",
  incremental: true,
})

export const incidentsResolvedTotal = Metric.counter("alerting.incidents_resolved_total", {
  description: "Total number of incidents resolved",
  incremental: true,
})

export const staleIncidentsResolvedTotal = Metric.counter("alerting.stale_incidents_resolved_total", {
  description: "Incidents auto-resolved due to rule config changes or disappeared services",
  incremental: true,
})

export const deliveriesAttemptedTotal = Metric.counter("alerting.deliveries_attempted_total", {
  description: "Total number of delivery attempts",
  incremental: true,
})

export const deliveriesSucceededTotal = Metric.counter("alerting.deliveries_succeeded_total", {
  description: "Total number of successful deliveries",
  incremental: true,
})

export const deliveriesFailedTotal = Metric.counter("alerting.deliveries_failed_total", {
  description: "Total number of failed deliveries",
  incremental: true,
})

// --- Histograms ---

export const tickDurationMs = Metric.histogram("alerting.tick_duration_ms", {
  description: "Duration of a full scheduler tick in milliseconds",
  boundaries: [100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
})

export const ruleEvaluationDurationMs = Metric.histogram("alerting.rule_evaluation_duration_ms", {
  description: "Duration of a single rule evaluation in milliseconds",
  boundaries: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
})

export const deliveryAttemptDurationMs = Metric.histogram("alerting.delivery_attempt_duration_ms", {
  description: "Duration of a single delivery attempt in milliseconds",
  boundaries: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
})

// --- Gauges ---

export const activeRulesGauge = Metric.gauge("alerting.active_rules", {
  description: "Number of enabled alert rules found in the current tick",
})
