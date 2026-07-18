import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MetricName, ServiceName, SpanId, TraceId } from "@maple/domain/http"
import {
	MapleApiV2,
	dependencyUnavailable,
	invalidRequest,
	paginateOffsetQuery,
	resourceNotFound,
	timestamp,
	type Timestamp,
	type V2Log,
	type V2Metric,
	type V2Service,
	type V2ServiceMapEdge,
	type V2Span,
	type V2StructuredQueryResult,
	type V2TraceSummary,
} from "@maple/domain/http/v2"
import { CH, QueryEngineExecuteRequest } from "@maple/query-engine"
import { LOGS_BODY_SEARCH_SETTINGS } from "@maple/query-engine/profiles"
import { MAX_QUERY_RANGE_SECONDS } from "@maple/query-engine/runtime"
import { Effect, Encoding, Option, Result, Schema } from "effect"
import { WarehouseQueryService } from "../../lib/WarehouseQueryService"
import { QueryEngineService } from "../../services/QueryEngineService"

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
	isMonotonic: Schema.Union([Schema.Boolean, CH.CHNumber]),
})

const serviceCatalogRowSchema = Schema.Struct({
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

const PARTITION_HINT_RADIUS_MS = 60 * 60 * 1000
const PUBLIC_TIMESERIES_DEFAULT_SERIES_LIMIT = 50

const mapWarehouseError = (operation: string) => () => dependencyUnavailable(`${operation}_unavailable`)

const toWarehouseDateTime = (value: string, param: string) => {
	const ms = Date.parse(value)
	return Number.isNaN(ms)
		? Effect.fail(invalidRequest("parameter_invalid", `Invalid ISO-8601 timestamp for ${param}.`, param))
		: Effect.succeed(new Date(ms).toISOString().replace("T", " ").replace(/Z$/, ""))
}

const parseWindow = (start: string, end: string) =>
	Effect.gen(function* () {
		const startMs = Date.parse(start)
		const endMs = Date.parse(end)
		if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
			return yield* Effect.fail(
				invalidRequest("time_range_invalid", "end_time must be later than start_time.", "end_time"),
			)
		}
		const rangeSeconds = (endMs - startMs) / 1000
		if (rangeSeconds > MAX_QUERY_RANGE_SECONDS) {
			return yield* Effect.fail(
				invalidRequest(
					"time_range_too_large",
					"Telemetry queries support a maximum time range of 31 days.",
					"start_time",
				),
			)
		}
		return {
			startTime: yield* toWarehouseDateTime(start, "start_time"),
			endTime: yield* toWarehouseDateTime(end, "end_time"),
			rangeSeconds,
		}
	})

const chToIso = (value: string): Timestamp => {
	const normalized = value.includes("T") ? value : value.replace(" ", "T")
	const zoned = /[zZ]|[+-]\d\d:?\d\d$/.test(normalized) ? normalized : `${normalized}Z`
	const ms = Date.parse(zoned)
	return timestamp(Number.isNaN(ms) ? value : new Date(ms).toISOString())
}

const warehouseDate = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/Z$/, "")
const partitionWindow = (value: string) => {
	const ms = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`)
	return {
		startTime: warehouseDate(ms - PARTITION_HINT_RADIUS_MS),
		endTime: warehouseDate(ms + PARTITION_HINT_RADIUS_MS),
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
	const seconds = new Date(epochSeconds * 1000).toISOString().slice(0, 19).replace("T", " ")
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
		return Effect.fail(invalidRequest("log_id_invalid", "Malformed log ID.", "id"))
	}
}

const encodeKeysetCursor = (prefix: string, parts: ReadonlyArray<string>) =>
	`${prefix}_${Encoding.encodeBase64Url(JSON.stringify(parts))}`

const decodeKeysetCursor = (value: string | undefined, prefix: string, length: number) => {
	if (value === undefined) return Effect.succeed<ReadonlyArray<string> | undefined>(undefined)
	if (!value.startsWith(`${prefix}_`)) {
		return Effect.fail(invalidRequest("parameter_invalid", "Invalid pagination cursor.", "cursor"))
	}
	const decoded = Encoding.decodeBase64UrlString(value.slice(prefix.length + 1))
	if (Result.isFailure(decoded)) {
		return Effect.fail(invalidRequest("parameter_invalid", "Invalid pagination cursor.", "cursor"))
	}
	try {
		const parts = JSON.parse(decoded.success) as unknown
		return Array.isArray(parts) &&
			parts.length === length &&
			parts.every((part) => typeof part === "string")
			? Effect.succeed(parts as ReadonlyArray<string>)
			: Effect.fail(invalidRequest("parameter_invalid", "Invalid pagination cursor.", "cursor"))
	} catch {
		return Effect.fail(invalidRequest("parameter_invalid", "Invalid pagination cursor.", "cursor"))
	}
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
	status_code: row.statusCode,
	has_error: Number(row.hasError) !== 0,
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
				value?: string
				mode: string
				negated?: boolean
		  }>
		| undefined,
) =>
	filters?.map((filter) => ({
		key: filter.key,
		...(filter.value !== undefined ? { value: filter.value } : {}),
		mode: filter.mode,
		...(filter.negated !== undefined ? { negated: filter.negated } : {}),
	}))

const toInternalQuery = (query: Record<string, any>): Record<string, any> => {
	const mapped: Record<string, any> = {
		kind: query.kind,
		source: query.source,
		metric: query.metric,
		groupBy: query.group_by,
		bucketSeconds: query.bucket_seconds,
		seriesLimit:
			query.kind === "timeseries"
				? (query.series_limit ?? PUBLIC_TIMESERIES_DEFAULT_SERIES_LIMIT)
				: undefined,
		limit: query.limit,
		apdexThresholdMs: query.apdex_threshold_ms,
	}
	const filters = query.filters
	if (filters) {
		mapped.filters = {
			serviceName: filters.service_name,
			spanName: filters.span_name,
			rootSpansOnly: filters.root_spans_only,
			errorsOnly: filters.errors_only,
			environments: filters.environments,
			namespaces: filters.namespaces,
			minDurationMs: filters.min_duration_ms,
			maxDurationMs: filters.max_duration_ms,
			severity: filters.severity,
			traceId: filters.trace_id,
			search: filters.search,
			metricName: filters.metric_name,
			metricType: filters.metric_type,
			groupByAttributeKey: filters.group_by_attribute_key,
			groupByAttributeKeys: filters.group_by_attribute_keys,
			groupByResourceAttributeKey: filters.group_by_resource_attribute_key,
			attributeFilters: attributeFilters(filters.attribute_filters),
			resourceAttributeFilters: attributeFilters(filters.resource_attribute_filters),
		}
	}
	return Object.fromEntries(Object.entries(mapped).filter(([, value]) => value !== undefined))
}

const structuredResult = (result: {
	kind: "timeseries" | "breakdown"
	source: "traces" | "logs" | "metrics"
	data: ReadonlyArray<unknown>
}): V2StructuredQueryResult => ({
	object: "query_result",
	kind: result.kind,
	source: result.source,
	timeseries:
		result.kind === "timeseries"
			? (result.data as ReadonlyArray<{ bucket: string; series: Record<string, number> }>).map(
					(point) => ({ bucket: chToIso(point.bucket), series: point.series }),
				)
			: [],
	breakdown: result.kind === "breakdown" ? (result.data as V2StructuredQueryResult["breakdown"]) : [],
})

const queryError = (error: unknown) => {
	const tag = typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : ""
	return tag.includes("Validation")
		? invalidRequest("query_invalid", "The query specification is invalid.", "query")
		: dependencyUnavailable("query_unavailable")
}

const decodeQueryEngineRequest = (input: unknown) =>
	Schema.decodeUnknownEffect(QueryEngineExecuteRequest)(input).pipe(
		Effect.mapError(() =>
			invalidRequest("query_invalid", "The query specification is invalid.", "query"),
		),
	)

export const HttpV2TracesLive = HttpApiBuilder.group(MapleApiV2, "traces", (handlers) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService

		const hierarchy = Effect.fn("HttpV2Traces.hierarchy")(function* (
			tenant: CurrentTenant.TenantSchema,
			traceId: string,
		) {
			const compiled = CH.compile(
				CH.spanHierarchyQuery({ traceId, limit: CH.SPAN_HIERARCHY_MAX_SPANS + 1 }),
				{
					orgId: tenant.orgId,
				},
			)
			return yield* warehouse
				.compiledQuery(tenant, compiled, {
					profile: "list",
					context: "v2GetTrace",
				})
				.pipe(Effect.mapError(mapWarehouseError("trace_query")))
		})

		return handlers
			.handle("search", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const window = yield* parseWindow(payload.start_time, payload.end_time)
					const limit = payload.limit ?? 20
					const cursorParts = yield* decodeKeysetCursor(payload.cursor, "trc", 2)
					const compiled = CH.compile(
						CH.traceSummariesQuery({
							serviceName: payload.service_name,
							spanName: payload.span_name,
							hasError: payload.has_error,
							minDurationMs: payload.min_duration_ms,
							maxDurationMs: payload.max_duration_ms,
							httpMethod: payload.http_method,
							httpStatusCode: payload.http_status_code,
							deploymentEnv: payload.deployment_environment,
							namespace: payload.service_namespace,
							limit: limit + 1,
							cursor: cursorParts
								? { timestamp: cursorParts[0]!, traceId: cursorParts[1]! }
								: undefined,
						}),
						{ orgId: tenant.orgId, ...window },
					)
					const rows = yield* warehouse
						.compiledQuery(tenant, compiled, { profile: "list", context: "v2TraceSearch" })
						.pipe(Effect.mapError(mapWarehouseError("trace_search")))
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
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* hierarchy(tenant, params.trace_id)
					if (rows.length === 0) return yield* resourceNotFound("trace", "No such trace.")
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
							CH.compile(
								CH.spanDetailQuery({
									traceId: params.trace_id,
									spanId: params.span_id,
								}),
								{ orgId: tenant.orgId },
							),
							{ profile: "discovery", context: "v2GetSpan" },
						)
						.pipe(Effect.mapError(mapWarehouseError("span_query")), Effect.map(Option.getOrNull))
					if (!detail) return yield* resourceNotFound("span", "No such span.")
					return toSpan(detail)
				}),
			)
	}),
)

export const HttpV2LogsLive = HttpApiBuilder.group(MapleApiV2, "logs", (handlers) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService
		return handlers
			.handle("search", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const window = yield* parseWindow(payload.start_time, payload.end_time)
					const limit = payload.limit ?? 20
					const cursorParts = yield* decodeKeysetCursor(payload.cursor, "log", 5)
					const compiled = CH.compile(
						CH.logsListQuery({
							serviceName: payload.service_name,
							severity: payload.severity,
							minSeverity: payload.min_severity,
							traceId: payload.trace_id,
							spanId: payload.span_id,
							search: payload.search,
							environments: payload.deployment_environment
								? [payload.deployment_environment]
								: undefined,
							namespaces: payload.service_namespace ? [payload.service_namespace] : undefined,
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
					)
					const rows = yield* warehouse
						.compiledQuery(tenant, compiled, {
							profile: "list",
							context: "v2LogSearch",
							settings: payload.search ? LOGS_BODY_SEARCH_SETTINGS : undefined,
						})
						.pipe(Effect.mapError(mapWarehouseError("log_search")))
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
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const [logTimestamp, recordIdentity] = yield* parseLogKey(params.id)
					const compiled = CH.compile(
						CH.getLogByKeyQuery({
							recordIdentity,
						}),
						{
							orgId: tenant.orgId,
							...partitionWindow(logTimestamp),
							timestamp: logTimestamp,
						},
					)
					const row = yield* warehouse
						.compiledQueryFirst(tenant, compiled, {
							profile: "list",
							context: "v2GetLog",
						})
						.pipe(Effect.mapError(mapWarehouseError("log_query")), Effect.map(Option.getOrNull))
					if (!row) return yield* resourceNotFound("log", "No such log.")
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
					const window = yield* parseWindow(query.start_time, query.end_time)
					const page = yield* paginateOffsetQuery(query, ({ limit, offset }) => {
						const compiled = CH.compile(
							CH.listMetricsQuery({
								serviceName: query.service_name,
								metricType: query.metric_type,
								search: query.search,
								limit,
								offset,
							}),
							{ orgId: tenant.orgId, ...window },
							{ rowSchema: metricCatalogRowSchema },
						)
						return warehouse
							.compiledQuery(tenant, compiled, {
								profile: "discovery",
								context: "v2ListMetrics",
							})
							.pipe(
								Effect.mapError(mapWarehouseError("metric_catalog")),
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
					})
					return { object: "list" as const, ...page }
				}),
			)
			.handle("timeseries", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const window = yield* parseWindow(payload.start_time, payload.end_time)
					const request = yield* decodeQueryEngineRequest({
						startTime: window.startTime,
						endTime: window.endTime,
						query: {
							kind: "timeseries",
							source: "metrics",
							metric: payload.metric,
							groupBy: payload.group_by,
							bucketSeconds: payload.bucket_seconds,
							seriesLimit: payload.series_limit ?? PUBLIC_TIMESERIES_DEFAULT_SERIES_LIMIT,
							filters: {
								metricName: payload.metric_name,
								metricType: payload.metric_type,
								serviceName: payload.service_name,
								groupByAttributeKey: payload.group_by_attribute_key,
								groupByResourceAttributeKey: payload.group_by_resource_attribute_key,
								attributeFilters: attributeFilters(payload.attribute_filters),
								resourceAttributeFilters: attributeFilters(
									payload.resource_attribute_filters,
								),
							},
						},
					})
					const response = yield* queryEngine
						.execute(tenant, request)
						.pipe(Effect.mapError(queryError))
					if (response.result.kind !== "timeseries")
						return yield* Effect.fail(dependencyUnavailable("metric_query_unavailable"))
					return structuredResult(response.result)
				}),
			)
	}),
)

const toService = (
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
): V2Service => {
	const spanCount = Number(row.spanCount)
	const estimatedSpanCount = Number(row.estimatedSpanCount)
	const estimatedErrorCount = Number(row.estimatedErrorCount)
	return {
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
}

export const HttpV2ServicesLive = HttpApiBuilder.group(MapleApiV2, "services", (handlers) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService
		const execute = (
			tenant: CurrentTenant.TenantSchema,
			window: { startTime: string; endTime: string; rangeSeconds: number },
			opts: Parameters<typeof CH.serviceCatalogQuery>[0],
		) => {
			const compiled = CH.compile(
				CH.serviceCatalogQuery(opts),
				{ orgId: tenant.orgId, ...window },
				{ rowSchema: serviceCatalogRowSchema },
			)
			return warehouse
				.compiledQuery(tenant, compiled, {
					profile: "aggregation",
					context: "v2ServiceCatalog",
				})
				.pipe(
					Effect.mapError(mapWarehouseError("service_query")),
					Effect.map((rows) => rows.map((row) => toService(row, window.rangeSeconds))),
				)
		}
		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const window = yield* parseWindow(query.start_time, query.end_time)
					const page = yield* paginateOffsetQuery(query, ({ limit, offset }) =>
						execute(tenant, window, {
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
					const window = yield* parseWindow(query.start_time, query.end_time)
					const rows = yield* execute(tenant, window, {
						serviceName: params.name,
						limit: 1,
					})
					if (!rows[0]) return yield* resourceNotFound("service", "No such service.")
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

export const HttpV2ServiceMapLive = HttpApiBuilder.group(MapleApiV2, "serviceMap", (handlers) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService
		return handlers.handle("retrieve", ({ query }) =>
			Effect.gen(function* () {
				const tenant = yield* CurrentTenant.Context
				const window = yield* parseWindow(query.start_time, query.end_time)
				const compiled = query.service_name
					? CH.compile(
							CH.serviceDependenciesForServiceQuery({
								serviceName: query.service_name,
								deploymentEnv: query.deployment_environment,
							}),
							{ orgId: tenant.orgId, ...window },
						)
					: CH.serviceDependenciesSQL(
							{ deploymentEnv: query.deployment_environment },
							{ orgId: tenant.orgId, ...window },
						)
				const rows = yield* warehouse
					.compiledQuery(tenant, compiled, {
						profile: "aggregation",
						context: "v2ServiceMap",
					})
					.pipe(Effect.mapError(mapWarehouseError("service_map_query")))
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

export const HttpV2QueryLive = HttpApiBuilder.group(MapleApiV2, "query", (handlers) =>
	Effect.gen(function* () {
		const queryEngine = yield* QueryEngineService
		return handlers.handle("execute", ({ payload }) =>
			Effect.gen(function* () {
				const tenant = yield* CurrentTenant.Context
				const window = yield* parseWindow(payload.start_time, payload.end_time)
				const request = yield* decodeQueryEngineRequest({
					startTime: window.startTime,
					endTime: window.endTime,
					query: toInternalQuery(payload.query),
				})
				const response = yield* queryEngine.execute(tenant, request).pipe(Effect.mapError(queryError))
				if (response.result.kind !== "timeseries" && response.result.kind !== "breakdown") {
					return yield* Effect.fail(dependencyUnavailable("query_unavailable"))
				}
				return structuredResult(response.result)
			}),
		)
	}),
)
