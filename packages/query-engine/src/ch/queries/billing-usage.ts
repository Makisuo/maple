// ---------------------------------------------------------------------------
// Billing — daily ingested volume
//
// The billing page's spend chart is cumulative dollars by feature, which needs
// per-day volume per billable signal. Autumn only reports cycle *totals*
// (`aggregateEvents`), so the daily shape comes from the warehouse:
//
//   `dailySignalVolumeQuery`  — logs/traces/metrics bytes per UTC day, from the
//     hourly `service_usage` MV. Same source the usage cards read, so the
//     chart's totals reconcile with them rather than telling a second story.
//
//   `dailySessionCountQuery`  — browser sessions per UTC day, from
//     `session_replays` (one row per session). Kept as a separate query rather
//     than a UNION branch: the two tables disagree on column types (byte sums
//     are UInt64, the session count is UInt64 but the bucket column comes from
//     DateTime64) and unifying them has bitten us with 502s before.
//
// Day buckets are UTC, matching how the warehouse stores every timestamp. Byte
// sums are UInt64 and arrive as JSON strings on BYO-ClickHouse, so both row
// schemas are built from `CHNumber`.
// ---------------------------------------------------------------------------

import { Schema } from "effect"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { from, param, type CompiledQueryRowSchema } from "@maple-dev/clickhouse-builder"
import { ServiceUsage, SessionReplays } from "../tables"
import { CHNumber } from "../schema"

const DAY_SECONDS = 86_400

export interface DailySignalVolumeOutput {
	/** ClickHouse datetime literal at the UTC day boundary, e.g. `2026-07-29 00:00:00`. */
	readonly day: string
	readonly logBytes: number
	readonly traceBytes: number
	readonly metricBytes: number
}

export const dailySignalVolumeRowSchema: CompiledQueryRowSchema<DailySignalVolumeOutput> = Schema.Struct({
	day: Schema.String,
	logBytes: CHNumber,
	traceBytes: CHNumber,
	metricBytes: CHNumber,
})

/**
 * Per-UTC-day log/trace/metric bytes for one org.
 *
 * `service_usage` is keyed on top-of-hour `Hour`, so both bounds snap to their
 * hour floor — the same correction `serviceUsageQuery` makes. A billing cycle
 * always starts and ends on a day boundary, so the snap is exact here.
 *
 * "Metrics" sums all four metric-type columns: the plan meters one `metrics`
 * feature, and splitting sum/gauge/histogram/exp-histogram would price bytes
 * the customer is never billed for separately.
 */
export function dailySignalVolumeQuery() {
	const hourFloor = (name: string) => CH.toStartOfHour(CH.toDateTime(param.dateTime(name)))

	return from(ServiceUsage)
		.select(($) => ({
			day: CH.toStartOfInterval($.Hour, DAY_SECONDS),
			logBytes: CH.sum($.LogSizeBytes),
			traceBytes: CH.sum($.TraceSizeBytes),
			metricBytes: CH.sum($.SumMetricSizeBytes)
				.add(CH.sum($.GaugeMetricSizeBytes))
				.add(CH.sum($.HistogramMetricSizeBytes))
				.add(CH.sum($.ExpHistogramMetricSizeBytes)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(hourFloor("startTime")),
			$.Hour.lte(hourFloor("endTime")),
		])
		.groupBy("day")
		.orderBy(["day", "asc"])
		.format("JSON")
}

export interface DailySessionCountOutput {
	readonly day: string
	readonly sessions: number
}

export const dailySessionCountRowSchema: CompiledQueryRowSchema<DailySessionCountOutput> = Schema.Struct({
	day: Schema.String,
	sessions: CHNumber,
})

/**
 * Per-UTC-day browser session count for one org.
 *
 * `session_replays` is PARTITION BY toDate(StartTime), so the window predicate
 * on `StartTime` prunes partitions. A session is counted on the day it started —
 * which is also how the ingest gateway meters it to Autumn, so the daily series
 * and the cycle total can't drift.
 */
export function dailySessionCountQuery() {
	return from(SessionReplays)
		.select(($) => ({
			day: CH.toStartOfInterval($.StartTime, DAY_SECONDS),
			sessions: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.StartTime.gte(CH.toDateTime(param.dateTime("startTime"))),
			$.StartTime.lte(CH.toDateTime(param.dateTime("endTime"))),
		])
		.groupBy("day")
		.orderBy(["day", "asc"])
		.format("JSON")
}
