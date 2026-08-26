import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	CurrentTenant,
	MetricName,
	QueryEngineResultMismatchError,
	ServiceName,
	SpanId,
	TraceId,
} from "@maple/domain/http"
import {
	MapleApiV2,
	paginateOffsetQuery,
	timestamp,
	V2CursorInvalid,
	V2LogIdInvalid,
	V2LogNotFound,
	V2LogQueryInvalid,
	V2MetricQueryInvalid,
	V2ServiceNotFound,
	V2SpanNotFound,
	V2TelemetryBreakdownFilterRequired,
	V2TelemetryBucketCountTooLarge,
	V2TelemetryRangeTooLarge,
	V2TimeRangeInvalid,
	V2TraceNotFound,
	V2TraceQueryInvalid,
	type Timestamp,
	type V2Log,
	type V2LogFilters,
	type V2Metric,
	type V2MetricFilters,
	type V2Service,
	type V2ServiceMapEdge,
	type V2Span,
	type V2TraceFilters,
	type V2TraceSummary,
} from "@maple/domain/http/v2"
import {
	CH,
	QueryEngineExecuteRequest,
	formatWarehouseDateTime,
	formatWarehouseDateTimeMs,
	WarehouseDateTime,
} from "@maple/query-engine"
import { LOGS_BODY_SEARCH_SETTINGS } from "@maple/query-engine/profiles"
import {
	computeBucketSeconds,
	formatRangeSeconds,
	MAX_BREAKDOWN_RANGE_SECONDS,
	MAX_LIST_RANGE_SECONDS,
	MAX_QUERY_RANGE_SECONDS,
	MAX_TIMESERIES_POINTS as MAX_TIMESERIES_BUCKETS,
	MAX_UNFILTERED_BREAKDOWN_RANGE_SECONDS,
} from "@maple/query-engine/runtime"
import { Effect, Encoding, Option, Result, Schema } from "effect"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { QueryEngineService } from "@/services/warehouse/QueryEngineService"

const decodeTraceId = Schema.decodeSync(TraceId)
const decodeSpanId = Schema.decodeSync(SpanId)
const decodeServiceName = Schema.decodeSync(ServiceName)
const decodeMetricName = Schema.decodeSync(MetricName)

const metricCatalogRowSchema = Schema.Struct({
	metricName: Schema.String,
	metricType: Schema.String,
	serviceName: Schema.String,
	metricDescription: Schema.String,
	metricUnit: Schema.String,
	dataPointCount: CH.CHNumber,
	firstSeen: Schema.String,
	lastSeen: Schema.String,
	// `metric_catalog.IsMonotonic` is `SimpleAggregateFunction(anyLast, UInt8)` —
	// always 0/1 on the wire, never a JSON boolean. `CHNumber` covers both the
	// numeric and the quoted-string encoding.
	isMonotonic: CH.CHNumber,
})

export const serviceCatalogRowSchema = Schema.Struct({
	serviceName: Schema.String,
	serviceNamespaces: Schema.Array(Schema.String),
	deploymentEnvironments: Schema.Array(Schema.String),
	spanCount: CH.CHNumber,
	errorCount: CH.CHNumber,
	estimatedErrorCount: CH.CHNumber,
	estimatedSpanCount: CH.CHNumber,
	p50LatencyMs: CH.CHNumber,
	p95LatencyMs: CH.CHNumber,
	p99LatencyMs: CH.CHNumber,
})

const serviceHealthBaselineRowSchema = Schema.Struct({
	serviceName: Schema.String,
	serviceNamespace: Schema.String,
	environment: Schema.String,
	baselineP95LatencyMs: CH.CHNumber,
	baselineSpanCount: CH.CHNumber,
})

const HOUR_MS = 60 * 60 * 1000
const PARTITION_HINT_RADIUS_MS = 60 * 60 * 1000
const PUBLIC_TIMESERIES_DEFAULT_SERIES_LIMIT = 50
const PUBLIC_BREAKDOWN_DEFAULT_LIMIT = 20
// Search endpoints return raw rows, so they carry the query engine's list cap.
const MAX_SEARCH_RANGE_SECONDS = MAX_LIST_RANGE_SECONDS
// Summary endpoints read the 365-day hourly rollups rather than raw tables, so
// they can span far wider than any query-engine kind — no shared equivalent.
const MAX_SUMMARY_RANGE_SECONDS = 60 * 60 * 24 * 365

/**
 * Window bound precision, which has to match the table being read.
 *
 * Raw signal tables (`traces`, `logs`) store `DateTime64`, so a fractional
 * literal is both valid and load-bearing — a log search can legitimately span
 * 200ms, and rounding to whole seconds would widen it.
 *
 * The summary rollups (`service_overview_spans`, the hourly tiers) store plain
 * `DateTime`. There, a fractional literal is a hard `TYPE_MISMATCH`, and the
 * splice's floor arithmetic used to reject it earlier still with
 * `Cannot parse string '…000' as DateTime`. Whole seconds cost nothing on a
 * window measured in hours.
 *
 * Required, deliberately: this used to default to `"millisecond"`, so a handler
 * reading a rollup only had to omit it to 500 on every call — which is how
 * `v2ListMetrics` shipped broken against `metric_catalog`. Stating the table's
 * precision is now the price of calling `parseWindow`.
 */
type WindowPrecision = "second" | "millisecond"

const parseWindow = (
	start: string,
	end: string,
	options: {
		readonly precision: WindowPrecision
		readonly maxSeconds?: number
		readonly rangeLabel?: string
	},
) =>
	Effect.gen(function* () {
		// Both bounds are `Timestamp`, whose schema already rejected anything
		// unparseable at the HTTP boundary — so `Date.parse` cannot be NaN here and
		// ordering is the only thing left to check. Testing all three together used
		// to report an unparseable `start_time` as "end_time must be later than
		// start_time", blaming the wrong parameter.
		const startMs = Date.parse(start)
		const endMs = Date.parse(end)
		if (endMs <= startMs) {
			return yield* Effect.fail(
				V2TimeRangeInvalid.make("end_time must be later than start_time.", {
					param: "end_time",
				}),
			)
		}
		const rangeSeconds = (endMs - startMs) / 1000
		const maxSeconds = options.maxSeconds ?? MAX_QUERY_RANGE_SECONDS
		if (rangeSeconds > maxSeconds) {
			return yield* Effect.fail(
				V2TelemetryRangeTooLarge.make(
					`${options.rangeLabel ?? "Telemetry queries"} support a maximum time range of ${formatRangeSeconds(maxSeconds)}.`,
					{ param: "start_time" },
				),
			)
		}
		const format = options.precision === "second" ? formatWarehouseDateTime : formatWarehouseDateTimeMs
		return {
			startTime: format(startMs),
			endTime: format(endMs),
			rangeSeconds,
		}
	})

const chToIso = (value: string): Timestamp => {
	const normalized = value.includes("T") ? value : value.replace(" ", "T")
	const zoned = /[zZ]|[+-]\d\d:?\d\d$/.test(normalized) ? normalized : `${normalized}Z`
	const ms = Date.parse(zoned)
	return timestamp(Number.isNaN(ms) ? value : new Date(ms).toISOString())
}

const partitionWindow = (value: string) => {
	const ms = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`)
	return {
		startTime: formatWarehouseDateTimeMs(ms - PARTITION_HINT_RADIUS_MS),
		endTime: formatWarehouseDateTimeMs(ms + PARTITION_HINT_RADIUS_MS),
	}
}

const parseStringRecord = (value: unknown): Record<string, string> => {
	if (typeof value !== "string") return {}
	try {
		const parsed = JSON.parse(value) as unknown
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
		return Object.fromEntries(
			Object.entries(parsed).map(([key, entry]) => [
				key,
				typeof entry === "string" ? entry : String(entry),
			]),
		)
	} catch {
		return {}
	}
}

type LogKey = readonly [timestamp: string, recordIdentity: string]
const compactTimestamp = (value: string) => {
	const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(value)
	if (match === null) return value
	const epochSeconds = Date.parse(`${match[1]}T${match[2]}Z`) / 1000
	return Number.isSafeInteger(epochSeconds) ? `~${epochSeconds.toString(36)}${match[3] ?? ""}` : value
}
const expandTimestamp = (value: string) => {
	const match = /^~([0-9a-z]+)(\.\d+)?$/.exec(value)
	if (match === null) return value
	const epochSeconds = Number.parseInt(match[1]!, 36)
	if (!Number.isSafeInteger(epochSeconds)) return value
	const seconds = formatWarehouseDateTime(epochSeconds * 1000)
	return `${seconds}${match[2] ?? ""}`
}
const compactHexId = (value: string) => {
	if (!/^(?:[0-9a-f]{16}|[0-9a-f]{32})$/i.test(value)) return value
	const bytes = Uint8Array.from({ length: value.length / 2 }, (_, index) =>
		Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
	)
	return `~${Encoding.encodeBase64Url(bytes)}`
}
const expandHexId = (value: string) => {
	if (!value.startsWith("~")) return value
	const decoded = Encoding.decodeBase64Url(value.slice(1))
	if (Result.isFailure(decoded)) throw new Error("invalid compact identifier")
	return [...decoded.success].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
const logKey = (row: { timestamp: string; recordIdentity: string }) =>
	JSON.stringify([compactTimestamp(row.timestamp), compactHexId(row.recordIdentity)] satisfies LogKey)

const parseLogKey = (value: string) => {
	try {
		const parsed = JSON.parse(value) as unknown
		if (
			!Array.isArray(parsed) ||
			parsed.length !== 2 ||
			parsed.some((part) => typeof part !== "string") ||
			Number.isNaN(Date.parse(expandTimestamp(parsed[0] as string).replace(" ", "T") + "Z")) ||
			!/^[0-9A-F]{32}$/i.test(expandHexId(parsed[1] as string))
		) {
			throw new Error("invalid")
		}
		return Effect.succeed([
			expandTimestamp(parsed[0] as string),
			expandHexId(parsed[1] as string).toUpperCase(),
		] as const)
	} catch {
		return Effect.fail(V2LogIdInvalid.make(undefined, { param: "id" }))
	}
}

const encodeKeysetCursor = (prefix: string, parts: ReadonlyArray<string>) =>
	`${prefix}_${Encoding.encodeBase64Url(JSON.stringify(parts))}`

/**
 * Decode a keyset cursor into its parts.
 *
 * Element 0 is always the timestamp the keyset walks back from, and it is
 * checked against `WarehouseDateTime` here rather than trusted. It reaches the
 * query builder as a `DateTime` comparison, which encodes it through the
 * column's codec while the query is still being *built* — before `CH.compile`,
 * so outside the Effect that would have turned the failure into a value. A
 * forged cursor was therefore a 500 rather than the 400 this function already
 * knows how to return.
 */
const decodeKeysetCursor = (value: string | undefined, prefix: string, length: number) => {
	const invalid = Effect.fail(V2CursorInvalid.make(undefined, { param: "cursor" }))
	if (value === undefined) return Effect.succeed<ReadonlyArray<string> | undefined>(undefined)
	if (!value.startsWith(`${prefix}_`)) return invalid
	const decoded = Encoding.decodeBase64UrlString(value.slice(prefix.length + 1))
	if (Result.isFailure(decoded)) return invalid
	const parsed = Result.try({
		try: () => JSON.parse(decoded.success) as unknown,
		catch: () => undefined,
	})
	if (Result.isFailure(parsed)) return invalid
	const parts = parsed.success
	if (
		!Array.isArray(parts) ||
		parts.length !== length ||
		!parts.every((part) => typeof part === "string")
	) {
		return invalid
	}
	if (Result.isFailure(Schema.decodeUnknownResult(WarehouseDateTime)(parts[0]))) return invalid
	return Effect.succeed(parts as ReadonlyArray<string>)
}

const toLog = (row: {
	timestamp: string
	severityText: string
	severityNumber: number
	serviceName: string
	body: string
	traceId: string
	spanId: string
	recordIdentity: string
	logAttributes: string
	resourceAttributes: string
}): V2Log => ({
	id: logKey(row),
	object: "log",
	timestamp: chToIso(row.timestamp),
	severity_text: row.severityText,
	severity_number: Number(row.severityNumber),
	service_name: decodeServiceName(row.serviceName),
	body: row.body,
	trace_id: row.traceId ? decodeTraceId(row.traceId) : null,
	span_id: row.spanId ? decodeSpanId(row.spanId) : null,
	log_attributes: parseStringRecord(row.logAttributes),
	resource_attributes: parseStringRecord(row.resourceAttributes),
})

const toTraceSummary = (row: {
	traceId: string
	startTime: string
	durationMs: number
	rootSpanName: string
	rootSpanKind: string
	rootServiceName: string
	statusCode: string
	hasError: number
	deploymentEnvironment: string
	serviceNamespace: string
	httpMethod: string
	httpRoute: string
	httpStatusCode: string
}): V2TraceSummary => ({
	id: decodeTraceId(row.traceId),
	object: "trace",
	start_time: chToIso(row.startTime),
	duration_ms: Number(row.durationMs),
	root_span_name: row.rootSpanName,
	root_span_kind: row.rootSpanKind,
	root_service_name: row.rootServiceName,
	root_status_code: row.statusCode,
	root_has_error: Number(row.hasError) !== 0,
	deployment_environment: row.deploymentEnvironment || null,
	service_namespace: row.serviceNamespace || null,
	http_method: row.httpMethod || null,
	http_route: row.httpRoute || null,
	http_status_code: row.httpStatusCode || null,
})

const toSpan = (row: {
	traceId: string
	spanId: string
	parentSpanId: string
	spanName: string
	serviceName: string
	spanKind: string
	durationMs: number
	startTime: string
	statusCode: string
	statusMessage: string
	spanAttributes: string
	resourceAttributes: string
}): V2Span => ({
	id: decodeSpanId(row.spanId),
	object: "span",
	trace_id: decodeTraceId(row.traceId),
	parent_span_id: row.parentSpanId ? decodeSpanId(row.parentSpanId) : null,
	name: row.spanName,
	service_name: row.serviceName,
	kind: row.spanKind,
	start_time: chToIso(row.startTime),
	duration_ms: Number(row.durationMs),
	status_code: row.statusCode,
	status_message: row.statusMessage || null,
	attributes: parseStringRecord(row.spanAttributes),
	resource_attributes: parseStringRecord(row.resourceAttributes),
})

const attributeFilters = (
	filters:
		| ReadonlyArray<{
				key: string
				value?: string | number
				operator: "equals" | "exists" | "gt" | "gte" | "lt" | "lte" | "contains"
				negated?: boolean
		  }>
		| undefined,
) =>
	filters?.map((filter) => ({
		key: filter.key,
		...(filter.value !== undefined ? { value: String(filter.value) } : undefined),
		mode: filter.operator,
		...(filter.negated !== undefined ? { negated: filter.negated } : undefined),
	}))

const traceFilters = (filters: V2TraceFilters | undefined, groupByAttributeKey?: string) => {
	if (!filters && !groupByAttributeKey) return undefined
	const httpFilters = [
		...(filters?.http_method
			? [{ key: "http.method", value: filters.http_method, mode: "equals" as const }]
			: []),
		...(filters?.http_route
			? [{ key: "http.route", value: filters.http_route, mode: "equals" as const }]
			: []),
		...(filters?.http_status_code
			? [{ key: "http.status_code", value: filters.http_status_code, mode: "equals" as const }]
			: []),
	]
	return {
		serviceName: filters?.service_name,
		spanName: filters?.span_name,
		statusCode: filters?.status_code,
		rootSpansOnly: filters?.span_scope === "root" ? true : undefined,
		errorsOnly: filters?.has_error,
		environments: filters?.deployment_environment ? [filters.deployment_environment] : undefined,
		namespaces: filters?.service_namespace ? [filters.service_namespace] : undefined,
		minDurationMs: filters?.min_duration_ms,
		maxDurationMs: filters?.max_duration_ms,
		groupByAttributeKeys: groupByAttributeKey ? [groupByAttributeKey] : undefined,
		attributeFilters: [...(attributeFilters(filters?.attributes) ?? []), ...httpFilters],
		resourceAttributeFilters: attributeFilters(filters?.resource_attributes),
	}
}

const logFilters = (filters: V2LogFilters | undefined) =>
	filters
		? {
				serviceName: filters.service_name,
				severity: filters.severity,
				minSeverity: filters.minimum_severity,
				traceId: filters.trace_id,
				spanId: filters.span_id,
				search: filters.body_search,
				environments: filters.deployment_environment ? [filters.deployment_environment] : undefined,
				namespaces: filters.service_namespace ? [filters.service_namespace] : undefined,
				attributeFilters: attributeFilters(filters.attributes),
				resourceAttributeFilters: attributeFilters(filters.resource_attributes),
			}
		: undefined

const metricFilters = (
	filters: V2MetricFilters,
	groupByAttributeKey?: string,
	groupByResourceAttributeKey?: string,
) => ({
	metricName: filters.metric_name,
	metricType: filters.metric_type,
	serviceName: filters.service_name,
	groupByAttributeKey,
	groupByResourceAttributeKey,
})

const decodeQueryEngineRequest = <E>(input: unknown, onInvalid: () => E) =>
	Schema.decodeUnknownEffect(QueryEngineExecuteRequest)(input).pipe(Effect.mapError(onInvalid))

const queryResultMismatch = (expectedKind: string, actualKind: string) =>
	new QueryEngineResultMismatchError({
		message: `Expected ${expectedKind} query result, received ${actualKind}`,
		expectedKind,
		actualKind,
	})

const validateTimeseriesBucket = (
	startTime: string,
	endTime: string,
	rangeSeconds: number,
	requestedBucketSeconds: number | undefined,
) => {
	const bucketSeconds =
		requestedBucketSeconds ?? computeBucketSeconds(Date.parse(startTime), Date.parse(endTime))
	return Math.floor(rangeSeconds / bucketSeconds) + 1 > MAX_TIMESERIES_BUCKETS
		? Effect.fail(
				V2TelemetryBucketCountTooLarge.make(
					`bucket_seconds produces more than ${MAX_TIMESERIES_BUCKETS.toLocaleString("en-US")} buckets.`,
					{ param: "bucket_seconds" },
				),
			)
		: Effect.succeed(bucketSeconds)
}

const validateBreakdownRange = (rangeSeconds: number, filters: unknown) => {
	if (rangeSeconds <= MAX_UNFILTERED_BREAKDOWN_RANGE_SECONDS) return Effect.void
	if (
		filters &&
		typeof filters === "object" &&
		Object.values(filters).some((value) =>
			Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null,
		)
	) {
		return Effect.void
	}
	return Effect.fail(
		V2TelemetryBreakdownFilterRequired.make(
			`Breakdowns over ${formatRangeSeconds(MAX_UNFILTERED_BREAKDOWN_RANGE_SECONDS)} require at least one narrowing filter.`,
			{ param: "filters" },
		),
	)
}

const pivotTimeseries = (
	data: ReadonlyArray<{ readonly bucket: string; readonly series: Readonly<Record<string, number>> }>,
	grouped: boolean,
) => {
	const names = [...new Set(data.flatMap((point) => Object.keys(point.series)))].sort()
	return names.map((name) => ({
		group: grouped ? name : null,
		points: data
			.filter((point) => name in point.series)
			.map((point) => ({ timestamp: chToIso(point.bucket), value: Number(point.series[name]) })),
	}))
}

export const HttpV2TracesLive = HttpApiBuilder.group(MapleApiV2, "traces", (handlers) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService
		const queryEngine = yield* QueryEngineService

		const hierarchy = Effect.fn("HttpV2Traces.hierarchy")(function* (
			tenant: CurrentTenant.TenantSchema,
			traceId: string,
		) {
			const compiled = yield* Effect.orDie(
				CH.compile(CH.spanHierarchyQuery({ traceId, limit: CH.SPAN_HIERARCHY_MAX_SPANS + 1 }), {
					orgId: tenant.orgId,
				}),
			)
			return yield* warehouse.compiledQuery(tenant, compiled, {
				profile: "list",
				context: "v2GetTrace",
			})
		})

		return handlers
			.handle("search", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const window = yield* parseWindow(payload.start_time, payload.end_time, {
						maxSeconds: MAX_SEARCH_RANGE_SECONDS,
						rangeLabel: "Trace search",
						precision: "millisecond",
					})
					const limit = payload.limit ?? 20
					const cursorParts = yield* decodeKeysetCursor(payload.cursor, "trc", 2)
					const filters = payload.filters
					const internalFilters = traceFilters(filters)
					const compiled = yield* Effect.orDie(
						CH.compile(
							CH.traceSummariesQuery({
								serviceName: filters?.service_name,
								spanName: filters?.span_name,
								statusCode: filters?.status_code,
								hasError: filters?.has_error,
								minDurationMs: filters?.min_duration_ms,
								maxDurationMs: filters?.max_duration_ms,
								httpMethod: filters?.http_method,
								httpRoute: filters?.http_route,
								httpStatusCode: filters?.http_status_code,
								deploymentEnv: filters?.deployment_environment,
								namespace: filters?.service_namespace,
								spanScope: filters?.span_scope,
								attributeFilters: internalFilters?.attributeFilters,
								resourceAttributeFilters: internalFilters?.resourceAttributeFilters,
								limit: limit + 1,
								cursor: cursorParts
									? { timestamp: cursorParts[0]!, traceId: cursorParts[1]! }
									: undefined,
							}),
							{ orgId: tenant.orgId, ...window },
						),
					)
					const rows = yield* warehouse.compiledQuery(tenant, compiled, {
						profile: "list",
						context: "v2TraceSearch",
					})

					const dataRows = rows.slice(0, limit)
					const last = dataRows.at(-1)
					const hasMore = rows.length > limit
					return {
						object: "list" as const,
						data: dataRows.map(toTraceSummary),
						has_more: hasMore,
						next_cursor:
							hasMore && last
								? encodeKeysetCursor("trc", [last.startTime, last.traceId])
								: null,
					}
				}),
			)
			.handle("timeseries", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const window = yield* parseWindow(payload.start_time, payload.end_time, {
						maxSeconds: MAX_QUERY_RANGE_SECONDS,
						rangeLabel: "Trace timeseries",
						precision: "millisecond",
					})
					const bucketSeconds = yield* validateTimeseriesBucket(
						payload.start_time,
						payload.end_time,
						window.rangeSeconds,
						payload.bucket_seconds,
					)
					const request = yield* decodeQueryEngineRequest(
						{
							startTime: window.startTime,
							endTime: window.endTime,
							query: {
								kind: "timeseries",
								source: "traces",
								metric: payload.aggregation,
								groupBy: payload.group_by ? [payload.group_by] : undefined,
								bucketSeconds,
								seriesLimit: payload.series_limit ?? PUBLIC_TIMESERIES_DEFAULT_SERIES_LIMIT,
								apdexThresholdMs:
									payload.aggregation === "apdex"
										? (payload.apdex_threshold_ms ?? 500)
										: undefined,
								filters: traceFilters(payload.filters, payload.group_by_attribute_key),
							},
						},
						() => V2TraceQueryInvalid.make(undefined, { param: "aggregation" }),
					)
					const response = yield* queryEngine.execute(tenant, request)

					if (response.result.kind !== "timeseries") {
						return yield* Effect.fail(queryResultMismatch("timeseries", response.result.kind))
					}
					return {
						object: "trace_timeseries" as const,
						aggregation: payload.aggregation,
						start_time: timestamp(payload.start_time),
						end_time: timestamp(payload.end_time),
						bucket_seconds: bucketSeconds,
						group_by: payload.group_by ?? null,
						series: pivotTimeseries(response.result.data, payload.group_by !== undefined),
					}
				}),
			)
			.handle("breakdown", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const window = yield* parseWindow(payload.start_time, payload.end_time, {
						maxSeconds: MAX_BREAKDOWN_RANGE_SECONDS,
						rangeLabel: "Trace breakdown",
						precision: "millisecond",
					})
					yield* validateBreakdownRange(window.rangeSeconds, payload.filters)
					const request = yield* decodeQueryEngineRequest(
						{
							startTime: window.startTime,
							endTime: window.endTime,
							query: {
								kind: "breakdown",
								source: "traces",
								metric: payload.aggregation,
								groupBy: payload.group_by,
								limit: payload.limit ?? PUBLIC_BREAKDOWN_DEFAULT_LIMIT,
								apdexThresholdMs:
									payload.aggregation === "apdex"
										? (payload.apdex_threshold_ms ?? 500)
										: undefined,
								filters: traceFilters(payload.filters, payload.group_by_attribute_key),
							},
						},
						() => V2TraceQueryInvalid.make(undefined, { param: "aggregation" }),
					)
					const response = yield* queryEngine.execute(tenant, request)

					if (response.result.kind !== "breakdown") {
						return yield* Effect.fail(queryResultMismatch("breakdown", response.result.kind))
					}
					return {
						object: "trace_breakdown" as const,
						aggregation: payload.aggregation,
						start_time: timestamp(payload.start_time),
						end_time: timestamp(payload.end_time),
						group_by: payload.group_by,
						data: response.result.data.map((item) => ({
							name: item.name,
							value: Number(item.value),
						})),
					}
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* hierarchy(tenant, params.trace_id)
					if (rows.length === 0) return yield* Effect.fail(V2TraceNotFound.make())
					const truncated = rows.length > CH.SPAN_HIERARCHY_MAX_SPANS
					const spans = rows.slice(0, CH.SPAN_HIERARCHY_MAX_SPANS).map(toSpan)
					const startMs = Math.min(...spans.map((span) => Date.parse(span.start_time)))
					const endMs = Math.max(
						...spans.map((span) => Date.parse(span.start_time) + span.duration_ms),
					)
					return {
						id: params.trace_id,
						object: "trace" as const,
						start_time: timestamp(new Date(startMs).toISOString()),
						end_time: timestamp(new Date(endMs).toISOString()),
						duration_ms: endMs - startMs,
						span_count: spans.length,
						service_count: new Set(spans.map((span) => span.service_name)).size,
						truncated,
						spans,
					}
				}),
			)
			.handle("retrieveSpan", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const detail = yield* warehouse
						.compiledQueryFirst(
							tenant,
							yield* Effect.orDie(
								CH.compile(
									CH.spanDetailQuery({
										traceId: params.trace_id,
										spanId: params.span_id,
									}),
									{ orgId: tenant.orgId },
								),
							),
							{ profile: "discovery", context: "v2GetSpan" },
						)
						.pipe(Effect.map(Option.getOrNull))
					if (!detail) return yield* Effect.fail(V2SpanNotFound.make())
					return toSpan(detail)
				}),
			)
	}),
)

export const HttpV2LogsLive = HttpApiBuilder.group(MapleApiV2, "logs", (handlers) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService
		const queryEngine = yield* QueryEngineService
		return handlers
			.handle("search", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const window = yield* parseWindow(payload.start_time, payload.end_time, {
						maxSeconds: MAX_SEARCH_RANGE_SECONDS,
						rangeLabel: "Log search",
						precision: "millisecond",
					})
					const limit = payload.limit ?? 20
					const cursorParts = yield* decodeKeysetCursor(payload.cursor, "log", 5)
					const filters = payload.filters
					const internalFilters = logFilters(filters)
					const compiled = yield* Effect.orDie(
						CH.compile(
							CH.logsListQuery({
								...internalFilters,
								limit: limit + 1,
								cursorIdentity: cursorParts
									? {
											timestamp: cursorParts[0]!,
											serviceName: cursorParts[1]!,
											traceId: cursorParts[2]!,
											spanId: cursorParts[3]!,
											recordIdentity: cursorParts[4]!,
										}
									: undefined,
							}),
							{ orgId: tenant.orgId, ...window },
						),
					)
					const rows = yield* warehouse.compiledQuery(tenant, compiled, {
						profile: "list",
						context: "v2LogSearch",
						settings: filters?.body_search ? LOGS_BODY_SEARCH_SETTINGS : undefined,
					})

					const dataRows = rows.slice(0, limit)
					const last = dataRows.at(-1)
					const hasMore = rows.length > limit
					return {
						object: "list" as const,
						data: dataRows.map(toLog),
						has_more: hasMore,
						next_cursor:
							hasMore && last
								? encodeKeysetCursor("log", [
										last.timestamp,
										last.serviceName,
										last.traceId,
										last.spanId,
										last.recordIdentity,
									])
								: null,
					}
				}),
			)
			.handle("timeseries", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const window = yield* parseWindow(payload.start_time, payload.end_time, {
						maxSeconds: MAX_QUERY_RANGE_SECONDS,
						rangeLabel: "Log timeseries",
						precision: "millisecond",
					})
					const bucketSeconds = yield* validateTimeseriesBucket(
						payload.start_time,
						payload.end_time,
						window.rangeSeconds,
						payload.bucket_seconds,
					)
					const request = yield* decodeQueryEngineRequest(
						{
							startTime: window.startTime,
							endTime: window.endTime,
							query: {
								kind: "timeseries",
								source: "logs",
								metric: "count",
								groupBy: payload.group_by ? [payload.group_by] : undefined,
								bucketSeconds,
								seriesLimit: payload.series_limit ?? PUBLIC_TIMESERIES_DEFAULT_SERIES_LIMIT,
								filters: logFilters(payload.filters),
							},
						},
						() => V2LogQueryInvalid.make(undefined, { param: "aggregation" }),
					)
					const response = yield* queryEngine.execute(tenant, request)

					if (response.result.kind !== "timeseries") {
						return yield* Effect.fail(queryResultMismatch("timeseries", response.result.kind))
					}
					return {
						object: "log_timeseries" as const,
						aggregation: "count" as const,
						start_time: timestamp(payload.start_time),
						end_time: timestamp(payload.end_time),
						bucket_seconds: bucketSeconds,
						group_by: payload.group_by ?? null,
						series: pivotTimeseries(response.result.data, payload.group_by !== undefined),
					}
				}),
			)
			.handle("breakdown", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const window = yield* parseWindow(payload.start_time, payload.end_time, {
						maxSeconds: MAX_BREAKDOWN_RANGE_SECONDS,
						rangeLabel: "Log breakdown",
						precision: "millisecond",
					})
					yield* validateBreakdownRange(window.rangeSeconds, payload.filters)
					const request = yield* decodeQueryEngineRequest(
						{
							startTime: window.startTime,
							endTime: window.endTime,
							query: {
								kind: "breakdown",
								source: "logs",
								metric: "count",
								groupBy: payload.group_by,
								limit: payload.limit ?? PUBLIC_BREAKDOWN_DEFAULT_LIMIT,
								filters: logFilters(payload.filters),
							},
						},
						() => V2LogQueryInvalid.make(undefined, { param: "aggregation" }),
					)
					const response = yield* queryEngine.execute(tenant, request)

					if (response.result.kind !== "breakdown") {
						return yield* Effect.fail(queryResultMismatch("breakdown", response.result.kind))
					}
					return {
						object: "log_breakdown" as const,
						aggregation: "count" as const,
						start_time: timestamp(payload.start_time),
						end_time: timestamp(payload.end_time),
						group_by: payload.group_by,
						data: response.result.data.map((item) => ({
							name: item.name,
							value: Number(item.value),
						})),
					}
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const [logTimestamp, recordIdentity] = yield* parseLogKey(params.id)
					const compiled = yield* Effect.orDie(
						CH.compile(
							CH.getLogByKeyQuery({
								recordIdentity,
							}),
							{
								orgId: tenant.orgId,
								...partitionWindow(logTimestamp),
								timestamp: logTimestamp,
							},
						),
					)
					const row = yield* warehouse
						.compiledQueryFirst(tenant, compiled, {
							profile: "list",
							context: "v2GetLog",
						})
						.pipe(Effect.map(Option.getOrNull))
					if (!row) return yield* Effect.fail(V2LogNotFound.make())
					return toLog(row)
				}),
			)
	}),
)

export const HttpV2MetricsLive = HttpApiBuilder.group(MapleApiV2, "metrics", (handlers) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService
		const queryEngine = yield* QueryEngineService
		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// `metric_catalog.Hour` is a plain DateTime — a fractional bound is a
					// hard TYPE_MISMATCH, not a rounding difference.
					const window = yield* parseWindow(query.start_time, query.end_time, {
						precision: "second",
					})
					const page = yield* paginateOffsetQuery(query, ({ limit, offset }) =>
						Effect.gen(function* () {
							const compiled = yield* Effect.orDie(
								CH.compile(
									CH.listMetricsQuery({
										serviceName: query.service_name,
										metricType: query.metric_type,
										search: query.search,
										limit,
										offset,
									}),
									{ orgId: tenant.orgId, ...window },
									{ rowSchema: metricCatalogRowSchema },
								),
							)
							return yield* warehouse
								.compiledQuery(tenant, compiled, {
									profile: "discovery",
									context: "v2ListMetrics",
								})
								.pipe(
									Effect.map(
										(rows): ReadonlyArray<V2Metric> =>
											rows.map((row) => ({
												object: "metric",
												name: decodeMetricName(row.metricName),
												type: row.metricType,
												service_name: row.serviceName,
												description: row.metricDescription,
												unit: row.metricUnit,
												is_monotonic: Number(row.isMonotonic) !== 0,
												data_point_count: Number(row.dataPointCount),
												first_seen: chToIso(row.firstSeen),
												last_seen: chToIso(row.lastSeen),
											})),
									),
								)
						}),
					)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("timeseries", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const window = yield* parseWindow(payload.start_time, payload.end_time, {
						maxSeconds: MAX_QUERY_RANGE_SECONDS,
						rangeLabel: "Metric timeseries",
						precision: "millisecond",
					})
					const bucketSeconds = yield* validateTimeseriesBucket(
						payload.start_time,
						payload.end_time,
						window.rangeSeconds,
						payload.bucket_seconds,
					)
					const request = yield* decodeQueryEngineRequest(
						{
							startTime: window.startTime,
							endTime: window.endTime,
							query: {
								kind: "timeseries",
								source: "metrics",
								metric: payload.aggregation,
								groupBy: payload.group_by ? [payload.group_by] : undefined,
								bucketSeconds,
								seriesLimit: payload.series_limit ?? PUBLIC_TIMESERIES_DEFAULT_SERIES_LIMIT,
								filters: metricFilters(
									payload.filters,
									payload.group_by_attribute_key,
									payload.group_by_resource_attribute_key,
								),
							},
						},
						() => V2MetricQueryInvalid.make(undefined, { param: "aggregation" }),
					)
					const response = yield* queryEngine.execute(tenant, request)

					if (response.result.kind !== "timeseries") {
						return yield* Effect.fail(queryResultMismatch("timeseries", response.result.kind))
					}
					return {
						object: "metric_timeseries" as const,
						aggregation: payload.aggregation,
						start_time: timestamp(payload.start_time),
						end_time: timestamp(payload.end_time),
						bucket_seconds: bucketSeconds,
						group_by: payload.group_by ?? null,
						series: pivotTimeseries(response.result.data, payload.group_by !== undefined),
					}
				}),
			)
			.handle("breakdown", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const window = yield* parseWindow(payload.start_time, payload.end_time, {
						maxSeconds: MAX_BREAKDOWN_RANGE_SECONDS,
						rangeLabel: "Metric breakdown",
						precision: "millisecond",
					})
					yield* validateBreakdownRange(window.rangeSeconds, payload.filters)
					const request = yield* decodeQueryEngineRequest(
						{
							startTime: window.startTime,
							endTime: window.endTime,
							query: {
								kind: "breakdown",
								source: "metrics",
								metric: payload.aggregation,
								groupBy: payload.group_by,
								limit: payload.limit ?? PUBLIC_BREAKDOWN_DEFAULT_LIMIT,
								filters: metricFilters(
									payload.filters,
									payload.group_by_attribute_key,
									payload.group_by_resource_attribute_key,
								),
							},
						},
						() => V2MetricQueryInvalid.make(undefined, { param: "aggregation" }),
					)
					const response = yield* queryEngine.execute(tenant, request)

					if (response.result.kind !== "breakdown") {
						return yield* Effect.fail(queryResultMismatch("breakdown", response.result.kind))
					}
					return {
						object: "metric_breakdown" as const,
						aggregation: payload.aggregation,
						start_time: timestamp(payload.start_time),
						end_time: timestamp(payload.end_time),
						group_by: payload.group_by,
						data: response.result.data.map((item) => ({
							name: item.name,
							value: Number(item.value),
						})),
					}
				}),
			)
	}),
)

// The latency baseline covers the seven days BEFORE the window being judged,
// so a regression that is still running can't raise the bar it is measured
// against.
const BASELINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
// Matches the `serviceHealthBaseline` registry definition the dashboard reads
// through, so both surfaces re-read a week-wide aggregate at the same rate.
const BASELINE_CACHE_SECONDS = 3600

/**
 * The trailing p95 a service is judged against, keyed by service name. The
 * catalog rows aggregate every namespace and environment under one name, so
 * the baseline rows collapse the same way: the busiest row wins rather than
 * the numbers being averaged across populations that don't compare.
 */
export type ServiceBaselines = ReadonlyMap<string, { p95LatencyMs: number; spanCount: number }>

const collapseBaselines = (
	rows: readonly {
		serviceName: string
		baselineP95LatencyMs: number
		baselineSpanCount: number
	}[],
): ServiceBaselines => {
	const map = new Map<string, { p95LatencyMs: number; spanCount: number }>()
	for (const row of rows) {
		const spanCount = Number(row.baselineSpanCount)
		const current = map.get(row.serviceName)
		if (current !== undefined && current.spanCount >= spanCount) continue
		map.set(row.serviceName, { p95LatencyMs: Number(row.baselineP95LatencyMs), spanCount })
	}
	return map
}

export const toService = (
	row: {
		serviceName: string
		serviceNamespaces: readonly string[]
		deploymentEnvironments: readonly string[]
		spanCount: number
		errorCount: number
		estimatedErrorCount: number
		estimatedSpanCount: number
		p50LatencyMs: number
		p95LatencyMs: number
		p99LatencyMs: number
	},
	rangeSeconds: number,
	baselines: ServiceBaselines,
): V2Service => {
	const spanCount = Number(row.spanCount)
	const estimatedSpanCount = Number(row.estimatedSpanCount)
	const estimatedErrorCount = Number(row.estimatedErrorCount)
	const baseline = baselines.get(row.serviceName)
	const service: V2Service = {
		object: "service",
		name: decodeServiceName(row.serviceName),
		service_namespaces: [...row.serviceNamespaces],
		deployment_environments: [...row.deploymentEnvironments],
		throughput: estimatedSpanCount / rangeSeconds,
		traced_throughput: spanCount / rangeSeconds,
		span_count: spanCount,
		error_count: Number(row.errorCount),
		error_rate: estimatedSpanCount > 0 ? estimatedErrorCount / estimatedSpanCount : 0,
		p50_latency_ms: Number(row.p50LatencyMs),
		p95_latency_ms: Number(row.p95LatencyMs),
		p99_latency_ms: Number(row.p99LatencyMs),
		has_sampling: estimatedSpanCount > spanCount + 0.001,
		sampling_weight: spanCount > 0 ? estimatedSpanCount / spanCount : 1,
	}
	// Omitted rather than zeroed when the service has no history: a zero
	// baseline would read as "instant, therefore everything is a regression".
	if (baseline === undefined) return service
	return {
		...service,
		baseline_p95_latency_ms: baseline.p95LatencyMs,
		baseline_span_count: baseline.spanCount,
	}
}

export const HttpV2ServicesLive = HttpApiBuilder.group(MapleApiV2, "services", (handlers) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService
		const queryEngine = yield* QueryEngineService

		/**
		 * Trailing p95 per service for the seven days before `windowStartMs`.
		 *
		 * Hour-floored so a polling client's drifting window keeps hitting the
		 * same cache entry, and cached for an hour — a week-wide aggregate that
		 * moves slowly should not be re-read on every list request.
		 */
		const loadBaselines = (
			tenant: CurrentTenant.TenantSchema,
			windowStartMs: number,
			filters: { deploymentEnvironment?: string; serviceNamespace?: string },
		) =>
			Effect.gen(function* () {
				const endMs = Math.floor(windowStartMs / HOUR_MS) * HOUR_MS
				const window = {
					startTime: formatWarehouseDateTime(endMs - BASELINE_WINDOW_MS),
					endTime: formatWarehouseDateTime(endMs),
				}
				const compiled = yield* Effect.orDie(
					CH.compile(
						CH.serviceHealthBaselineQuery({
							environments: filters.deploymentEnvironment
								? [filters.deploymentEnvironment]
								: undefined,
							namespaces: filters.serviceNamespace ? [filters.serviceNamespace] : undefined,
						}),
						{ orgId: tenant.orgId, ...window },
						{ rowSchema: serviceHealthBaselineRowSchema },
					),
				)
				const rows = yield* queryEngine.cachedDirect(
					tenant,
					"v2ServiceHealthBaseline",
					{ ...window, ...filters },
					warehouse.compiledQuery(tenant, compiled, {
						profile: "aggregation",
						context: "v2ServiceHealthBaseline",
					}),
					BASELINE_CACHE_SECONDS,
				)
				return collapseBaselines(rows)
			}).pipe(
				// A missing baseline is a supported state — clients fall back to
				// absolute thresholds — so a failed baseline read degrades the health
				// signal instead of failing the whole listing.
				Effect.catchCause((cause) =>
					Effect.as(
						Effect.logWarning("v2 service baseline read failed", cause),
						collapseBaselines([]),
					),
				),
			)

		const execute = (
			tenant: CurrentTenant.TenantSchema,
			window: { startTime: string; endTime: string; rangeSeconds: number },
			baselines: ServiceBaselines,
			opts: Parameters<typeof CH.serviceCatalogQuery>[0],
		) =>
			Effect.gen(function* () {
				const compiled = yield* Effect.orDie(
					CH.compile(
						CH.serviceCatalogQuery(opts),
						{ orgId: tenant.orgId, ...window },
						{ rowSchema: serviceCatalogRowSchema },
					),
				)
				return yield* warehouse
					.compiledQuery(tenant, compiled, {
						profile: "aggregation",
						context: "v2ServiceCatalog",
					})
					.pipe(
						Effect.map((rows) =>
							rows.map((row) => toService(row, window.rangeSeconds, baselines)),
						),
					)
			})
		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const window = yield* parseWindow(query.start_time, query.end_time, {
						maxSeconds: MAX_SUMMARY_RANGE_SECONDS,
						// Reads the hourly rollups, whose Timestamp is a plain DateTime.
						precision: "second",
						rangeLabel: "Service queries",
					})
					const baselines = yield* loadBaselines(tenant, Date.parse(query.start_time), {
						deploymentEnvironment: query.deployment_environment,
						serviceNamespace: query.service_namespace,
					})
					const page = yield* paginateOffsetQuery(query, ({ limit, offset }) =>
						execute(tenant, window, baselines, {
							deploymentEnvironment: query.deployment_environment,
							serviceNamespace: query.service_namespace,
							limit,
							offset,
						}),
					)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const window = yield* parseWindow(query.start_time, query.end_time, {
						maxSeconds: MAX_SUMMARY_RANGE_SECONDS,
						// Reads the hourly rollups, whose Timestamp is a plain DateTime.
						precision: "second",
						rangeLabel: "Service queries",
					})
					const baselines = yield* loadBaselines(tenant, Date.parse(query.start_time), {})
					const rows = yield* execute(tenant, window, baselines, {
						serviceName: params.name,
						limit: 1,
					})
					if (!rows[0]) return yield* Effect.fail(V2ServiceNotFound.make())
					return rows[0]
				}),
			)
	}),
)

const toMapEdge = (row: {
	sourceService: string
	targetService: string
	callCount: number
	errorCount: number
	avgDurationMs: number
	p95DurationMs: number
	estimatedSpanCount: number
}): V2ServiceMapEdge => {
	const calls = Number(row.callCount)
	const estimated = Number(row.estimatedSpanCount)
	const errors = Number(row.errorCount)
	return {
		object: "service_map.edge",
		source_service: row.sourceService,
		target_service: row.targetService,
		call_count: calls,
		estimated_call_count: estimated,
		error_count: errors,
		error_rate: calls > 0 ? errors / calls : 0,
		avg_duration_ms: Number(row.avgDurationMs),
		max_duration_ms: Number(row.p95DurationMs),
		has_sampling: estimated > calls + 0.001,
		sampling_weight: calls > 0 ? estimated / calls : 1,
	}
}

const serviceEnvironmentsRowSchema = Schema.Struct({
	environment: Schema.String,
})

/**
 * The values every other endpoint's `deployment_environment` filter accepts.
 *
 * `"discovery"` rather than `"aggregation"`: the read is a `GROUP BY` over one
 * LowCardinality column, and clients poll it to keep an environment picker
 * populated. A cheap ceiling is the honest description of that work, and it
 * stops a slow one from spending an analytical budget it never needed.
 */
export const HttpV2EnvironmentsLive = HttpApiBuilder.group(MapleApiV2, "environments", (handlers) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService
		return handlers.handle("list", ({ query }) =>
			Effect.gen(function* () {
				const tenant = yield* CurrentTenant.Context
				const window = yield* parseWindow(query.start_time, query.end_time, {
					maxSeconds: MAX_SUMMARY_RANGE_SECONDS,
					// Reads the hourly rollups, whose Timestamp is a plain DateTime.
					precision: "second",
					rangeLabel: "Environment queries",
				})
				const compiled = yield* Effect.orDie(
					CH.compile(
						CH.serviceEnvironmentsQuery(),
						{ orgId: tenant.orgId, ...window },
						{ rowSchema: serviceEnvironmentsRowSchema },
					),
				)
				const rows = yield* warehouse.compiledQuery(tenant, compiled, {
					profile: "discovery",
					context: "v2Environments",
				})

				return {
					object: "list" as const,
					data: rows.map((row) => ({ object: "environment" as const, name: row.environment })),
					// The query's own limit sits well above any real organization's
					// environment count, so a page is always the whole list. Paginating
					// would hand clients a cursor that is never non-null.
					has_more: false,
					next_cursor: null,
				}
			}),
		)
	}),
)

export const HttpV2ServiceMapLive = HttpApiBuilder.group(MapleApiV2, "serviceMap", (handlers) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService
		return handlers.handle("retrieve", ({ query }) =>
			Effect.gen(function* () {
				const tenant = yield* CurrentTenant.Context
				const window = yield* parseWindow(query.start_time, query.end_time, {
					maxSeconds: MAX_SUMMARY_RANGE_SECONDS,
					// Reads the hourly rollups, whose Timestamp is a plain DateTime.
					precision: "second",
					rangeLabel: "Service map queries",
				})
				const compiled = query.service_name
					? yield* Effect.orDie(
							CH.compile(
								CH.serviceDependenciesForServiceQuery({
									serviceName: query.service_name,
									deploymentEnv: query.deployment_environment,
								}),
								{ orgId: tenant.orgId, ...window },
							),
						)
					: yield* Effect.orDie(
							CH.serviceDependenciesSQL(
								{ deploymentEnv: query.deployment_environment },
								{ orgId: tenant.orgId, ...window },
							),
						)
				const rows = yield* warehouse.compiledQuery(tenant, compiled, {
					profile: "aggregation",
					context: "v2ServiceMap",
				})

				return {
					object: "service_map" as const,
					start_time: timestamp(query.start_time),
					end_time: timestamp(query.end_time),
					edges: rows.map(toMapEdge),
				}
			}),
		)
	}),
)
