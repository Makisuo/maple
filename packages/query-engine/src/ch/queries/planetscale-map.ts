// ---------------------------------------------------------------------------
// PlanetScale service-map stats
//
// Per-database (and per-branch) rollups over the metrics the scraper collects
// from PlanetScale's Prometheus endpoints, so the service map can overlay live
// database health onto trace-derived DB nodes and the detail panel can break a
// database down by branch. The scraper merges PlanetScale's http_sd discovery
// labels into every data point. Current payloads use the `_name` suffix; the
// legacy aliases are coalesced for already-ingested data.
//
// Metric names are PlanetScale's own (pass-through scrape); the registry below
// covers both products — Vitess/MySQL and Postgres — and was pinned from
// https://planetscale.com/docs/cli/metrics and
// https://planetscale.com/docs/postgres/monitoring/prometheus-metrics-postgres.
// If PlanetScale renames a metric, this registry is the only place to touch.
//
// Like the Cloudflare overlay, this data never creates map nodes of its own —
// the frontend matches rows to existing trace-derived DB nodes by database
// name and attaches the numbers.
// ---------------------------------------------------------------------------

import { Schema } from "effect"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { from, fromQuery, param, type CompiledQueryRowSchema } from "@maple-dev/clickhouse-builder"
import { CHNumber } from "../schema"
import { MetricsGauge } from "../tables"

/** Active connections (gauge) — one series per edge region/branch; summed per timestamp. */
export const CONNECTION_METRIC_NAMES = [
	"planetscale_edge_active_connections", // Vitess/MySQL
	"planetscale_edge_postgres_active_connections", // Postgres (includes PgBouncer)
] as const

/** Pod CPU utilization percentage (gauge, both products). */
export const CPU_METRIC_NAMES = ["planetscale_pods_cpu_util_percentages"] as const

/** Pod memory utilization percentage (gauge, both products). */
export const MEMORY_METRIC_NAMES = ["planetscale_pods_mem_util_percentages"] as const

/** Replication lag in seconds (gauge). */
export const REPLICA_LAG_METRIC_NAMES = [
	"planetscale_mysql_replica_lag_seconds", // Vitess/MySQL (fine-grained)
	"planetscale_vttablet_replication_lag", // Vitess/MySQL (vttablet-reported)
	"planetscale_postgres_replica_lag_seconds", // Postgres
] as const

/** Volume capacity in bytes (gauge) — the denominator for storage pressure. */
export const STORAGE_CAPACITY_METRIC_NAMES = ["planetscale_volume_capacity_bytes"] as const

/** Free volume space in bytes (gauge). PlanetScale reports free, not used. */
export const STORAGE_AVAILABLE_METRIC_NAMES = ["planetscale_volume_available_bytes"] as const

export const STORAGE_METRIC_NAMES = [
	...STORAGE_CAPACITY_METRIC_NAMES,
	...STORAGE_AVAILABLE_METRIC_NAMES,
] as const

export const GAUGE_METRIC_NAMES = [
	...CPU_METRIC_NAMES,
	...MEMORY_METRIC_NAMES,
	...REPLICA_LAG_METRIC_NAMES,
] as const

export interface PlanetScaleDatabaseStatsOutput {
	readonly database: string
	/** Max pod CPU utilization % across pods over the window. */
	readonly cpuMaxPercent: number
	/** Max pod memory utilization % across pods over the window. */
	readonly memMaxPercent: number
	/** Worst replica lag (seconds) over the window. */
	readonly replicaLagMaxSeconds: number
}

export interface PlanetScaleBranchStatsOutput extends PlanetScaleDatabaseStatsOutput {
	readonly branch: string
}

export interface PlanetScaleStorageOutput {
	readonly database: string
	/**
	 * Worst branch's used percentage (0–100) over the window. Computed per branch
	 * and then maxed — NOT from the database's max capacity over its min free
	 * space, which would pair two different branches' numbers and invent a
	 * percentage neither of them ever had.
	 */
	readonly storageUsedPercent: number
	/**
	 * Free-space samples behind the number. Capacity is scraped slightly more
	 * often than free space, so zero samples means "we never saw free space",
	 * not "the volume is full" — the caller must not render 100% off a missing
	 * series.
	 */
	readonly storageSamples: number
}

export interface PlanetScaleBranchStorageOutput {
	readonly database: string
	readonly branch: string
	readonly storageUsedPercent: number
	/** Volume size in bytes — the largest seen in the window (branches can resize). */
	readonly storageCapacityBytes: number
	/** Least free space seen in the window: the high-water mark of storage pressure. */
	readonly storageAvailableBytes: number
	readonly storageSamples: number
}

export interface PlanetScaleConnectionsOutput {
	readonly database: string
	/** Average of the per-timestamp total (summed across series) — “typical” concurrency. */
	readonly connectionsAvg: number
	/** Peak per-timestamp total over the window. */
	readonly connectionsMax: number
}

export interface PlanetScaleBranchConnectionsOutput extends PlanetScaleConnectionsOutput {
	readonly branch: string
}

export const planetscaleDatabaseStatsRowSchema: CompiledQueryRowSchema<PlanetScaleDatabaseStatsOutput> =
	Schema.Struct({
		database: Schema.String,
		cpuMaxPercent: CHNumber,
		memMaxPercent: CHNumber,
		replicaLagMaxSeconds: CHNumber,
	})

export const planetscaleBranchStatsRowSchema: CompiledQueryRowSchema<PlanetScaleBranchStatsOutput> =
	Schema.Struct({
		database: Schema.String,
		branch: Schema.String,
		cpuMaxPercent: CHNumber,
		memMaxPercent: CHNumber,
		replicaLagMaxSeconds: CHNumber,
	})

export const planetscaleStorageRowSchema: CompiledQueryRowSchema<PlanetScaleStorageOutput> =
	Schema.Struct({
		database: Schema.String,
		storageUsedPercent: CHNumber,
		storageSamples: CHNumber,
	})

export const planetscaleBranchStorageRowSchema: CompiledQueryRowSchema<PlanetScaleBranchStorageOutput> =
	Schema.Struct({
		database: Schema.String,
		branch: Schema.String,
		storageUsedPercent: CHNumber,
		storageCapacityBytes: CHNumber,
		storageAvailableBytes: CHNumber,
		storageSamples: CHNumber,
	})

export const planetscaleConnectionsRowSchema: CompiledQueryRowSchema<PlanetScaleConnectionsOutput> =
	Schema.Struct({
		database: Schema.String,
		connectionsAvg: CHNumber,
		connectionsMax: CHNumber,
	})

export const planetscaleBranchConnectionsRowSchema: CompiledQueryRowSchema<PlanetScaleBranchConnectionsOutput> =
	Schema.Struct({
		database: Schema.String,
		branch: Schema.String,
		connectionsAvg: CHNumber,
		connectionsMax: CHNumber,
	})

/**
 * CPU/memory/replica-lag rollup over `metrics_gauge`, one row per database.
 * Max over the window is the right shape for utilization/lag KPIs — a node
 * chip should show the worst, not the mean.
 */
export function planetscaleGaugesSQL() {
	return from(MetricsGauge)
		.select(($) => ({
			database: CH.coalesce(
				CH.nullIf($.Attributes.get("planetscale_database_name"), ""),
				$.Attributes.get("planetscale_database"),
			),
			cpuMaxPercent: CH.maxIf($.Value, $.MetricName.in_(...CPU_METRIC_NAMES)),
			memMaxPercent: CH.maxIf($.Value, $.MetricName.in_(...MEMORY_METRIC_NAMES)),
			replicaLagMaxSeconds: CH.maxIf($.Value, $.MetricName.in_(...REPLICA_LAG_METRIC_NAMES)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.in_(...GAUGE_METRIC_NAMES),
			CH.coalesce(
				CH.nullIf($.Attributes.get("planetscale_database_name"), ""),
				$.Attributes.get("planetscale_database"),
			).neq(""),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("database")
		.limit(500)
		.format("JSON")
}

/** Per-branch variant of {@link planetscaleGaugesSQL}, scoped to one database. */
export function planetscaleBranchGaugesSQL() {
	return from(MetricsGauge)
		.select(($) => ({
			database: CH.coalesce(
				CH.nullIf($.Attributes.get("planetscale_database_name"), ""),
				$.Attributes.get("planetscale_database"),
			),
			branch: CH.coalesce(
				CH.nullIf($.Attributes.get("planetscale_branch_name"), ""),
				$.Attributes.get("planetscale_branch"),
			),
			cpuMaxPercent: CH.maxIf($.Value, $.MetricName.in_(...CPU_METRIC_NAMES)),
			memMaxPercent: CH.maxIf($.Value, $.MetricName.in_(...MEMORY_METRIC_NAMES)),
			replicaLagMaxSeconds: CH.maxIf($.Value, $.MetricName.in_(...REPLICA_LAG_METRIC_NAMES)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.in_(...GAUGE_METRIC_NAMES),
			CH.coalesce(
				CH.nullIf($.Attributes.get("planetscale_database_name"), ""),
				$.Attributes.get("planetscale_database"),
			).eq(param.string("database")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("database", "branch")
		.limit(500)
		.format("JSON")
}

/**
 * Used percentage from a per-branch capacity/free pair, guarded twice: a zero
 * capacity would divide by zero, and zero free-space samples means the series
 * was absent for that branch — reading that as "no bytes free" would paint an
 * unmonitored branch as a full disk. Both cases yield 0, paired with the
 * `storageSamples` count so the caller can tell 0%-used from not-measured.
 */
const usedPercentExpr = ($: {
	capacityBytes: CH.Expr<number>
	availableBytes: CH.Expr<number>
	samples: CH.Expr<number>
}) =>
	CH.if_(
		$.capacityBytes.gt(0).and($.samples.gt(0)),
		// `100 - available / capacity * 100`, deliberately phrased as free-space
		// subtracted from the whole. The builder's arithmetic helpers do not
		// parenthesize, so the equivalent `(capacity - available) / capacity * 100`
		// would compile to `capacity - available / capacity * 100` and silently
		// compute something else entirely. This ordering is correct under plain
		// SQL precedence: `*` and `/` bind before `-`.
		CH.lit(100).sub($.availableBytes.div($.capacityBytes).mul(100)),
		CH.lit(0),
	)

/**
 * Storage rollup over the volume gauges, one row per database.
 *
 * PlanetScale reports capacity and *free* bytes, never used bytes, so the used
 * percentage is derived by the caller from `capacity - available`. The worst
 * moment in the window is what matters for a disk, hence max capacity against
 * min free space. `storageSamples` lets the caller tell "no free-space series"
 * apart from "genuinely zero free space" — the two gauges are scraped at
 * slightly different rates, so a missing series is a real possibility.
 */
export function planetscaleStorageSQL() {
	const perBranch = from(MetricsGauge)
		.select(($) => ({
			database: CH.coalesce(
				CH.nullIf($.Attributes.get("planetscale_database_name"), ""),
				$.Attributes.get("planetscale_database"),
			),
			branch: CH.coalesce(
				CH.nullIf($.Attributes.get("planetscale_branch_name"), ""),
				$.Attributes.get("planetscale_branch"),
			),
			capacityBytes: CH.maxIf($.Value, $.MetricName.in_(...STORAGE_CAPACITY_METRIC_NAMES)),
			availableBytes: CH.minIf($.Value, $.MetricName.in_(...STORAGE_AVAILABLE_METRIC_NAMES)),
			samples: CH.countIf($.MetricName.in_(...STORAGE_AVAILABLE_METRIC_NAMES)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.in_(...STORAGE_METRIC_NAMES),
			CH.coalesce(
				CH.nullIf($.Attributes.get("planetscale_database_name"), ""),
				$.Attributes.get("planetscale_database"),
			).neq(""),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("database", "branch")

	return fromQuery(perBranch, "vol")
		.select(($) => ({
			database: $.database,
			storageUsedPercent: CH.max_(usedPercentExpr($)),
			storageSamples: CH.sum($.samples),
		}))
		.groupBy("database")
		.limit(500)
		.format("JSON")
}

/** Per-branch variant of {@link planetscaleStorageSQL}, scoped to one database. */
export function planetscaleBranchStorageSQL() {
	const perBranch = from(MetricsGauge)
		.select(($) => ({
			database: CH.coalesce(
				CH.nullIf($.Attributes.get("planetscale_database_name"), ""),
				$.Attributes.get("planetscale_database"),
			),
			branch: CH.coalesce(
				CH.nullIf($.Attributes.get("planetscale_branch_name"), ""),
				$.Attributes.get("planetscale_branch"),
			),
			capacityBytes: CH.maxIf($.Value, $.MetricName.in_(...STORAGE_CAPACITY_METRIC_NAMES)),
			availableBytes: CH.minIf($.Value, $.MetricName.in_(...STORAGE_AVAILABLE_METRIC_NAMES)),
			samples: CH.countIf($.MetricName.in_(...STORAGE_AVAILABLE_METRIC_NAMES)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.in_(...STORAGE_METRIC_NAMES),
			CH.coalesce(
				CH.nullIf($.Attributes.get("planetscale_database_name"), ""),
				$.Attributes.get("planetscale_database"),
			).eq(param.string("database")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("database", "branch")

	return fromQuery(perBranch, "vol")
		.select(($) => ({
			database: $.database,
			branch: $.branch,
			storageUsedPercent: usedPercentExpr($),
			storageCapacityBytes: $.capacityBytes,
			storageAvailableBytes: $.availableBytes,
			storageSamples: $.samples,
		}))
		.limit(500)
		.format("JSON")
}

/**
 * Connection rollup: connections are one gauge series per edge/branch, so the
 * meaningful database-level number is the per-timestamp SUM across series —
 * computed in an inner grouping, then averaged (typical) and maxed (peak) over
 * the window.
 */
export function planetscaleConnectionsSQL() {
	const inner = from(MetricsGauge)
		.select(($) => ({
			database: CH.coalesce(
				CH.nullIf($.Attributes.get("planetscale_database_name"), ""),
				$.Attributes.get("planetscale_database"),
			),
			t: $.TimeUnix,
			totalConnections: CH.sum($.Value),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.in_(...CONNECTION_METRIC_NAMES),
			CH.coalesce(
				CH.nullIf($.Attributes.get("planetscale_database_name"), ""),
				$.Attributes.get("planetscale_database"),
			).neq(""),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("database", "t")

	return fromQuery(inner, "conn")
		.select(($) => ({
			database: $.database,
			connectionsAvg: CH.avg($.totalConnections),
			connectionsMax: CH.max_($.totalConnections),
		}))
		.groupBy("database")
		.limit(500)
		.format("JSON")
}

/** Per-branch variant of {@link planetscaleConnectionsSQL}, scoped to one database. */
export function planetscaleBranchConnectionsSQL() {
	const inner = from(MetricsGauge)
		.select(($) => ({
			database: CH.coalesce(
				CH.nullIf($.Attributes.get("planetscale_database_name"), ""),
				$.Attributes.get("planetscale_database"),
			),
			branch: CH.coalesce(
				CH.nullIf($.Attributes.get("planetscale_branch_name"), ""),
				$.Attributes.get("planetscale_branch"),
			),
			t: $.TimeUnix,
			totalConnections: CH.sum($.Value),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.in_(...CONNECTION_METRIC_NAMES),
			CH.coalesce(
				CH.nullIf($.Attributes.get("planetscale_database_name"), ""),
				$.Attributes.get("planetscale_database"),
			).eq(param.string("database")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("database", "branch", "t")

	return fromQuery(inner, "conn")
		.select(($) => ({
			database: $.database,
			branch: $.branch,
			connectionsAvg: CH.avg($.totalConnections),
			connectionsMax: CH.max_($.totalConnections),
		}))
		.groupBy("database", "branch")
		.limit(500)
		.format("JSON")
}
