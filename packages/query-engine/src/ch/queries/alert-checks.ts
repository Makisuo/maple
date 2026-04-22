// ---------------------------------------------------------------------------
// Typed Alert Check Queries
//
// DSL-based query definitions for listing historical alert rule check rows
// from the `alert_checks` datasource.
// ---------------------------------------------------------------------------

import * as CH from "../expr"
import { param } from "../param"
import { from } from "../query"
import { AlertChecks } from "../tables"

const ISO_Z_FORMAT = "%Y-%m-%dT%H:%i:%S.%fZ"

export interface ListRuleChecksOpts {
  readonly groupKey?: string
  readonly since?: string
  readonly until?: string
  readonly limit: number
}

export interface ListRuleChecksOutput {
  readonly timestamp: string
  readonly groupKey: string
  readonly status: string
  readonly signalType: string
  readonly comparator: string
  readonly threshold: number
  readonly observedValue: number | null
  readonly sampleCount: number
  readonly windowMinutes: number
  readonly windowStart: string
  readonly windowEnd: string
  readonly consecutiveBreaches: number
  readonly consecutiveHealthy: number
  readonly incidentId: string | null
  readonly incidentTransition: string
  readonly evaluationDurationMs: number
}

export function listRuleChecksQuery(opts: ListRuleChecksOpts) {
  return from(AlertChecks)
    .select(($) => ({
      timestamp: CH.formatDateTime($.Timestamp, ISO_Z_FORMAT),
      groupKey: $.GroupKey,
      status: $.Status,
      signalType: $.SignalType,
      comparator: $.Comparator,
      threshold: $.Threshold,
      observedValue: $.ObservedValue,
      sampleCount: $.SampleCount,
      windowMinutes: $.WindowMinutes,
      windowStart: CH.formatDateTime($.WindowStart, ISO_Z_FORMAT),
      windowEnd: CH.formatDateTime($.WindowEnd, ISO_Z_FORMAT),
      consecutiveBreaches: $.ConsecutiveBreaches,
      consecutiveHealthy: $.ConsecutiveHealthy,
      incidentId: $.IncidentId,
      incidentTransition: $.IncidentTransition,
      evaluationDurationMs: $.EvaluationDurationMs,
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.RuleId.eq(param.string("ruleId")),
      opts.groupKey != null && opts.groupKey !== ""
        ? $.GroupKey.eq(param.string("groupKey"))
        : undefined,
      opts.since != null ? $.Timestamp.gte(param.dateTime("since")) : undefined,
      opts.until != null ? $.Timestamp.lte(param.dateTime("until")) : undefined,
    ])
    .orderBy(["timestamp", "desc"])
    .limit(opts.limit)
    .format("JSON")
}
