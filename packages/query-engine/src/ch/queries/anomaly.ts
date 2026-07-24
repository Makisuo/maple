// ---------------------------------------------------------------------------
// Anomaly detector queries
//
// The built-in anomaly detector computes seasonal-naive baselines per series
// in TypeScript from hourly-MV rows. Every query here reads pre-aggregated
// tables only (traces_aggregates_hourly, logs_aggregates_hourly,
// error_events_by_time) and returns at most a few thousand rows per org —
// never a raw traces/logs scan.
//
// The "matched hours" trick: filtering `toHour(Hour) IN (h-1, h, h+1)` over a
// trailing 7-day window returns both the in-progress hour (the current
// observation) and ≤21 sealed same-hour-of-day samples (the baseline) in ONE
// query; the caller splits rows on `hour === currentHourStart`.
// ---------------------------------------------------------------------------

import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param } from "@maple-dev/clickhouse-builder"
import { from, fromQuery } from "@maple-dev/clickhouse-builder"
import { ErrorEventsByTime, LogsAggregatesHourly, TracesAggregatesHourly } from "../tables"

/** Hour-of-day values matching the current hour ±1, wrapping at midnight. */
export function matchedHoursOfDay(currentHourOfDay: number): readonly number[] {
	return [(currentHourOfDay + 23) % 24, currentHourOfDay, (currentHourOfDay + 1) % 24]
}

// ---------------------------------------------------------------------------
// Golden signals — per (service, env, hour) from traces_aggregates_hourly
// ---------------------------------------------------------------------------

export interface AnomalyTraceSignalsOpts {
	/** Hour-of-day values (0–23) to include; see `matchedHoursOfDay`. */
	hoursOfDay: readonly number[]
}

export interface AnomalyTraceSignalsOutput {
	readonly serviceName: string
	readonly deploymentEnv: string
	readonly hour: string
	readonly requestCount: number
	readonly errorCount: number
	readonly p95Ms: number
}

export function anomalyTraceSignalsQuery(opts: AnomalyTraceSignalsOpts) {
	return from(TracesAggregatesHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			deploymentEnv: $.DeploymentEnv,
			hour: $.Hour,
			requestCount: CH.rawExpr<number>("sum(WeightedCount)"),
			errorCount: CH.rawExpr<number>("sum(WeightedErrorCount)"),
			// Sample-weighted t-digest merge — the same expression
			// tracesTimeseriesQuery uses; never average p95s across hours.
			p95Ms: CH.rawExpr<number>(
				"arrayElement(quantilesTDigestWeightedMerge(0.95)(DurationQuantiles), 1) / 1000000",
			),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.IsEntryPoint.eq(1),
			$.Hour.gte(param.dateTime("startTime")),
			$.Hour.lte(param.dateTime("endTime")),
			CH.toHour($.Hour).in_(...opts.hoursOfDay),
		])
		.groupBy("serviceName", "deploymentEnv", "hour")
		.limit(25000)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Log volume — per (service, env, hour) from logs_aggregates_hourly
// ---------------------------------------------------------------------------

const ERROR_SEVERITIES = ["error", "fatal", "critical"] as const
const WARN_SEVERITIES = ["warn", "warning"] as const

export interface AnomalyLogVolumeOutput {
	readonly serviceName: string
	readonly deploymentEnv: string
	readonly hour: string
	readonly errorLogCount: number
	readonly warnLogCount: number
}

export function anomalyLogVolumeQuery(opts: AnomalyTraceSignalsOpts) {
	return from(LogsAggregatesHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			deploymentEnv: $.DeploymentEnv,
			hour: $.Hour,
			errorLogCount: CH.sumIf($.Count, CH.lower_($.SeverityText).in_(...ERROR_SEVERITIES)),
			warnLogCount: CH.sumIf($.Count, CH.lower_($.SeverityText).in_(...WARN_SEVERITIES)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(param.dateTime("startTime")),
			$.Hour.lte(param.dateTime("endTime")),
			CH.toHour($.Hour).in_(...opts.hoursOfDay),
		])
		.groupBy("serviceName", "deploymentEnv", "hour")
		.limit(25000)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Error fingerprint spikes — current 30-min window per (fingerprint, env)
// ---------------------------------------------------------------------------

export interface AnomalyErrorSpikeCurrentOutput {
	readonly fingerprintHash: string
	readonly serviceName: string
	readonly errorLabel: string
	readonly deploymentEnv: string
	readonly count: number
}

export function anomalyErrorSpikeCurrentQuery(opts: { limit?: number }) {
	// Timestamp-leading sort key on error_events_by_time prunes the scan to the
	// 30-minute window (same routing rationale as errorIssuesQuery).
	return from(ErrorEventsByTime)
		.select(($) => ({
			fingerprintHash: CH.toString_($.FingerprintHash),
			serviceName: CH.any_($.ServiceName),
			errorLabel: CH.any_($.ErrorLabel),
			deploymentEnv: $.DeploymentEnv,
			count: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
		])
		.groupBy("fingerprintHash", "deploymentEnv")
		.orderBy(["count", "desc"])
		.limit(opts.limit ?? 500)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Error fingerprint spike baseline — 7d hourly stats per (fingerprint, env).
// Runs ~once per org per hour; the caller caches the blob in KV.
// ---------------------------------------------------------------------------

export interface AnomalyErrorSpikeBaselineOutput {
	readonly fingerprintHash: string
	readonly deploymentEnv: string
	readonly totalCount: number
	readonly medianNonzeroHourly: number
	readonly maxHourly: number
}

export function anomalyErrorSpikeBaselineQuery(opts: { limit?: number }) {
	const hourly = from(ErrorEventsByTime)
		.select(($) => ({
			fingerprintHash: CH.toString_($.FingerprintHash),
			deploymentEnv: $.DeploymentEnv,
			h: CH.toStartOfHour($.Timestamp),
			hourCount: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lt(param.dateTime("endTime")),
		])
		.groupBy("fingerprintHash", "deploymentEnv", "h")

	return fromQuery(hourly, "hourly")
		.select(($) => ({
			fingerprintHash: $.fingerprintHash,
			deploymentEnv: $.deploymentEnv,
			totalCount: CH.sum($.hourCount),
			medianNonzeroHourly: CH.quantile(0.5)($.hourCount),
			maxHourly: CH.max_($.hourCount),
		}))
		.groupBy("fingerprintHash", "deploymentEnv")
		.orderBy(["totalCount", "desc"])
		.limit(opts.limit ?? 5000)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Incident timeseries — continuous window for ONE detector series, backing the
// observed-vs-baseline chart on the anomaly detail page. Unlike the detector
// queries above there is no matched-hours filter: the chart wants every bucket
// in the window for a single (service, env) or (fingerprint, env) series.
// ---------------------------------------------------------------------------

export interface AnomalyTraceSignalTimeseriesOutput {
	readonly hour: string
	readonly requestCount: number
	readonly errorCount: number
	readonly p95Ms: number
}

/** Hourly golden-signal buckets for one (service, env) — covers error_rate, latency_p95, throughput. */
export function anomalyTraceSignalTimeseriesQuery() {
	return from(TracesAggregatesHourly)
		.select(($) => ({
			hour: $.Hour,
			requestCount: CH.rawExpr<number>("sum(WeightedCount)"),
			errorCount: CH.rawExpr<number>("sum(WeightedErrorCount)"),
			p95Ms: CH.rawExpr<number>(
				"arrayElement(quantilesTDigestWeightedMerge(0.95)(DurationQuantiles), 1) / 1000000",
			),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			// Must match the detector's series definition (entry-point spans only).
			$.IsEntryPoint.eq(1),
			$.ServiceName.eq(param.string("serviceName")),
			$.DeploymentEnv.eq(param.string("deploymentEnv")),
			$.Hour.gte(param.dateTime("startTime")),
			$.Hour.lte(param.dateTime("endTime")),
		])
		.groupBy("hour")
		.orderBy(["hour", "asc"])
		.limit(200)
		.format("JSON")
}

export interface AnomalyLogVolumeTimeseriesOutput {
	readonly hour: string
	readonly errorLogCount: number
}

/** Hourly error-log volume for one (service, env). */
export function anomalyLogVolumeTimeseriesQuery() {
	return from(LogsAggregatesHourly)
		.select(($) => ({
			hour: $.Hour,
			errorLogCount: CH.sumIf($.Count, CH.lower_($.SeverityText).in_(...ERROR_SEVERITIES)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(param.string("serviceName")),
			$.DeploymentEnv.eq(param.string("deploymentEnv")),
			$.Hour.gte(param.dateTime("startTime")),
			$.Hour.lte(param.dateTime("endTime")),
		])
		.groupBy("hour")
		.orderBy(["hour", "asc"])
		.limit(200)
		.format("JSON")
}

export interface AnomalyErrorSpikeTimeseriesOutput {
	readonly bucket: string
	readonly count: number
}

/**
 * Fixed-width occurrence buckets for one (fingerprint, env). The anomaly API
 * requests five-minute buckets, then derives the detector's rolling 30-minute
 * window in TypeScript so the chart and five-minute detector tick agree.
 */
export function anomalyErrorSpikeTimeseriesQuery() {
	return (
		from(ErrorEventsByTime)
			.select(($) => ({
				bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
				count: CH.count(),
			}))
			.where(($) => [
				$.OrgId.eq(param.string("orgId")),
				$.FingerprintHash.eq(CH.toUInt64(param.string("fingerprintHash"))),
				$.DeploymentEnv.eq(param.string("deploymentEnv")),
				$.Timestamp.gte(param.dateTime("startTime")),
				$.Timestamp.lte(param.dateTime("endTime")),
			])
			.groupBy("bucket")
			.orderBy(["bucket", "asc"])
			// Seven days at five-minute grain is 2,016 buckets.
			.limit(2500)
			.format("JSON")
	)
}

/**
 * Occurrence buckets for ALL error events on one (service, env) — the chart
 * series for a consolidated spike incident, where several fingerprints share
 * the incident and a single-fingerprint series would under-represent it.
 * (The CH param builder has no array params, so this filters by service
 * rather than a fingerprint IN-list.)
 */
export function anomalyErrorSpikeServiceTimeseriesQuery() {
	return from(ErrorEventsByTime)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
			count: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(param.string("serviceName")),
			$.DeploymentEnv.eq(param.string("deploymentEnv")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
		])
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.limit(400)
		.format("JSON")
}
