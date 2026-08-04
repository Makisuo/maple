// ---------------------------------------------------------------------------
// Query Engine — lowering core
//
// Validation, QuerySpec → CH lowering, row shaping, and the alert evaluate /
// raw-SQL paths. Relocated from apps/api so the engine lives in one place; the
// app composes these via `QueryEngineService` (caching + Layer wiring) and
// injects a concrete warehouse + tenant. Span names are preserved verbatim
// ("QueryEngineService.*") so existing traces and dashboards keep matching.
// ---------------------------------------------------------------------------

import * as CH from "../ch"
import {
	QueryEngineExecuteResponse,
	type QueryEngineAlertObservation,
	type QueryEngineAlertReducer,
	type QueryEngineEvaluateRequest,
	type QueryEngineExecuteRequest,
	type QuerySpec,
	type TimeseriesPoint,
} from "@maple/domain/query-engine"
import {
	QueryEngineExecutionError,
	QueryEngineTimeoutError,
	QueryEngineValidationError,
	MAX_RAW_SQL_ALERT_GROUPS,
	MAX_RAW_SQL_GROUP_KEY_LENGTH,
	type RawSqlValidationError,
	type WarehouseError,
} from "@maple/domain/http"
import type { OrgId } from "@maple/domain"
import { Array as Arr, Duration, Effect, Match, Option, Result, Schema } from "effect"
import {
	LOGS_BODY_SEARCH_SETTINGS,
	type QueryProfileName,
	type SqlQueryOptions,
	type WarehouseQuerySettings,
} from "../profiles"
import { canonicalJSON } from "../canonical-json"
import { computeBucketSeconds } from "../datetime"
import {
	MAX_BREAKDOWN_RANGE_SECONDS,
	MAX_LIST_RANGE_SECONDS,
	MAX_QUERY_RANGE_SECONDS,
	MAX_TIMESERIES_POINTS,
	MAX_UNFILTERED_BREAKDOWN_RANGE_SECONDS,
	formatRangeSeconds,
} from "../limits"
import { attributeIndexMode, logBodySearchMode, type WarehouseCapabilities } from "../capabilities"
import { makeExecuteRawSql } from "./raw-sql"
import type { BucketGroupObs } from "./evaluate-bucket-codec"

// Re-exported so `@maple/query-engine/runtime` consumers (apps/api) keep importing
// `computeBucketSeconds` from here; the implementation now lives in the pure
// `../datetime` module so the web app and the engine share one definition.
export { computeBucketSeconds } from "../datetime"

// Same arrangement for the range ceilings: they now live in the pure `../limits`
// module so the MCP tools, the v2 API, and the web widget layer all bound
// ranges against one definition instead of their own copies.
export {
	MAX_BREAKDOWN_RANGE_SECONDS,
	MAX_LIST_RANGE_SECONDS,
	MAX_QUERY_RANGE_SECONDS,
	MAX_TIMESERIES_POINTS,
	MAX_UNFILTERED_BREAKDOWN_RANGE_SECONDS,
	formatRangeSeconds,
	maxRangeSecondsForKind,
	validateRelativeRange,
} from "../limits"
export { relativeRangeSeconds, resolveRelativeRange, resolveRelativeRangeToWarehouse } from "../datetime"

/** Minimal tenant surface the lowering needs — only the org scope. */
export interface QueryTenant {
	readonly orgId: OrgId
}

/**
 * The warehouse execution port the lowering depends on: a tenant-scoped raw-SQL
 * runner. Generic over the concrete tenant type `T` so this package stays
 * decoupled from apps/api's `TenantContext` — the app passes its
 * `WarehouseQueryService` and `T` is inferred as that concrete tenant.
 */
export interface QueryEngineWarehouse<T extends QueryTenant = QueryTenant> {
	readonly rawSqlQuery: (
		tenant: T,
		sql: string,
		options: { readonly profile: QueryProfileName; readonly context: string },
	) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, WarehouseError | RawSqlValidationError>
	readonly compiledQuery: <Output>(
		tenant: T,
		compiled: CH.CompiledQuery<Output>,
		options?: SqlQueryOptions,
	) => Effect.Effect<ReadonlyArray<Output>, WarehouseError>
	/** Capability-aware execution; adapters may deliberately compile the baseline plan. */
	readonly compiledQueryWithCapabilities: <Output>(
		tenant: T,
		compile: (capabilities: WarehouseCapabilities) => CH.CompiledQuery<Output>,
		options?: SqlQueryOptions,
	) => Effect.Effect<ReadonlyArray<Output>, WarehouseError>
}

export interface TimeRangeBounds {
	readonly startMs: number
	readonly endMs: number
	readonly rangeSeconds: number
}

interface BucketFillOptions {
	readonly startMs: number
	readonly endMs: number
	readonly bucketSeconds: number
}

interface MetricTimeseriesRow {
	readonly bucket: string | Date
	readonly serviceName: string
	readonly attributeValue: string
	readonly avgValue: number
	readonly minValue: number
	readonly maxValue: number
	readonly sumValue: number
	readonly dataPointCount: number
}

type AlertObservation = QueryEngineAlertObservation

export interface GroupedAlertObservation {
	readonly groupKey: string
	readonly value: number | null
	readonly sampleCount: number
	readonly hasData: boolean
}

/**
 * One alert evaluation, whatever kind of rule it came from.
 *
 * The `source` discriminator is the whole point: a trace built-in, a query
 * builder draft and user-authored SQL all arrive here as the same request, so
 * `evaluate` / `evaluateSeries` have a single implementation and callers never
 * branch on the rule kind.
 */
export interface AlertEvaluateRequest {
	/** Tinybird-format datetime (`YYYY-MM-DD HH:mm:ss`) — window start. */
	readonly startTime: string
	/** Tinybird-format datetime — window end. */
	readonly endTime: string
	readonly source: AlertBucketSource
	/** Collapses each group's bucket rows into a single scalar. */
	readonly reducer: QueryEngineAlertReducer
	/** Null for raw SQL, whose sample counts come from the `samples` column. */
	readonly sampleCountStrategy: QueryEngineEvaluateRequest["sampleCountStrategy"] | null
}

export type QueryEngineDirectError = QueryEngineExecutionError | QueryEngineTimeoutError | WarehouseError

export type QueryEngineRouteError = QueryEngineValidationError | QueryEngineDirectError

const QUERY_ENGINE_TIMEOUT = Duration.seconds(30)

export const withTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.timeoutOrElse({
			duration: QUERY_ENGINE_TIMEOUT,
			orElse: () =>
				// Mark the span before failing. Hitting this ceiling interrupts every
				// descendant, and the tracer records interrupt-only spans as `Ok`
				// (deliberately — a client disconnect or a cron teardown is normal
				// lifecycle, see flushable-tracer). That left a whole 30s timeout
				// looking healthy in any dashboard keyed on `StatusCode`. This
				// attribute makes the ceiling itself queryable without reclassifying
				// every ordinary interrupt as an error.
				Effect.annotateCurrentSpan({
					"query.timeout": true,
					"query.timeout_ms": Duration.toMillis(QUERY_ENGINE_TIMEOUT),
				}).pipe(
					Effect.flatMap(() =>
						Effect.logError("Query engine timeout").pipe(
							Effect.annotateLogs({
								timeoutMs: Duration.toMillis(QUERY_ENGINE_TIMEOUT),
							}),
						),
					),
					Effect.flatMap(() =>
						Effect.fail(
							new QueryEngineTimeoutError({
								message: "Query execution timed out after 30 seconds",
							}),
						),
					),
				),
		}),
	)

export const toEpochMs = (value: string): number => new Date(value.replace(" ", "T") + "Z").getTime()
const TINYBIRD_DATETIME_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?$/

export const msToTinybirdDateTime = (ms: number): string => {
	const iso = new Date(ms).toISOString()
	return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
}

const CACHE_SNAP_S = 15

/**
 * Snap a Tinybird datetime to a window. Used to align cache keys so that
 * concurrent requests within the same window share an entry. Larger windows
 * trade staleness for hit-rate.
 */
export function snapToWindow(dateStr: string, windowSeconds: number): string {
	// Defensive: a malformed/undefined timestamp must never crash the cache-key
	// path (it would surface as an opaque TypeError inside EdgeCacheService.
	// getOrCompute). Pass it through unchanged so the key stays deterministic.
	if (typeof dateStr !== "string") return dateStr
	if (dateStr.length !== 19 || dateStr[4] !== "-" || dateStr[10] !== " ") return dateStr
	if (windowSeconds <= 0 || windowSeconds > 3600) return dateStr
	// Snap by deriving epoch ms, flooring, formatting back. Handles cross-minute
	// and cross-hour boundaries cleanly for windows up to 1h.
	const ms = Date.parse(dateStr.replace(" ", "T") + "Z")
	if (Number.isNaN(ms)) return dateStr
	const snappedMs = Math.floor(ms / (windowSeconds * 1000)) * (windowSeconds * 1000)
	const iso = new Date(snappedMs).toISOString()
	return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
}

const snapSeconds = (dateStr: string): string => snapToWindow(dateStr, CACHE_SNAP_S)

/**
 * Discovery queries (attribute keys/values, facets) change slowly because
 * they're driven by what's been ingested. Use a wider snap window so
 * concurrent dashboard widgets share cache entries.
 */
export function snapWindowForQueryKind(kind: string): number {
	return Match.value(kind).pipe(
		Match.when("attributeKeys", () => 300), // 5 min
		Match.when("attributeValues", () => 60), // 1 min
		// 15 min — environments / commit SHAs / service names rarely change,
		// and the dashboard route reuses this cache for demo-detection + the
		// environment dropdown (was a heavy `serviceOverview` probe). This is
		// the gate on the dashboard critical path, so a wider window cuts
		// cold-miss frequency ~3× vs 5 min; a new service/env appearing up to
		// 15 min late in the dropdown is fine. Wider snap also collapses
		// near-simultaneous calls whose `startTime` ISO strings drift by
		// milliseconds between renders (useEffectiveTimeRange recomputes
		// `new Date()` per render).
		Match.when("facets", () => 900),
		Match.orElse(() => CACHE_SNAP_S),
	)
}

/**
 * TTL paired with the snap window above. Discovery queries can sit in cache
 * longer because the underlying signal (newly observed keys/values) updates
 * gradually as data ingests.
 */
export function cacheTtlForQueryKind(kind: string): number {
	return Match.value(kind).pipe(
		Match.when("attributeKeys", () => 300),
		Match.when("attributeValues", () => 60),
		Match.when("facets", () => 900), // matches snapWindowForQueryKind — see comment above
		Match.orElse(() => 15),
	)
}

/**
 * The query is canonicalized, not `JSON.stringify`d. The same widget reaches
 * this path from the dashboard builder, a saved template, and the MCP widget
 * tools, and those producers build the `QuerySpec` with different key insertion
 * order — which `JSON.stringify` faithfully preserves into three distinct keys
 * for one query. `canonicalJSON` is the same normalizer the bucket cache's
 * fingerprint uses, so both layers agree on when two queries are the same.
 */
export function buildCacheKey(orgId: string, request: QueryEngineExecuteRequest): string {
	const snap = snapWindowForQueryKind(request.query.kind)
	return `${orgId}:${snapToWindow(request.startTime, snap)}:${snapToWindow(request.endTime, snap)}:${canonicalJSON(request.query)}`
}

export function buildEvaluateCacheKey(orgId: string, request: AlertEvaluateRequest): string {
	// `source.kind` is part of the key so a spec plan and a raw-SQL plan can
	// never share an entry.
	const source =
		request.source.kind === "spec"
			? `spec:${canonicalJSON(request.source.query)}`
			: `raw:${request.source.windowMinutes}:${request.source.sql}`
	return `eval:${orgId}:${snapSeconds(request.startTime)}:${snapSeconds(request.endTime)}:${request.reducer}:${request.sampleCountStrategy}:${source}`
}

const DIRECT_CACHE_SNAP_KEYS = new Set(["startTime", "endTime"])
const DIRECT_CACHE_SET_KEYS = new Set([
	"commitShas",
	"environments",
	"namespaces",
	"serviceNames",
	"services",
	"spanNames",
])

export interface DirectRouteCachePolicy {
	/** Bump when response or key semantics change incompatibly. */
	readonly version: number
	readonly ttlSeconds: number
	/** Time-key coalescing is independent from storage lifetime. */
	readonly snapWindowSeconds: number
}

export type DirectRouteCachePolicyInput = number | DirectRouteCachePolicy

export function makeDirectRouteCachePolicy(
	options: {
		readonly ttlSeconds?: number
		readonly snapWindowSeconds?: number
		readonly version?: number
	} = {},
): DirectRouteCachePolicy {
	const ttlSeconds = Number.isFinite(options.ttlSeconds)
		? Math.max(1, Math.floor(options.ttlSeconds!))
		: CACHE_SNAP_S
	const requestedSnap = options.snapWindowSeconds ?? ttlSeconds
	const snapWindowSeconds = Number.isFinite(requestedSnap)
		? Math.min(3600, Math.max(1, Math.floor(requestedSnap)))
		: CACHE_SNAP_S
	const version = Number.isFinite(options.version) ? Math.max(1, Math.floor(options.version!)) : 1
	return { version, ttlSeconds, snapWindowSeconds }
}

export function resolveDirectRouteCachePolicy(
	input: DirectRouteCachePolicyInput = CACHE_SNAP_S,
): DirectRouteCachePolicy {
	return typeof input === "number"
		? makeDirectRouteCachePolicy({ ttlSeconds: input })
		: makeDirectRouteCachePolicy(input)
}

function normalizeDirectCacheValue(value: unknown, snapWindowSeconds: number, parentKey?: string): unknown {
	if (value == null) return value
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		if (parentKey && DIRECT_CACHE_SNAP_KEYS.has(parentKey) && typeof value === "string") {
			return snapToWindow(value, snapWindowSeconds)
		}
		return value
	}

	if (Array.isArray(value)) {
		const normalized = value.map((item) => normalizeDirectCacheValue(item, snapWindowSeconds))
		if (
			parentKey &&
			DIRECT_CACHE_SET_KEYS.has(parentKey) &&
			normalized.every((item) => ["string", "number", "boolean"].includes(typeof item))
		) {
			return [...new Map(normalized.map((item) => [JSON.stringify(item), item])).values()].sort(
				(a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)),
			)
		}
		return normalized
	}

	if (typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, nestedValue]) => nestedValue !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, nestedValue]) => [
					key,
					normalizeDirectCacheValue(nestedValue, snapWindowSeconds, key),
				]),
		)
	}

	return String(value)
}

export function buildDirectRouteCacheKey(
	orgId: string,
	routeName: string,
	payload: unknown,
	policyInput: DirectRouteCachePolicyInput = CACHE_SNAP_S,
): string {
	const policy = resolveDirectRouteCachePolicy(policyInput)
	return `direct:v${policy.version}:${orgId}:${routeName}:${JSON.stringify(normalizeDirectCacheValue(payload, policy.snapWindowSeconds))}`
}

const floorToBucketMs = (epochMs: number, bucketSeconds: number): number => {
	const bucketMs = bucketSeconds * 1000
	return Math.floor(epochMs / bucketMs) * bucketMs
}

const buildBucketTimeline = (startMs: number, endMs: number, bucketSeconds: number): string[] => {
	const bucketMs = bucketSeconds * 1000
	const firstBucketMs = floorToBucketMs(startMs, bucketSeconds)
	const lastBucketMs = floorToBucketMs(endMs, bucketSeconds)
	const timeline: string[] = []

	for (let bucketMsCursor = firstBucketMs; bucketMsCursor <= lastBucketMs; bucketMsCursor += bucketMs) {
		timeline.push(new Date(bucketMsCursor).toISOString())
	}

	return timeline
}

const normalizeBucket = (bucket: string | Date): string => {
	if (bucket instanceof Date) {
		return bucket.toISOString()
	}

	const raw = String(bucket).trim()
	if (!raw) {
		return raw
	}

	const tinybirdDateTimeMatch = raw.match(TINYBIRD_DATETIME_RE)
	if (tinybirdDateTimeMatch) {
		const [, datePart, timePart, fractional = ""] = tinybirdDateTimeMatch
		const normalized = new Date(`${datePart}T${timePart}${fractional}Z`)
		if (!Number.isNaN(normalized.getTime())) {
			return normalized.toISOString()
		}
	}

	const parsed = new Date(raw)
	if (!Number.isNaN(parsed.getTime())) {
		return parsed.toISOString()
	}

	return raw
}

const validateTimeRange = Effect.fn("QueryEngineService.validateTimeRange")(function* (request: {
	readonly startTime: string
	readonly endTime: string
}): Effect.fn.Return<TimeRangeBounds, QueryEngineValidationError> {
	const startMs = toEpochMs(request.startTime)
	const endMs = toEpochMs(request.endTime)

	if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
		return yield* new QueryEngineValidationError({
			message: "Invalid time range",
			details: ["startTime and endTime must be valid datetime strings"],
		})
	}

	if (endMs <= startMs) {
		return yield* new QueryEngineValidationError({
			message: "Invalid time range",
			details: ["endTime must be greater than startTime"],
		})
	}

	const rangeSeconds = (endMs - startMs) / 1000
	if (rangeSeconds > MAX_QUERY_RANGE_SECONDS) {
		return yield* new QueryEngineValidationError({
			message: "Time range too large",
			details: [`Maximum supported range is ${formatRangeSeconds(MAX_QUERY_RANGE_SECONDS)}`],
		})
	}

	return {
		startMs,
		endMs,
		rangeSeconds,
	}
})

const validateTraceAttributeFilters = Effect.fn("QueryEngineService.validateTraceAttributeFilters")(
	function* (query: QuerySpec): Effect.fn.Return<void, QueryEngineValidationError> {
		if (query.source !== "traces") return
		if (query.kind !== "timeseries" && query.kind !== "breakdown") return

		const details: string[] = []
		if (query.groupBy?.includes("attribute") && !query.filters?.groupByAttributeKeys?.length) {
			details.push("groupBy=attribute requires filters.groupByAttributeKeys")
		}

		if (details.length > 0) {
			return yield* new QueryEngineValidationError({
				message: "Invalid traces attribute filters",
				details,
			})
		}
	},
)

const validateMetricsAttributeFilters = Effect.fn("QueryEngineService.validateMetricsAttributeFilters")(
	function* (query: QuerySpec): Effect.fn.Return<void, QueryEngineValidationError> {
		if (query.source !== "metrics") return
		if (query.kind !== "timeseries" && query.kind !== "breakdown") return

		// `groupBy` is an array for timeseries, a single literal for breakdown.
		const groupBy = query.groupBy
		const wantsAttribute = Array.isArray(groupBy)
			? groupBy.includes("attribute")
			: groupBy === "attribute"
		const wantsResourceAttribute = Array.isArray(groupBy)
			? groupBy.includes("resource_attribute")
			: groupBy === "resource_attribute"
		if (wantsAttribute && !query.filters.groupByAttributeKey) {
			// Mirror the traces guard: never silently downgrade an attribute grouping
			// to a service grouping — the agent asked for a label breakdown.
			return yield* new QueryEngineValidationError({
				message: "Invalid metrics attribute grouping",
				details: ["groupBy=attribute requires filters.groupByAttributeKey"],
			})
		}
		if (wantsResourceAttribute && !query.filters.groupByResourceAttributeKey) {
			return yield* new QueryEngineValidationError({
				message: "Invalid metrics attribute grouping",
				details: ["groupBy=resource_attribute requires filters.groupByResourceAttributeKey"],
			})
		}
		if (wantsAttribute && wantsResourceAttribute) {
			// The metrics queries carry a single attributeValue group column — one
			// attribute dimension per query.
			return yield* new QueryEngineValidationError({
				message: "Invalid metrics attribute grouping",
				details: ["groupBy cannot combine attribute and resource_attribute"],
			})
		}
	},
)

const validatePointBudget = Effect.fn("QueryEngineService.validatePointBudget")(function* (
	request: QueryEngineExecuteRequest,
	range: TimeRangeBounds,
): Effect.fn.Return<void, QueryEngineValidationError> {
	if (request.query.kind !== "timeseries") return
	const bucketSeconds = request.query.bucketSeconds ?? computeBucketSeconds(range.startMs, range.endMs)
	const pointCount = Math.ceil(range.rangeSeconds / bucketSeconds)
	if (pointCount <= MAX_TIMESERIES_POINTS) return

	return yield* new QueryEngineValidationError({
		message: "Timeseries query too expensive",
		details: [
			`Requested ${pointCount} points, maximum is ${MAX_TIMESERIES_POINTS}`,
			"Increase bucketSeconds or reduce the time range",
		],
	})
})

const validateListQuery = Effect.fn("QueryEngineService.validateListQuery")(function* (
	request: QueryEngineExecuteRequest,
	range: TimeRangeBounds,
): Effect.fn.Return<void, QueryEngineValidationError> {
	if (request.query.kind !== "list") return

	if (range.rangeSeconds > MAX_LIST_RANGE_SECONDS) {
		return yield* new QueryEngineValidationError({
			message: "List query time range too large",
			details: [
				`List queries support a maximum range of ${formatRangeSeconds(MAX_LIST_RANGE_SECONDS)}`,
				"Narrow the time range or use a timeseries/breakdown query for wider ranges",
			],
		})
	}
})

/**
 * Whether the query carries a filter narrow enough to keep ClickHouse from
 * scanning the whole partition prefix. Used to reject obviously broad
 * breakdown queries before they hit Tinybird.
 */
function hasNarrowingFilter(request: QueryEngineExecuteRequest): boolean {
	if (!("filters" in request.query) || !request.query.filters) return false
	const filters = request.query.filters as Record<string, unknown>
	if (
		filters.serviceName ||
		filters.spanName ||
		filters.metricName ||
		filters.traceId ||
		filters.spanId ||
		filters.statusCode ||
		filters.severity ||
		filters.search ||
		filters.minDurationMs !== undefined ||
		filters.maxDurationMs !== undefined ||
		filters.minSeverity !== undefined ||
		filters.errorsOnly !== undefined ||
		filters.rootOnly
	) {
		return true
	}
	const envs = filters.environments
	if (Array.isArray(envs) && envs.length > 0) return true
	const services = filters.services
	if (Array.isArray(services) && services.length > 0) return true
	const serviceNames = filters.serviceNames
	if (Array.isArray(serviceNames) && serviceNames.length > 0) return true
	const spanNames = filters.spanNames
	if (Array.isArray(spanNames) && spanNames.length > 0) return true
	const namespaces = filters.namespaces
	if (Array.isArray(namespaces) && namespaces.length > 0) return true
	const attributeFilters = filters.attributeFilters
	if (Array.isArray(attributeFilters) && attributeFilters.length > 0) return true
	const resourceAttributeFilters = filters.resourceAttributeFilters
	if (Array.isArray(resourceAttributeFilters) && resourceAttributeFilters.length > 0) return true
	return false
}

/**
 * Reject obviously expensive breakdown queries before submission. Wide
 * unfiltered breakdowns scan vast amounts of data; the per-query
 * `max_execution_time` setting (Item B profiles) catches them eventually,
 * but failing fast gives the user a friendlier message and saves the
 * 15-30s wait until ClickHouse trips its own timeout.
 */
const validateBreakdownQuery = Effect.fn("QueryEngineService.validateBreakdownQuery")(function* (
	request: QueryEngineExecuteRequest,
	range: TimeRangeBounds,
): Effect.fn.Return<void, QueryEngineValidationError> {
	if (request.query.kind !== "breakdown") return

	if (range.rangeSeconds > MAX_BREAKDOWN_RANGE_SECONDS) {
		return yield* new QueryEngineValidationError({
			message: "Breakdown query time range too large",
			details: [
				`Breakdown queries support a maximum range of ${formatRangeSeconds(MAX_BREAKDOWN_RANGE_SECONDS)}`,
				"Narrow the time range or use a timeseries query for wider trends",
			],
		})
	}

	if (range.rangeSeconds > MAX_UNFILTERED_BREAKDOWN_RANGE_SECONDS && !hasNarrowingFilter(request)) {
		return yield* new QueryEngineValidationError({
			message: "Breakdown query too broad without filters",
			details: [
				`Breakdowns spanning more than ${formatRangeSeconds(MAX_UNFILTERED_BREAKDOWN_RANGE_SECONDS)} require a serviceName, environment, or similar filter`,
				"Add a filter or narrow the time range",
			],
		})
	}
})

function groupTimeSeriesRows<T extends { bucket: string | Date; groupName: string }>(
	rows: ReadonlyArray<T>,
	valueExtractor: (row: T) => number,
	fillOptions?: BucketFillOptions,
): Array<TimeseriesPoint> {
	const bucketMap = new Map<string, Record<string, number>>()
	const bucketOrder: string[] = fillOptions
		? buildBucketTimeline(fillOptions.startMs, fillOptions.endMs, fillOptions.bucketSeconds)
		: []

	for (const row of rows) {
		const bucket = normalizeBucket(row.bucket)
		if (!bucketMap.has(bucket)) {
			bucketMap.set(bucket, {})
			if (!fillOptions) {
				bucketOrder.push(bucket)
			}
		}
		bucketMap.get(bucket)![row.groupName] = valueExtractor(row)
	}

	if (fillOptions) {
		for (const bucket of bucketOrder) {
			if (!bucketMap.has(bucket)) {
				bucketMap.set(bucket, {})
			}
		}
	}

	return bucketOrder.map((bucket) => ({
		bucket,
		series: bucketMap.get(bucket)!,
	}))
}

function groupAllMetricsTimeSeriesRows<
	T extends {
		bucket: string | Date
		groupName: string
		count: number
		avgDuration: number
		p50Duration: number
		p95Duration: number
		p99Duration: number
		errorRate: number
		apdexScore: number
		estimatedSpanCount: number
	},
>(rows: ReadonlyArray<T>, fillOptions?: BucketFillOptions): Array<TimeseriesPoint> {
	const emptyMetrics: Record<string, number> = {
		count: 0,
		avg_duration: 0,
		p50_duration: 0,
		p95_duration: 0,
		p99_duration: 0,
		error_rate: 0,
		apdex: 0,
		estimated_span_count: 0,
	}
	const bucketMap = new Map<string, Record<string, number>>()
	const bucketOrder: string[] = fillOptions
		? buildBucketTimeline(fillOptions.startMs, fillOptions.endMs, fillOptions.bucketSeconds)
		: []
	const isGrouped = rows.some((row) => row.groupName !== "all")
	const metricKey = (metric: string, groupName: string) =>
		isGrouped ? `${metric}::${groupName || "all"}` : metric

	for (const row of rows) {
		const bucket = normalizeBucket(row.bucket)
		let series = bucketMap.get(bucket)
		if (!series) {
			series = {}
			bucketMap.set(bucket, series)
		}
		series[metricKey("count", row.groupName)] = Number(row.count)
		series[metricKey("avg_duration", row.groupName)] = Number(row.avgDuration)
		series[metricKey("p50_duration", row.groupName)] = Number(row.p50Duration)
		series[metricKey("p95_duration", row.groupName)] = Number(row.p95Duration)
		series[metricKey("p99_duration", row.groupName)] = Number(row.p99Duration)
		series[metricKey("error_rate", row.groupName)] = Number(row.errorRate)
		series[metricKey("apdex", row.groupName)] = Number(row.apdexScore)
		series[metricKey("estimated_span_count", row.groupName)] = Number(row.estimatedSpanCount)
		if (!fillOptions && !bucketOrder.includes(bucket)) {
			bucketOrder.push(bucket)
		}
	}

	if (fillOptions) {
		for (const bucket of bucketOrder) {
			if (!bucketMap.has(bucket)) {
				bucketMap.set(bucket, isGrouped ? {} : { ...emptyMetrics })
			}
		}
	}

	return bucketOrder.map((bucket) => ({
		bucket,
		series: bucketMap.get(bucket)!,
	}))
}

function collapseMetricTimeseriesRows(
	rows: ReadonlyArray<MetricTimeseriesRow>,
	metric: Extract<QuerySpec, { metric: string }>["metric"],
): Array<{ bucket: string; groupName: "all"; value: number }> {
	const bucketMap = new Map<
		string,
		{
			sumValue: number
			dataPointCount: number
			minValue: number
			maxValue: number
		}
	>()

	for (const row of rows) {
		const bucket = normalizeBucket(row.bucket)
		const current = bucketMap.get(bucket)
		if (current) {
			current.sumValue += Number(row.sumValue)
			current.dataPointCount += Number(row.dataPointCount)
			current.minValue = Math.min(current.minValue, Number(row.minValue))
			current.maxValue = Math.max(current.maxValue, Number(row.maxValue))
		} else {
			bucketMap.set(bucket, {
				sumValue: Number(row.sumValue),
				dataPointCount: Number(row.dataPointCount),
				minValue: Number(row.minValue),
				maxValue: Number(row.maxValue),
			})
		}
	}

	return [...bucketMap.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([bucket, value]) => ({
			bucket,
			groupName: "all" as const,
			value:
				metric === "count"
					? value.dataPointCount
					: metric === "sum"
						? value.sumValue
						: metric === "min"
							? value.minValue
							: metric === "max"
								? value.maxValue
								: value.dataPointCount > 0
									? value.sumValue / value.dataPointCount
									: 0,
		}))
}

const validateExecute = Effect.fn("QueryEngineService.validateExecute")(function* (
	request: QueryEngineExecuteRequest,
): Effect.fn.Return<TimeRangeBounds, QueryEngineValidationError> {
	const range = yield* validateTimeRange(request)
	yield* validateTraceAttributeFilters(request.query)
	yield* validateMetricsAttributeFilters(request.query)
	yield* validatePointBudget(request, range)
	yield* validateListQuery(request, range)
	yield* validateBreakdownQuery(request, range)
	return range
})

export const validateEvaluate = Effect.fn("QueryEngineService.validateEvaluate")(function* (
	request: AlertEvaluateRequest,
): Effect.fn.Return<TimeRangeBounds, QueryEngineValidationError> {
	const range = yield* validateTimeRange(request)
	// Attribute-filter validation only applies to a structured spec; raw SQL is
	// validated by `prepareRawSql` at compile and execute time instead.
	if (request.source.kind === "spec") {
		yield* validateTraceAttributeFilters(request.source.query)
		yield* validateMetricsAttributeFilters(request.source.query)
	}
	return range
})

/**
 * Annotate the current span with warehouse-error context on failure, without
 * touching the error itself. The error type in equals the error type out — this
 * is `Effect.tapError`, not a transformation. Named explicitly so call sites
 * don't read like they're remapping errors.
 */
const annotateWarehouseError = <A, R>(
	effect: Effect.Effect<A, WarehouseError, R>,
	context: string,
): Effect.Effect<A, WarehouseError, R> =>
	effect.pipe(
		Effect.tapError((error) =>
			Effect.annotateCurrentSpan({
				"error.context": context,
				"error.tag": error._tag,
				"error.message": error.message,
			}),
		),
	)

/**
 * Compile a CHQuery, execute it via the warehouse SQL executor, and return typed rows.
 * The inner WarehouseQueryService.executeSql span carries the full SQL, fingerprint,
 * length, duration, and tenant data — `query.context` is propagated through
 * SqlQueryOptions so it lands on the same span instead of an extra wrapper.
 */
const executeCHQuery = Effect.fnUntraced(function* <
	Output extends Record<string, any>,
	Params extends Record<string, any>,
	T extends QueryTenant,
>(
	warehouse: QueryEngineWarehouse<T>,
	tenant: T,
	query: CH.CHQuery<any, Output> | ((capabilities: WarehouseCapabilities) => CH.CHQuery<any, Output>),
	params: Params,
	context: string,
	profile: QueryProfileName = "aggregation",
	settings?: WarehouseQuerySettings,
) {
	const options = { profile, context, settings } as const
	if (typeof query === "function") {
		const compile = (capabilities: WarehouseCapabilities) => CH.compile(query(capabilities), params)
		return yield* annotateWarehouseError(
			warehouse.compiledQueryWithCapabilities(tenant, compile, options),
			context,
		)
	}

	const compiled = CH.compile(query, params)
	return yield* annotateWarehouseError(warehouse.compiledQuery(tenant, compiled, options), context)
})

type MetricsTimeseriesSpec = Extract<QuerySpec, { readonly source: "metrics"; readonly kind: "timeseries" }>

const executeMetricsTimeseriesRows = Effect.fnUntraced(function* <T extends QueryTenant>(
	warehouse: QueryEngineWarehouse<T>,
	tenant: T,
	query: MetricsTimeseriesSpec,
	range: { readonly startTime: string; readonly endTime: string; readonly bucketSeconds: number },
	contexts: { readonly value: string; readonly rate: string },
) {
	const groupByAttributeKey = query.groupBy?.includes("attribute")
		? query.filters.groupByAttributeKey
		: undefined
	const groupByResourceAttributeKey = query.groupBy?.includes("resource_attribute")
		? query.filters.groupByResourceAttributeKey
		: undefined
	const attributeFilter = query.filters.attributeFilters?.[0]
	const options = {
		serviceName: query.filters.serviceName,
		environments: query.filters.environments,
		groupByAttributeKey,
		groupByResourceAttributeKey,
		attributeKey: attributeFilter?.key,
		attributeValue: attributeFilter?.value,
		resourceAttributeFilters: query.filters.resourceAttributeFilters,
		groupBy: query.groupBy,
		seriesLimit: query.seriesLimit,
	}
	const params = {
		orgId: tenant.orgId,
		metricName: query.filters.metricName,
		...range,
	}
	const groupByKey = groupByAttributeKey ?? groupByResourceAttributeKey

	if (query.metric === "rate" || query.metric === "increase") {
		const rows = yield* executeCHQuery(
			warehouse,
			tenant,
			CH.metricsTimeseriesRateQuery({
				...options,
				metricName: query.filters.metricName,
				metricNames: query.filters.metricNames,
				bucketSeconds: range.bucketSeconds,
			}),
			params,
			contexts.rate,
		)
		return { kind: "rate" as const, rows, groupByKey }
	}

	const rows = yield* executeCHQuery(
		warehouse,
		tenant,
		CH.metricsTimeseriesQuery({ ...options, metricType: query.filters.metricType }),
		params,
		contexts.value,
	)
	return { kind: "value" as const, rows, groupByKey }
})

/** Same as executeCHQuery but for union queries. */
const executeCHUnionQuery = Effect.fnUntraced(function* <
	Output extends Record<string, any>,
	Params extends Record<string, any>,
	T extends QueryTenant,
>(
	warehouse: QueryEngineWarehouse<T>,
	tenant: T,
	query: CH.CHUnionQuery<Output>,
	params: Params,
	context: string,
	profile: QueryProfileName = "aggregation",
) {
	const compiled = CH.compileUnion(query, params)
	return yield* annotateWarehouseError(
		warehouse.compiledQuery(tenant, compiled, { profile, context }),
		context,
	)
})

const tracesMetricFieldMap = {
	count: "count",
	avg_duration: "avgDuration",
	p50_duration: "p50Duration",
	p95_duration: "p95Duration",
	p99_duration: "p99Duration",
	error_rate: "errorRate",
	apdex: "apdexScore",
} as const

const tracesAggregateValueForMetric = (
	metric: Extract<QuerySpec, { source: "traces"; metric: string }>["metric"],
	row: {
		readonly count: number
		readonly avgDuration: number
		readonly p50Duration: number
		readonly p95Duration: number
		readonly p99Duration: number
		readonly errorRate: number
		readonly apdexScore: number
	},
): number => Number(row[tracesMetricFieldMap[metric]])

const metricsAggregateValueForMetric = (
	metric: Extract<QuerySpec, { source: "metrics"; metric: string }>["metric"],
	row: {
		readonly avgValue?: number
		readonly minValue?: number
		readonly maxValue?: number
		readonly sumValue?: number
		readonly dataPointCount?: number
		readonly rateValue?: number
		readonly increaseValue?: number
	},
): number =>
	Match.value(metric).pipe(
		Match.when("avg", () => Number(row.avgValue)),
		Match.when("min", () => Number(row.minValue)),
		Match.when("max", () => Number(row.maxValue)),
		Match.when("sum", () => Number(row.sumValue)),
		Match.when("count", () => Number(row.dataPointCount)),
		Match.when("rate", () => Number(row.rateValue)),
		Match.when("increase", () => Number(row.increaseValue)),
		Match.exhaustive,
	)

const applyAlertReducer = (
	observations: ReadonlyArray<AlertObservation>,
	reducer: QueryEngineAlertReducer,
): number | null => {
	const values = Arr.filterMap(observations, (observation) =>
		observation.hasData && observation.value != null
			? Result.succeed(observation.value as number)
			: Result.failVoid,
	)

	if (values.length === 0) {
		return null
	}

	return Match.value(reducer).pipe(
		Match.when("identity", () => Option.getOrNull(Arr.head(values))),
		Match.when("sum", () => Arr.reduce(values, 0, (sum, value) => sum + value)),
		Match.when("avg", () => Arr.reduce(values, 0, (sum, value) => sum + value) / values.length),
		Match.when("min", () => Math.min(...values)),
		Match.when("max", () => Math.max(...values)),
		Match.exhaustive,
	)
}

/** Map query engine source/scope to the MV's AttributeScope value. */
function resolveAttributeScope(source: "traces" | "logs" | "metrics", scope?: "span" | "resource"): string {
	if (source === "metrics") return "metric"
	if (source === "logs") return scope === "resource" ? "resource" : "log"
	return scope === "resource" ? "resource" : "span"
}

type AttrFilterArray = Array<{
	key: string
	value?: string
	values?: readonly string[]
	mode: "equals" | "exists" | "gt" | "gte" | "lt" | "lte" | "contains" | "in"
	negated?: boolean
}>

function extractTracesOpts(filters: Record<string, unknown> | undefined) {
	return {
		serviceName: filters?.serviceName as string | undefined,
		spanName: filters?.spanName as string | undefined,
		serviceNames: filters?.serviceNames as readonly string[] | undefined,
		spanNames: filters?.spanNames as readonly string[] | undefined,
		statusCode: filters?.statusCode as "Ok" | "Error" | "Unset" | undefined,
		rootOnly: filters?.rootSpansOnly as boolean | undefined,
		errorsOnly: filters?.errorsOnly as boolean | undefined,
		environments: filters?.environments as string[] | undefined,
		namespaces: filters?.namespaces as string[] | undefined,
		commitShas: filters?.commitShas as string[] | undefined,
		minDurationMs: filters?.minDurationMs as number | undefined,
		maxDurationMs: filters?.maxDurationMs as number | undefined,
		matchModes: filters?.matchModes as
			| {
					serviceName?: "contains"
					spanName?: "contains"
					deploymentEnv?: "contains"
					serviceNamespace?: "contains"
			  }
			| undefined,
		attributeFilters: filters?.attributeFilters as AttrFilterArray | undefined,
		resourceAttributeFilters: filters?.resourceAttributeFilters as AttrFilterArray | undefined,
		groupByAttributeKeys: filters?.groupByAttributeKeys as string[] | undefined,
		excludedServiceNames: filters?.excludedServiceNames as readonly string[] | undefined,
		excludedSpanNames: filters?.excludedSpanNames as readonly string[] | undefined,
		excludedEnvironments: filters?.excludedEnvironments as readonly string[] | undefined,
		excludedNamespaces: filters?.excludedNamespaces as readonly string[] | undefined,
	}
}

function extractLogsOpts(filters: Record<string, unknown> | undefined) {
	return {
		serviceName: filters?.serviceName as string | undefined,
		severity: filters?.severity as string | undefined,
		minSeverity: filters?.minSeverity as number | undefined,
		traceId: filters?.traceId as string | undefined,
		spanId: filters?.spanId as string | undefined,
		search: filters?.search as string | undefined,
		environments: filters?.environments as string[] | undefined,
		namespaces: filters?.namespaces as string[] | undefined,
		matchModes: logsMatchModes(filters),
		attributeFilters: filters?.attributeFilters as AttrFilterArray | undefined,
		resourceAttributeFilters: filters?.resourceAttributeFilters as AttrFilterArray | undefined,
	}
}

/**
 * Map TracesFilters to the flat opts format expected by tracesFacetsQuery / tracesDurationStatsQuery.
 * TracesFilters stores http filters as attributeFilters entries; facets opts want them as top-level fields.
 */
function extractTracesFacetsOpts(filters: Record<string, unknown> | undefined): CH.TracesFacetsOpts {
	const attrFilters = (filters?.attributeFilters ?? []) as AttrFilterArray
	const resFilters = (filters?.resourceAttributeFilters ?? []) as AttrFilterArray

	// Positive http filters arrive either as a single `equals` or, when the user
	// ticks several facet values, as one `in` carrying the whole set. Negated
	// entries are exclusions and must not be read as inclusions here.
	const isPositiveHttp = (f: AttrFilterArray[number], key: string) => f.key === key && !f.negated
	const httpMethodFilter = attrFilters.find((f) => isPositiveHttp(f, "http.method"))
	const httpStatusFilter = attrFilters.find((f) => isPositiveHttp(f, "http.status_code"))
	const customAttr = attrFilters.find((f) => f.key !== "http.method" && f.key !== "http.status_code")
	const customRes = resFilters[0]

	const envs = filters?.environments as string[] | undefined
	const namespaces = filters?.namespaces as string[] | undefined

	return {
		serviceName: filters?.serviceName as string | undefined,
		spanName: filters?.spanName as string | undefined,
		serviceNames: filters?.serviceNames as readonly string[] | undefined,
		spanNames: filters?.spanNames as readonly string[] | undefined,
		hasError: filters?.errorsOnly as boolean | undefined,
		minDurationMs: filters?.minDurationMs as number | undefined,
		maxDurationMs: filters?.maxDurationMs as number | undefined,
		httpMethod: httpMethodFilter?.mode === "in" ? undefined : httpMethodFilter?.value,
		httpStatusCode: httpStatusFilter?.mode === "in" ? undefined : httpStatusFilter?.value,
		httpMethods: httpMethodFilter?.mode === "in" ? httpMethodFilter.values : undefined,
		httpStatusCodes: httpStatusFilter?.mode === "in" ? httpStatusFilter.values : undefined,
		deploymentEnvs: envs,
		namespaces,
		matchModes: filters?.matchModes as CH.TracesFacetsOpts["matchModes"],
		attributeFilterKey: customAttr?.key,
		attributeFilterValue: customAttr?.value,
		attributeFilterValueMatchMode: customAttr?.mode === "contains" ? "contains" : undefined,
		resourceFilterKey: customRes?.key,
		resourceFilterValue: customRes?.value,
		resourceFilterValueMatchMode: customRes?.mode === "contains" ? "contains" : undefined,
	}
}

/**
 * Combine the deployment-env and service-namespace `contains` match modes into
 * the single `matchModes` object the logs queries expect.
 */
function logsMatchModes(
	filters: Record<string, unknown> | undefined,
): { deploymentEnv?: "contains"; serviceNamespace?: "contains" } | undefined {
	const deploymentEnv = filters?.deploymentEnvMatchMode as "contains" | undefined
	const serviceNamespace = filters?.namespaceMatchMode as "contains" | undefined
	return Match.value([deploymentEnv, serviceNamespace] as const).pipe(
		Match.when([undefined, undefined], () => undefined),
		Match.orElse(([deploymentEnv, serviceNamespace]) => ({ deploymentEnv, serviceNamespace })),
	)
}

function extractTracesDurationStatsOpts(
	filters: Record<string, unknown> | undefined,
): CH.TracesDurationStatsOpts {
	const facetsOpts = extractTracesFacetsOpts(filters)
	return {
		serviceName: facetsOpts.serviceName,
		spanName: facetsOpts.spanName,
		serviceNames: facetsOpts.serviceNames,
		spanNames: facetsOpts.spanNames,
		hasError: facetsOpts.hasError,
		minDurationMs: facetsOpts.minDurationMs,
		maxDurationMs: facetsOpts.maxDurationMs,
		httpMethod: facetsOpts.httpMethod,
		httpStatusCode: facetsOpts.httpStatusCode,
		httpMethods: facetsOpts.httpMethods,
		httpStatusCodes: facetsOpts.httpStatusCodes,
		deploymentEnvs: facetsOpts.deploymentEnvs,
		namespaces: facetsOpts.namespaces,
		matchModes: facetsOpts.matchModes,
	}
}

function shapeMetricsGroupRows<
	T extends { bucket: string | Date; serviceName: string; attributeValue: string },
>(
	rows: ReadonlyArray<T>,
	valueExtractor: (row: T) => number,
	groupBy: readonly string[] | undefined,
	groupByAttributeKey: string | undefined,
	fillOptions: BucketFillOptions | undefined,
): Array<TimeseriesPoint> {
	if (groupBy?.includes("none") || !groupBy?.length) {
		return groupTimeSeriesRows(
			rows.map((row) => ({
				bucket: row.bucket,
				groupName: "all" as const,
				value: valueExtractor(row),
			})),
			(r) => r.value,
			fillOptions,
		)
	}
	if (groupByAttributeKey) {
		return groupTimeSeriesRows(
			rows.map((row) => ({
				bucket: row.bucket,
				groupName: row.attributeValue || "(empty)",
				value: valueExtractor(row),
			})),
			(r) => r.value,
			fillOptions,
		)
	}
	return groupTimeSeriesRows(
		rows.map((row) => ({ bucket: row.bucket, groupName: row.serviceName, value: valueExtractor(row) })),
		(r) => r.value,
		fillOptions,
	)
}

export const makeQueryEngineExecute = <T extends QueryTenant>(warehouse: QueryEngineWarehouse<T>) =>
	Effect.fn("QueryEngineService.execute")(function* (
		tenant: T,
		request: QueryEngineExecuteRequest,
	): Effect.fn.Return<
		QueryEngineExecuteResponse,
		QueryEngineValidationError | QueryEngineExecutionError | WarehouseError
	> {
		yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)
		yield* Effect.annotateCurrentSpan("query.source", request.query.source)
		yield* Effect.annotateCurrentSpan("query.kind", request.query.kind)
		if ("metric" in request.query && request.query.metric) {
			yield* Effect.annotateCurrentSpan("query.metric", request.query.metric)
		}
		if ("filters" in request.query && request.query.filters) {
			const filters = request.query.filters as Record<string, unknown>
			if (filters.serviceName)
				yield* Effect.annotateCurrentSpan("query.filter.serviceName", String(filters.serviceName))
			if (filters.spanName)
				yield* Effect.annotateCurrentSpan("query.filter.spanName", String(filters.spanName))
			if (filters.metricName)
				yield* Effect.annotateCurrentSpan("query.filter.metricName", String(filters.metricName))
		}

		const range = yield* validateExecute(request)
		const bucketSeconds =
			request.query.kind === "timeseries"
				? (request.query.bucketSeconds ?? computeBucketSeconds(range.startMs, range.endMs))
				: undefined
		if (bucketSeconds) yield* Effect.annotateCurrentSpan("query.bucketSeconds", bucketSeconds)

		const fillOptions = bucketSeconds
			? {
					startMs: range.startMs,
					endMs: range.endMs,
					bucketSeconds,
				}
			: undefined

		if (request.query.source === "traces" && request.query.kind === "timeseries") {
			const tracesQuery = request.query
			const opts = extractTracesOpts(request.query.filters as Record<string, unknown>)

			if (tracesQuery.allMetrics) {
				const rows = yield* executeCHQuery(
					warehouse,
					tenant,
					(capabilities) =>
						CH.tracesTimeseriesQuery({
							...opts,
							attributeIndexMode: attributeIndexMode(capabilities, "traces"),
							metric: tracesQuery.metric,
							allMetrics: true,
							needsSampling: true,
							groupBy: tracesQuery.groupBy as string[] | undefined,
							apdexThresholdMs:
								tracesQuery.metric === "apdex" ? tracesQuery.apdexThresholdMs : undefined,
							bucketSeconds: bucketSeconds!,
							seriesLimit: tracesQuery.seriesLimit,
						}),
					{
						orgId: tenant.orgId,
						startTime: request.startTime,
						endTime: request.endTime,
						bucketSeconds: bucketSeconds!,
					},
					"tracesAllMetricsTimeseries",
				)

				return new QueryEngineExecuteResponse({
					result: {
						kind: "timeseries",
						source: "traces",
						data: groupAllMetricsTimeSeriesRows(rows, fillOptions),
					},
				})
			}

			const rows = yield* executeCHQuery(
				warehouse,
				tenant,
				(capabilities) =>
					CH.tracesTimeseriesQuery({
						...opts,
						attributeIndexMode: attributeIndexMode(capabilities, "traces"),
						metric: tracesQuery.metric,
						needsSampling: false,
						groupBy: tracesQuery.groupBy as string[] | undefined,
						apdexThresholdMs:
							tracesQuery.metric === "apdex" ? tracesQuery.apdexThresholdMs : undefined,
						bucketSeconds: bucketSeconds!,
						seriesLimit: tracesQuery.seriesLimit,
					}),
				{
					orgId: tenant.orgId,
					startTime: request.startTime,
					endTime: request.endTime,
					bucketSeconds: bucketSeconds!,
				},
				"tracesTimeseries",
			)

			const field = tracesMetricFieldMap[tracesQuery.metric]
			return new QueryEngineExecuteResponse({
				result: {
					kind: "timeseries",
					source: "traces",
					data: groupTimeSeriesRows(rows, (row) => Number(row[field]), fillOptions),
				},
			})
		}

		if (request.query.source === "logs" && request.query.kind === "timeseries") {
			const logsQuery = request.query
			const opts = extractLogsOpts(request.query.filters as Record<string, unknown> | undefined)
			const rows = yield* executeCHQuery(
				warehouse,
				tenant,
				(capabilities) =>
					CH.logsTimeseriesQuery({
						...opts,
						attributeIndexMode: attributeIndexMode(capabilities, "logs"),
						bodySearchMode: logBodySearchMode(capabilities),
						groupBy: logsQuery.groupBy as string[] | undefined,
						bucketSeconds: bucketSeconds!,
						seriesLimit: logsQuery.seriesLimit,
					}),
				{
					orgId: tenant.orgId,
					startTime: request.startTime,
					endTime: request.endTime,
					bucketSeconds: bucketSeconds!,
				},
				"logsTimeseries",
			)

			return new QueryEngineExecuteResponse({
				result: {
					kind: "timeseries",
					source: "logs",
					data: groupTimeSeriesRows(rows, (row) => Number(row.count), fillOptions),
				},
			})
		}

		if (request.query.source === "metrics" && request.query.kind === "timeseries") {
			const execution = yield* executeMetricsTimeseriesRows(
				warehouse,
				tenant,
				request.query,
				{
					startTime: request.startTime,
					endTime: request.endTime,
					bucketSeconds: bucketSeconds!,
				},
				{ value: "metricsTimeseries", rate: "metricsRateIncrease" },
			)

			if (execution.kind === "rate") {
				const rateValueField = request.query.metric === "rate" ? "rateValue" : "increaseValue"
				const data = shapeMetricsGroupRows(
					execution.rows,
					(row) => Number(row[rateValueField]),
					request.query.groupBy,
					execution.groupByKey,
					fillOptions,
				)

				return new QueryEngineExecuteResponse({
					result: {
						kind: "timeseries",
						source: "metrics",
						data,
					},
				})
			}

			const metricValueField = {
				avg: "avgValue",
				sum: "sumValue",
				min: "minValue",
				max: "maxValue",
				count: "dataPointCount",
			} as const
			const valueField = metricValueField[request.query.metric as keyof typeof metricValueField]

			const data =
				request.query.groupBy?.includes("none") || !request.query.groupBy?.length
					? groupTimeSeriesRows(
							collapseMetricTimeseriesRows(
								execution.rows as ReadonlyArray<MetricTimeseriesRow>,
								request.query.metric,
							),
							(row) => row.value,
							fillOptions,
						)
					: shapeMetricsGroupRows(
							execution.rows,
							(row) => Number(row[valueField]),
							request.query.groupBy,
							execution.groupByKey,
							fillOptions,
						)

			return new QueryEngineExecuteResponse({
				result: {
					kind: "timeseries",
					source: "metrics",
					data,
				},
			})
		}

		if (request.query.source === "metrics" && request.query.kind === "sparklines") {
			const metricNames = [...new Set(request.query.metricNames)]
			if (metricNames.length > 50) {
				return yield* new QueryEngineValidationError({
					message: "Too many metrics in one sparklines request",
					details: ["metricNames must contain at most 50 names per request"],
				})
			}
			if (metricNames.length === 0) {
				return new QueryEngineExecuteResponse({
					result: { kind: "sparklines", source: "metrics", data: [] },
				})
			}

			const sparklineBucketSeconds =
				request.query.bucketSeconds ?? computeBucketSeconds(range.startMs, range.endMs)
			yield* Effect.annotateCurrentSpan("query.bucketSeconds", sparklineBucketSeconds)
			yield* Effect.annotateCurrentSpan("query.metricCount", metricNames.length)

			const rows = yield* executeCHQuery(
				warehouse,
				tenant,
				CH.metricsSparklinesQuery({
					metricType: request.query.metricType,
					metricNames,
				}),
				{
					orgId: tenant.orgId,
					startTime: request.startTime,
					endTime: request.endTime,
					bucketSeconds: sparklineBucketSeconds,
				},
				"metricsSparklines",
			)

			// Numbers are coerced here (not via a rowSchema) because BYO-ClickHouse
			// serializes 64-bit aggregates as JSON strings.
			const pointsByMetric = new Map<
				string,
				Array<{ bucket: string; avgValue: number; sumValue: number; dataPointCount: number }>
			>()
			for (const row of rows) {
				const points = pointsByMetric.get(row.metricName) ?? []
				if (points.length === 0) pointsByMetric.set(row.metricName, points)
				points.push({
					bucket: String(row.bucket),
					avgValue: Number(row.avgValue),
					sumValue: Number(row.sumValue),
					dataPointCount: Number(row.dataPointCount),
				})
			}

			return new QueryEngineExecuteResponse({
				result: {
					kind: "sparklines",
					source: "metrics",
					data: metricNames.map((metricName) => ({
						metricName,
						points: pointsByMetric.get(metricName) ?? [],
					})),
				},
			})
		}

		if (request.query.source === "traces" && request.query.kind === "breakdown") {
			const tracesQuery = request.query
			const opts = extractTracesOpts(request.query.filters as Record<string, unknown>)
			const rows = yield* executeCHQuery(
				warehouse,
				tenant,
				(capabilities) =>
					CH.tracesBreakdownQuery({
						...opts,
						attributeIndexMode: attributeIndexMode(capabilities, "traces"),
						metric: tracesQuery.metric,
						groupBy: tracesQuery.groupBy,
						groupByAttributeKey:
							tracesQuery.groupBy === "attribute" ? opts.groupByAttributeKeys?.[0] : undefined,
						limit: tracesQuery.limit,
						apdexThresholdMs:
							tracesQuery.metric === "apdex" ? tracesQuery.apdexThresholdMs : undefined,
					}),
				{ orgId: tenant.orgId, startTime: request.startTime, endTime: request.endTime },
				"tracesBreakdown",
			)

			const field = tracesMetricFieldMap[tracesQuery.metric]
			return new QueryEngineExecuteResponse({
				result: {
					kind: "breakdown",
					source: "traces",
					data: rows.map((row) => ({
						name: row.name,
						value: Number(row[field]),
					})),
				},
			})
		}

		if (request.query.source === "logs" && request.query.kind === "breakdown") {
			const logsQuery = request.query
			const opts = extractLogsOpts(request.query.filters as Record<string, unknown> | undefined)
			const rows = yield* executeCHQuery(
				warehouse,
				tenant,
				(capabilities) =>
					CH.logsBreakdownQuery({
						groupBy: logsQuery.groupBy as "service" | "severity",
						...opts,
						attributeIndexMode: attributeIndexMode(capabilities, "logs"),
						bodySearchMode: logBodySearchMode(capabilities),
						limit: logsQuery.limit,
					}),
				{ orgId: tenant.orgId, startTime: request.startTime, endTime: request.endTime },
				"logsBreakdown",
			)

			return new QueryEngineExecuteResponse({
				result: {
					kind: "breakdown",
					source: "logs",
					data: rows.map((row) => ({
						name: row.name,
						value: Number(row.count),
					})),
				},
			})
		}

		if (request.query.source === "metrics" && request.query.kind === "breakdown") {
			const rows = yield* executeCHQuery(
				warehouse,
				tenant,
				CH.metricsBreakdownQuery({
					metricType: request.query.filters.metricType,
					...(request.query.groupBy === "attribute" &&
						request.query.filters.groupByAttributeKey && {
							groupByAttributeKey: request.query.filters.groupByAttributeKey,
						}),
					...(request.query.groupBy === "resource_attribute" &&
						request.query.filters.groupByResourceAttributeKey && {
							groupByResourceAttributeKey: request.query.filters.groupByResourceAttributeKey,
						}),
					resourceAttributeFilters: request.query.filters.resourceAttributeFilters,
					limit: request.query.limit,
				}),
				{
					orgId: tenant.orgId,
					metricName: request.query.filters.metricName,
					startTime: request.startTime,
					endTime: request.endTime,
				},
				"metricsBreakdown",
			)

			const valueFieldMap = {
				avg: "avgValue",
				sum: "sumValue",
				count: "count",
			} as const
			const valueField = valueFieldMap[request.query.metric]

			return new QueryEngineExecuteResponse({
				result: {
					kind: "breakdown",
					source: "metrics",
					data: rows.map((row) => ({
						name: row.name,
						value: Number(row[valueField]),
					})),
				},
			})
		}

		if (request.query.source === "traces" && request.query.kind === "list") {
			const tracesQuery = request.query
			const opts = extractTracesOpts(request.query.filters as Record<string, unknown>)

			// Graceful limit clamping: cap at 200, auto-reduce to 50 when no indexed filters
			const hasIndexedFilter = !!(
				opts.serviceName ||
				opts.spanName ||
				opts.serviceNames?.length ||
				opts.spanNames?.length ||
				opts.errorsOnly ||
				opts.rootOnly
			)
			const maxLimit = hasIndexedFilter ? 200 : 50
			const clampedLimit = Math.min(tracesQuery.limit ?? 25, maxLimit)

			const rows = yield* executeCHQuery(
				warehouse,
				tenant,
				(capabilities) =>
					CH.tracesListQuery({
						...opts,
						attributeIndexMode: attributeIndexMode(capabilities, "traces"),
						limit: clampedLimit,
						offset: tracesQuery.offset,
						cursor: tracesQuery.cursor,
						columns: (tracesQuery as { columns?: readonly string[] }).columns as
							| string[]
							| undefined,
					}),
				{ orgId: tenant.orgId, startTime: request.startTime, endTime: request.endTime },
				"tracesList",
				"list",
			)

			return new QueryEngineExecuteResponse({
				result: {
					kind: "list",
					source: "traces",
					data: rows.map((row) => ({
						traceId: row.traceId,
						timestamp: String(row.timestamp),
						spanId: row.spanId,
						serviceName: row.serviceName,
						spanName: row.spanName,
						durationMs: Number(row.durationMs),
						statusCode: row.statusCode,
						spanKind: row.spanKind,
						hasError: Number(row.hasError) === 1,
						spanAttributes: row.spanAttributes ?? {},
						resourceAttributes: row.resourceAttributes ?? {},
					})),
				},
			})
		}

		if (request.query.kind === "attributeKeys") {
			const scope = resolveAttributeScope(request.query.source, request.query.scope)
			// Per-metric scoping reads the raw metric table (the hourly rollup has no
			// MetricName column). Requires both metricName and metricType; otherwise
			// fall back to the org-wide rollup.
			const metricScoped =
				request.query.source === "metrics" && request.query.metricName && request.query.metricType
					? { metricName: request.query.metricName, metricType: request.query.metricType }
					: undefined
			const rows = yield* executeCHQuery(
				warehouse,
				tenant,
				metricScoped
					? CH.metricScopedAttributeKeysQuery({
							metricType: metricScoped.metricType,
							limit: request.query.limit,
						})
					: CH.attributeKeysQuery({
							scope,
							limit: request.query.limit,
						}),
				{
					orgId: tenant.orgId,
					startTime: request.startTime,
					endTime: request.endTime,
					...(metricScoped ? { metricName: metricScoped.metricName } : {}),
				},
				metricScoped ? "attributeKeys:metric" : "attributeKeys",
				"discovery",
			)

			return new QueryEngineExecuteResponse({
				result: {
					kind: "attributeKeys",
					source: request.query.source,
					data: rows.map((row) => ({
						key: row.attributeKey,
						count: Number(row.usageCount),
					})),
				},
			})
		}

		// ---- Facets ----
		if (request.query.kind === "facets") {
			const baseParams = { orgId: tenant.orgId, startTime: request.startTime, endTime: request.endTime }

			if (request.query.source === "traces") {
				const opts = extractTracesFacetsOpts(
					request.query.filters as Record<string, unknown> | undefined,
				)
				const facet = request.query.facet
				const rows = yield* executeCHUnionQuery(
					warehouse,
					tenant,
					CH.tracesFacetsQuery({ ...opts, facet }),
					baseParams,
					facet ? `tracesFacets:${facet}` : "tracesFacets",
					"discovery",
				)
				return new QueryEngineExecuteResponse({
					result: {
						kind: "facets",
						source: "traces",
						data: rows.map((row) => ({
							facetType: row.facetType,
							name: row.name,
							count: Number(row.count),
						})),
					},
				})
			}

			if (request.query.source === "logs") {
				const filters = request.query.filters as Record<string, unknown> | undefined
				const facet = request.query.facet
				const rows = yield* executeCHUnionQuery(
					warehouse,
					tenant,
					CH.logsFacetsQuery(
						{
							serviceName: filters?.serviceName as string | undefined,
							severity: filters?.severity as string | undefined,
							environments: filters?.environments as readonly string[] | undefined,
							namespaces: filters?.namespaces as readonly string[] | undefined,
							matchModes: logsMatchModes(filters),
						},
						facet,
					),
					baseParams,
					facet ? `logsFacets:${facet}` : "logsFacets",
					"discovery",
				)
				return new QueryEngineExecuteResponse({
					result: {
						kind: "facets",
						source: "logs",
						data: rows.map((row) => ({
							facetType: row.facetType,
							name:
								row.facetType === "severity"
									? row.severityText
									: row.facetType === "deploymentEnv"
										? row.deploymentEnv
										: row.facetType === "namespace"
											? row.namespace
											: row.serviceName,
							count: Number(row.count),
						})),
					},
				})
			}

			if (request.query.source === "errors") {
				const filters = request.query.filters as Record<string, unknown> | undefined
				const rows = yield* executeCHUnionQuery(
					warehouse,
					tenant,
					CH.errorsFacetsQuery({
						rootOnly: filters?.rootOnly as boolean | undefined,
						services: filters?.services as string[] | undefined,
						deploymentEnvs: filters?.deploymentEnvs as string[] | undefined,
						fingerprintHashes: filters?.fingerprintHashes as string[] | undefined,
					}),
					baseParams,
					"errorsFacets",
					// "list" (1.5 GB), not "discovery" (512 MB): the error-type facet groups
					// error_events by a variable-length ErrorLabel key, which tips just over
					// the discovery cap (~490 MiB observed in production).
					"list",
				)
				return new QueryEngineExecuteResponse({
					result: {
						kind: "facets",
						source: "errors",
						data: rows.map((row) => ({
							facetType: row.facetType,
							name: row.name,
							count: Number(row.count),
						})),
					},
				})
			}

			if (request.query.source === "services") {
				const rows = yield* executeCHUnionQuery(
					warehouse,
					tenant,
					CH.servicesFacetsQuery(),
					baseParams,
					"servicesFacets",
					"discovery",
				)
				return new QueryEngineExecuteResponse({
					result: {
						kind: "facets",
						source: "services",
						data: rows.map((row) => ({
							facetType: row.facetType,
							name: row.name,
							count: Number(row.count),
						})),
					},
				})
			}
		}

		// ---- Stats ----
		if (request.query.source === "traces" && request.query.kind === "stats") {
			const opts = extractTracesDurationStatsOpts(
				request.query.filters as Record<string, unknown> | undefined,
			)
			const rows = yield* executeCHQuery(
				warehouse,
				tenant,
				CH.tracesDurationStatsQuery(opts),
				{ orgId: tenant.orgId, startTime: request.startTime, endTime: request.endTime },
				"tracesDurationStats",
			)
			const row = rows[0]
			return new QueryEngineExecuteResponse({
				result: {
					kind: "stats",
					source: "traces",
					data: row
						? {
								minDurationMs: Number(row.minDurationMs),
								maxDurationMs: Number(row.maxDurationMs),
								p50DurationMs: Number(row.p50DurationMs),
								p95DurationMs: Number(row.p95DurationMs),
							}
						: { minDurationMs: 0, maxDurationMs: 0, p50DurationMs: 0, p95DurationMs: 0 },
				},
			})
		}

		// ---- Attribute Values ----
		if (request.query.kind === "attributeValues") {
			// Per-metric scoping reads the raw metric table (see attributeKeys above).
			const metricScoped =
				request.query.source === "metrics" && request.query.metricName && request.query.metricType
					? { metricName: request.query.metricName, metricType: request.query.metricType }
					: undefined
			const queryFn = Match.value(request.query.scope).pipe(
				Match.when("resource", () => CH.resourceAttributeValuesQuery),
				Match.when("log", () => CH.logAttributeValuesQuery),
				Match.when("metric", () => CH.metricAttributeValuesQuery),
				Match.orElse(() => CH.spanAttributeValuesQuery),
			)
			const rows = yield* executeCHQuery(
				warehouse,
				tenant,
				metricScoped
					? CH.metricScopedAttributeValuesQuery({
							metricType: metricScoped.metricType,
							attributeKey: request.query.attributeKey,
							limit: request.query.limit,
						})
					: queryFn({ attributeKey: request.query.attributeKey, limit: request.query.limit }),
				{
					orgId: tenant.orgId,
					startTime: request.startTime,
					endTime: request.endTime,
					...(metricScoped ? { metricName: metricScoped.metricName } : {}),
				},
				metricScoped ? "attributeValues:metric-scoped" : `attributeValues:${request.query.scope}`,
				"discovery",
			)
			return new QueryEngineExecuteResponse({
				result: {
					kind: "attributeValues",
					source: request.query.source,
					data: rows.map((row) => ({ value: row.attributeValue, count: Number(row.usageCount) })),
				},
			})
		}

		// ---- Count ----
		if (request.query.source === "logs" && request.query.kind === "count") {
			const filters = request.query.filters as Record<string, unknown> | undefined
			const opts = extractLogsOpts(filters)
			const rows = yield* executeCHQuery(
				warehouse,
				tenant,
				(capabilities) =>
					CH.logsCountQuery({
						...opts,
						attributeIndexMode: attributeIndexMode(capabilities, "logs"),
						bodySearchMode: logBodySearchMode(capabilities),
					}),
				{ orgId: tenant.orgId, startTime: request.startTime, endTime: request.endTime },
				"logsCount",
				"discovery",
				// Body search reads the wide Body column for the ILIKE filter —
				// cap the read block size (see WarehouseQuerySettings.maxBlockSize).
				filters?.search ? LOGS_BODY_SEARCH_SETTINGS : undefined,
			)
			return new QueryEngineExecuteResponse({
				result: {
					kind: "count",
					source: "logs",
					data: { total: rows[0] ? Number(rows[0].total) : 0 },
				},
			})
		}

		return yield* new QueryEngineValidationError({
			message: "Unsupported query",
			details: ["This source/kind combination is not supported"],
		})
	})

/**
 * Reduce per-bucket observations into a single GroupedAlertObservation per
 * group. Used by the unified alert `evaluate` path which executes the same
 * dashboard timeseries queries that widgets use, then collapses each group's
 * bucket series with the configured reducer.
 */
export const reducePerGroupObservations = (
	byGroup: Map<string, Array<{ value: number | null; sampleCount: number; hasData: boolean }>>,
	reducer: QueryEngineAlertReducer,
): ReadonlyArray<GroupedAlertObservation> => {
	const result: Array<GroupedAlertObservation> = []
	for (const [groupKey, observations] of byGroup.entries()) {
		const reducedValue = applyAlertReducer(observations, reducer)
		const totalSampleCount = observations.reduce((sum, o) => sum + Number(o.sampleCount), 0)
		const hasData = observations.some((o) => o.hasData)
		result.push({
			groupKey,
			value: reducedValue,
			sampleCount: totalSampleCount,
			hasData,
		})
	}
	return result
}

/** Compose a JS-side composite group key for metrics, which doesn't emit groupName from SQL. */
const composeMetricsGroupKey = (
	groupBy: ReadonlyArray<string> | undefined,
	serviceName: string,
	attributeValue: string,
): string => {
	if (!groupBy || groupBy.length === 0 || groupBy.includes("none")) return "all"
	const parts: string[] = []
	for (const dim of groupBy) {
		if (dim === "service") parts.push(serviceName || "")
		// Both attribute dimensions surface through the query's single
		// attributeValue column (only one can be active per query).
		else if (dim === "attribute" || dim === "resource_attribute") parts.push(attributeValue || "")
	}
	const filtered = parts.filter((p) => p.length > 0)
	if (filtered.length === 0) return "all"
	return filtered.join(" \u00b7 ")
}

/**
 * Column convention for a raw-SQL alert query: a numeric `value`, plus optional
 * `group` (splits results into per-group observations, default `"all"`),
 * `samples` (the sample count, else 1 per row) and `bucket` (a timestamp from
 * `$__timeGroup(col)`; absent means the whole window is one bucket).
 */
const RawSqlAlertRowSchema = Schema.Struct({
	value: Schema.Unknown,
	group: Schema.optional(Schema.Unknown),
	samples: Schema.optional(Schema.Unknown),
	bucket: Schema.optional(Schema.Unknown),
})

/**
 * Where the observations for one alert evaluation come from. Every alert rule
 * kind — the trace built-ins, the query builder, and user-authored SQL —
 * compiles down to one of these two, so there is exactly one lowering to
 * maintain (see {@link computeAlertBuckets}).
 */
export type AlertBucketSource =
	| { readonly kind: "spec"; readonly query: QuerySpec }
	| { readonly kind: "raw_sql"; readonly sql: string; readonly windowMinutes: number }

/** Structural request slice that {@link computeAlertBuckets} needs for one range. */
export interface AlertBucketRequest {
	readonly source: AlertBucketSource
	readonly startTime: string
	readonly endTime: string
}

/**
 * THE single alert lowering: run one alert source over one time range and emit
 * per-(bucket, group) observations.
 *
 * Everything downstream is a thin derivation of this — `evaluate` reduces the
 * buckets to a scalar per group (`reduceAlertBuckets`), `evaluateSeries` returns
 * them as-is for the preview chart, and the bucket cache stores them encoded via
 * `encodeEvalPoints` and re-fetches only the missing ranges. Because a cached
 * evaluation decodes back into the very same observations an uncached one
 * builds, the two agree for real timeseries data (where each (bucket, group) row
 * is unique).
 *
 * Assumes a spec source is already validated as a supported timeseries query.
 */
export const computeAlertBuckets = Effect.fnUntraced(function* <T extends QueryTenant>(
	warehouse: QueryEngineWarehouse<T>,
	tenant: T,
	request: AlertBucketRequest,
	bucketSeconds: number,
) {
	if (request.source.kind === "raw_sql") {
		return yield* computeRawSqlBuckets(warehouse, tenant, request.source, request)
	}

	const obs: BucketGroupObs[] = []
	const query = request.source.query

	// Caller guarantees a supported timeseries query; this guard also narrows the
	// QuerySpec union (discriminated on both `kind` and `source`) so the per-source
	// branches can read `filters`/`metric`/`groupBy`.
	if (query.kind !== "timeseries") {
		return obs as ReadonlyArray<BucketGroupObs>
	}

	if (query.source === "traces") {
		const opts = extractTracesOpts(query.filters as Record<string, unknown>)
		const rows = yield* executeCHQuery(
			warehouse,
			tenant,
			(capabilities) =>
				CH.tracesTimeseriesQuery({
					...opts,
					attributeIndexMode: attributeIndexMode(capabilities, "traces"),
					metric: query.metric,
					needsSampling: false,
					groupBy: query.groupBy as readonly string[] | undefined,
					apdexThresholdMs: query.metric === "apdex" ? query.apdexThresholdMs : undefined,
					bucketSeconds,
				}),
			{
				orgId: tenant.orgId,
				startTime: request.startTime,
				endTime: request.endTime,
				bucketSeconds,
			},
			"tracesAlertEval",
		)
		for (const row of rows) {
			// `count` is a sample-weighted estimate; `minimumSampleCount` is a
			// confidence guard and must see rows actually observed. They differ only
			// under sampling, and only the hourly rollup (which stores no raw count)
			// falls back to the estimate.
			const sampleCount = Number(row.spanCount ?? row.count ?? 0)
			const value = sampleCount > 0 ? tracesAggregateValueForMetric(query.metric, row) : null
			obs.push({
				bucket: normalizeBucket(row.bucket),
				groupKey: row.groupName || "all",
				value,
				sampleCount,
			})
		}
	} else if (query.source === "logs") {
		const opts = extractLogsOpts(query.filters as Record<string, unknown> | undefined)
		const rows = yield* executeCHQuery(
			warehouse,
			tenant,
			(capabilities) =>
				CH.logsTimeseriesQuery({
					...opts,
					attributeIndexMode: attributeIndexMode(capabilities, "logs"),
					bodySearchMode: logBodySearchMode(capabilities),
					groupBy: query.groupBy as readonly string[] | undefined,
					bucketSeconds,
				}),
			{
				orgId: tenant.orgId,
				startTime: request.startTime,
				endTime: request.endTime,
				bucketSeconds,
			},
			"logsAlertEval",
		)
		for (const row of rows) {
			const sampleCount = Number(row.count ?? 0)
			obs.push({
				bucket: normalizeBucket(row.bucket),
				groupKey: row.groupName || "all",
				value: sampleCount > 0 ? sampleCount : null,
				sampleCount,
			})
		}
	} else {
		const execution = yield* executeMetricsTimeseriesRows(
			warehouse,
			tenant,
			query,
			{ startTime: request.startTime, endTime: request.endTime, bucketSeconds },
			{ value: "metricsAlertEval", rate: "metricsRateIncreaseAlertEval" },
		)
		for (const row of execution.rows) {
			const sampleCount = Number(row.dataPointCount ?? 0)
			const value = sampleCount > 0 ? metricsAggregateValueForMetric(query.metric, row) : null
			const groupKey = composeMetricsGroupKey(
				query.groupBy as readonly string[] | undefined,
				row.serviceName ?? "",
				row.attributeValue ?? "",
			)
			obs.push({
				bucket: normalizeBucket(row.bucket),
				groupKey,
				value,
				sampleCount,
			})
		}
	}

	return obs as ReadonlyArray<BucketGroupObs>
})

/**
 * The `raw_sql` arm of {@link computeAlertBuckets}, split out only because it
 * needs its own `makeExecuteRawSql` closure.
 *
 * `bucket` is optional: a query using `$__timeGroup(col)` returns one row per
 * bucket and previews as a real series, while one that doesn't returns a single
 * window aggregate and lands in one synthetic bucket. Reduction collapses across
 * buckets either way, so the scheduler sees the same scalar for both.
 *
 * `sampleCount` is forced to 0 whenever `value` is null so that
 * `hasData === sampleCount > 0` holds for raw rows exactly as it does for the
 * spec sources — the bucket codec derives `hasData` from the sample count alone,
 * so a `{value: null, samples: 1}` row would otherwise decode as "has data but
 * no scalar" rather than the no-data case the alert engine expects.
 */
const computeRawSqlBuckets = Effect.fnUntraced(function* <T extends QueryTenant>(
	warehouse: QueryEngineWarehouse<T>,
	tenant: T,
	source: Extract<AlertBucketSource, { kind: "raw_sql" }>,
	range: { readonly startTime: string; readonly endTime: string },
) {
	const executeRawSql = makeExecuteRawSql<T, WarehouseError | RawSqlValidationError>(warehouse)
	const granularitySeconds = Math.max(source.windowMinutes * 60, 60)

	const { rows: rawRows } = yield* executeRawSql(tenant, {
		sql: source.sql,
		orgId: tenant.orgId,
		startTime: range.startTime,
		endTime: range.endTime,
		granularitySeconds,
		workload: "alert",
		context: "alertRawQuery",
	}).pipe(
		Effect.catchTag("@maple/http/errors/RawSqlValidationError", (error) =>
			Effect.fail(
				new QueryEngineValidationError({
					message: "Invalid raw SQL alert query",
					details: [error.message],
				}),
			),
		),
	)

	const rows = yield* Schema.decodeUnknownEffect(Schema.Array(RawSqlAlertRowSchema))(rawRows).pipe(
		Effect.mapError(
			() =>
				new QueryEngineValidationError({
					message: "Invalid raw SQL alert query",
					details: ["Raw SQL alert queries must return a column named value."],
				}),
		),
	)

	const obs: BucketGroupObs[] = []
	const seenGroups = new Set<string>()
	for (const row of rows) {
		const rawGroup = row.group
		const groupKey = typeof rawGroup === "string" && rawGroup.length > 0 ? rawGroup : "all"
		if (groupKey.length > MAX_RAW_SQL_GROUP_KEY_LENGTH) {
			return yield* new QueryEngineValidationError({
				message: "Invalid raw SQL alert query",
				details: [
					`Raw SQL alert group keys may contain at most ${MAX_RAW_SQL_GROUP_KEY_LENGTH} characters.`,
				],
			})
		}
		// `encodeEvalPoints` prefixes group keys with NUL-delimited markers and relies
		// on real keys never containing NUL. That holds for CH-derived keys but not
		// for arbitrary user SQL, so reject rather than let a crafted key collide
		// with the codec's value/count namespaces.
		if (groupKey.includes("\u0000")) {
			return yield* new QueryEngineValidationError({
				message: "Invalid raw SQL alert query",
				details: ["Raw SQL alert group keys may not contain NUL characters."],
			})
		}
		const numValue = row.value == null ? null : Number(row.value)
		const value = numValue != null && Number.isFinite(numValue) ? numValue : null
		const rawSamples = row.samples == null ? 1 : Number(row.samples)
		if (!Number.isFinite(rawSamples) || rawSamples < 0) {
			return yield* new QueryEngineValidationError({
				message: "Invalid raw SQL alert query",
				details: ["Raw SQL alert samples must be finite and nonnegative."],
			})
		}
		if (!seenGroups.has(groupKey)) {
			if (seenGroups.size >= MAX_RAW_SQL_ALERT_GROUPS) {
				return yield* new QueryEngineValidationError({
					message: "Invalid raw SQL alert query",
					details: [`Raw SQL alerts may return at most ${MAX_RAW_SQL_ALERT_GROUPS} groups.`],
				})
			}
			seenGroups.add(groupKey)
		}
		obs.push({
			// A query without `$__timeGroup` has no bucket column: the whole window
			// collapses into one synthetic bucket at its start. Normalize either way
			// — `range.startTime` is a Tinybird datetime, and consumers key buckets
			// by `Date.parse`, which would read that space-separated form as local
			// time rather than UTC.
			bucket: normalizeBucket(
				typeof row.bucket === "string" || row.bucket instanceof Date ? row.bucket : range.startTime,
			),
			groupKey,
			value,
			sampleCount: value == null ? 0 : rawSamples,
		})
	}

	return obs as ReadonlyArray<BucketGroupObs>
})

/**
 * The single reduce tail: collapse per-(bucket, group) observations into one
 * `GroupedAlertObservation` per group. An empty result still yields a single
 * ungrouped no-data observation so the alert engine can apply its configured
 * no-data behavior.
 */
export const reduceAlertBuckets = (
	obs: ReadonlyArray<BucketGroupObs>,
	reducer: QueryEngineAlertReducer,
): ReadonlyArray<GroupedAlertObservation> => {
	const byGroup = new Map<string, Array<{ value: number | null; sampleCount: number; hasData: boolean }>>()
	for (const o of obs) {
		const entry = { value: o.value, sampleCount: o.sampleCount, hasData: o.sampleCount > 0 }
		const list = byGroup.get(o.groupKey)
		if (list) list.push(entry)
		else byGroup.set(o.groupKey, [entry])
	}
	if (byGroup.size === 0) {
		byGroup.set("all", [{ value: null, sampleCount: 0, hasData: false }])
	}
	return reducePerGroupObservations(byGroup, reducer)
}

/**
 * Annotate, validate and resolve the bucket size for one alert evaluation.
 * Shared by `evaluate` and `evaluateSeries` so the two can never drift on which
 * queries they accept or how they bucket them.
 */
const prepareAlertEvaluation = Effect.fnUntraced(function* (request: AlertEvaluateRequest) {
	yield* Effect.annotateCurrentSpan("query.sourceKind", request.source.kind)
	yield* Effect.annotateCurrentSpan("query.reducer", request.reducer)

	if (request.source.kind === "spec") {
		const query = request.source.query
		yield* Effect.annotateCurrentSpan("query.source", query.source)
		yield* Effect.annotateCurrentSpan("query.kind", query.kind)
		if ("metric" in query && query.metric) {
			yield* Effect.annotateCurrentSpan("query.metric", query.metric)
		}
		if ("groupBy" in query && query.groupBy) {
			yield* Effect.annotateCurrentSpan(
				"query.groupBy",
				(query.groupBy as ReadonlyArray<string>).join(","),
			)
		}
	}

	yield* validateEvaluate(request)

	const startMs = toEpochMs(request.startTime)
	const endMs = toEpochMs(request.endTime)

	if (request.source.kind === "raw_sql") {
		// One evaluation window is one bucket; a query using `$__timeGroup` lines
		// its rows up on exactly that grid.
		return Math.max(request.source.windowMinutes * 60, 60)
	}

	const query = request.source.query
	if (
		query.kind !== "timeseries" ||
		(query.source !== "traces" && query.source !== "metrics" && query.source !== "logs")
	) {
		return yield* new QueryEngineValidationError({
			message: "Unsupported alert evaluation query",
			details: ["Alert evaluation supports traces, logs, and metrics timeseries queries only"],
		})
	}

	// Use the spec's bucketSeconds when present, otherwise auto-compute from the
	// time range. Pinned to the historical 30-point target: the chart default is
	// denser, but finer buckets would change per-bucket observation values (and
	// `minimumSampleCount` behavior) for every rule that relies on auto sizing.
	return query.bucketSeconds ?? computeBucketSeconds(startMs, endMs, { targetPoints: 30 })
})

export const makeQueryEngineEvaluate = <T extends QueryTenant>(warehouse: QueryEngineWarehouse<T>) =>
	Effect.fn("QueryEngineService.evaluate")(function* (
		tenant: T,
		request: AlertEvaluateRequest,
	): Effect.fn.Return<
		ReadonlyArray<GroupedAlertObservation>,
		QueryEngineValidationError | QueryEngineExecutionError | WarehouseError
	> {
		yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)
		const bucketSeconds = yield* prepareAlertEvaluation(request)

		const obs = yield* computeAlertBuckets(
			warehouse,
			tenant,
			{ source: request.source, startTime: request.startTime, endTime: request.endTime },
			bucketSeconds,
		)

		const result = reduceAlertBuckets(obs, request.reducer)
		yield* Effect.annotateCurrentSpan("result.groupCount", result.length)
		return result
	})

/**
 * Like `makeQueryEngineEvaluate`, but returns the per-(bucket, group)
 * observations instead of reducing each group to a scalar. Backs the alert
 * rule preview chart: each bucket is one evaluation window, so the series is
 * exactly the sequence of observations the scheduler would have produced.
 *
 * Deliberately NOT routed through the bucket cache — preview requests are
 * ad-hoc form states and would only pollute it (see the eval-bucket-cache
 * regression note in QueryEngineService).
 */
export const makeQueryEngineEvaluateSeries = <T extends QueryTenant>(warehouse: QueryEngineWarehouse<T>) =>
	Effect.fn("QueryEngineService.evaluateSeries")(function* (
		tenant: T,
		request: AlertEvaluateRequest,
	): Effect.fn.Return<
		ReadonlyArray<BucketGroupObs>,
		QueryEngineValidationError | QueryEngineExecutionError | WarehouseError
	> {
		yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)
		const bucketSeconds = yield* prepareAlertEvaluation(request)

		const series = yield* computeAlertBuckets(
			warehouse,
			tenant,
			{ source: request.source, startTime: request.startTime, endTime: request.endTime },
			bucketSeconds,
		)
		yield* Effect.annotateCurrentSpan("result.pointCount", series.length)
		return series
	})
