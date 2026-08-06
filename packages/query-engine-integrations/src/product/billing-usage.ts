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
//     `session_replays` (many rows per session — see the query). Kept as a
//     separate query rather than a UNION branch: the two tables disagree on
//     column types (byte sums are UInt64, the session count is UInt64 but the
//     bucket column comes from DateTime64) and unifying them has bitten us with
//     502s before.
//
// Day buckets are UTC, matching how the warehouse stores every timestamp. Byte
// sums are UInt64 and arrive as JSON strings on BYO-ClickHouse, so both row
// schemas are built from `CHNumber`.
// ---------------------------------------------------------------------------

import { Schema } from "effect"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { from, param, type CompiledQueryRowSchema } from "@maple-dev/clickhouse-builder"
import { ServiceUsage, SessionReplays } from "@maple/query-engine/ch/tables"
import { CHNumber } from "@maple/query-engine/ch/schema"
import { hourFloor } from "@maple/query-engine/ch/query-helpers"

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
 * on `StartTime` prunes partitions. A session is counted on the day it started,
 * matching how the ingest gateway meters it to Autumn.
 *
 * The count is `uniq(SessionId)` rather than `count()` for the same reason the
 * session facets use it (`session-replays.ts`): the SDK posts one metadata row
 * at session start, one per 60s heartbeat, and one at unload, and this is a
 * ReplacingMergeTree read without `FINAL` — so `count()` returns however many of
 * those rows a background merge has not collapsed yet. That made a 10-minute
 * session render as ~12 on the spend chart, and made the number move between
 * refreshes.
 *
 * Not yet `countIf(BillableStart = 1)`, which is what would reproduce the
 * invoice exactly. The billed unit is a visit — one visitor per 30-minute
 * window, spanning tabs and subdomains — so this series reads *higher* than the
 * bill by however many extra tabs and subdomains a visitor used. The reason to
 * wait: `BillableStart` defaults to 0, and rows posted by SDK bundles that
 * predate the field are billed by the gateway's legacy `Version = 1` fallback
 * while reading as 0 here. Switching now would under-report for every customer
 * on a pinned older SDK, which is a worse lie than over-reporting. Switch once
 * the field is broadly deployed; the mixed window is not distinguishable in the
 * warehouse, because the surviving row after a merge is the last one posted and
 * legacy sessions never stamped the flag on it.
 */
export function dailySessionCountQuery() {
	return from(SessionReplays)
		.select(($) => ({
			day: CH.toStartOfInterval($.StartTime, DAY_SECONDS),
			sessions: CH.uniq($.SessionId),
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
