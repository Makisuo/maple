// Typed Alert Check Queries
//
// DSL-based query definitions for listing historical alert rule check rows
// from the `alert_checks` datasource.

import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param } from "@maple-dev/clickhouse-builder"
import { from } from "@maple-dev/clickhouse-builder"
import { AlertChecks } from "../tables"
import { ISO_Z_FORMAT } from "./format"

export interface ListRuleChecksOpts {
	readonly groupKey?: string
	readonly status?: string
	readonly since?: string
	readonly until?: string
	readonly beforeTimestamp?: string
	readonly beforeGroupKey?: string
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
	readonly errorMessage: string | null
	readonly errorCategory: string
}

export function listRuleChecksQuery(opts: ListRuleChecksOpts) {
	return (
		from(AlertChecks)
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
				errorMessage: $.ErrorMessage,
				errorCategory: $.ErrorCategory,
			}))
			.where(($) => [
				$.OrgId.eq(param.string("orgId")),
				$.RuleId.eq(param.string("ruleId")),
				opts.groupKey != null && opts.groupKey !== ""
					? $.GroupKey.eq(param.string("groupKey"))
					: undefined,
				opts.status != null ? $.Status.eq(param.string("status")) : undefined,
				opts.since != null ? $.Timestamp.gte(param.dateTime("since")) : undefined,
				opts.until != null ? $.Timestamp.lte(param.dateTime("until")) : undefined,
				opts.beforeTimestamp != null
					? $.Timestamp.lt(param.dateTime("beforeTimestamp")).or(
							$.Timestamp.eq(param.dateTime("beforeTimestamp")).and(
								$.GroupKey.gt(param.string("beforeGroupKey")),
							),
						)
					: undefined,
			])
			.orderBy(["timestamp", "desc"], ["groupKey", "asc"])
			.limit(opts.limit)
			.format("JSON")
			// alert_checks is written via `ingest` (Tinybird-pinned) with no per-org
			// MV, so reads must hit the same managed pipeline — otherwise a
			// BYO-ClickHouse org reads an empty table from its own ClickHouse.
			.routing("ingest")
	)
}

export interface AlertCheckGroupTotalsOpts {
	readonly since: string
	readonly until: string
	readonly limit?: number
}

export interface AlertCheckGroupTotalsOutput {
	readonly groupKey: string
	readonly totalCount: number
}

export function alertCheckGroupTotalsQuery(opts: AlertCheckGroupTotalsOpts) {
	return from(AlertChecks)
		.select(($) => ({
			groupKey: $.GroupKey,
			totalCount: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.RuleId.eq(param.string("ruleId")),
			$.Timestamp.gte(param.dateTime("since")),
			$.Timestamp.lte(param.dateTime("until")),
		])
		.groupBy("groupKey")
		.orderBy(["totalCount", "desc"], ["groupKey", "asc"])
		.limit(opts.limit ?? 20)
		.format("JSON")
		.routing("ingest")
}

export interface AlertChecksSummaryOpts {
	readonly topGroupKeys: readonly string[]
}

export interface AlertChecksSummaryOutput {
	readonly bucket: string
	readonly groupKey: string
	readonly totalCount: number
	readonly breachedCount: number
	readonly healthyCount: number
	readonly skippedCount: number
	readonly errorCount: number
	readonly transitionCount: number
	readonly observedValue: number | null
	readonly threshold: number
}

export function alertChecksSummaryQuery(opts: AlertChecksSummaryOpts) {
	return from(AlertChecks)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
			groupKey:
				opts.topGroupKeys.length > 0
					? CH.if_(CH.inList($.GroupKey, opts.topGroupKeys), $.GroupKey, CH.lit("__other__"))
					: CH.lit("__other__"),
			totalCount: CH.count(),
			breachedCount: CH.countIf($.Status.eq("breached")),
			healthyCount: CH.countIf($.Status.eq("healthy")),
			skippedCount: CH.countIf($.Status.eq("skipped")),
			errorCount: CH.countIf($.Status.eq("error")),
			transitionCount: CH.countIf($.IncidentTransition.neq("none")),
			observedValue: CH.rawExpr<number | null>("avg(ObservedValue)"),
			threshold: CH.avg($.Threshold),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.RuleId.eq(param.string("ruleId")),
			$.Timestamp.gte(param.dateTime("since")),
			$.Timestamp.lte(param.dateTime("until")),
		])
		.groupBy("bucket", "groupKey")
		.orderBy(["bucket", "asc"], ["groupKey", "asc"])
		.limit(20_000)
		.format("JSON")
		.routing("ingest")
}
