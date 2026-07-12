import { Clock, Effect, Schema } from "effect"
import { QueryEngineExecuteRequest, TracesFacetDimension, type AttributeFilter } from "@maple/query-engine"
import { TraceId, SpanId } from "@maple/domain"
import {
	DeploymentEnvironment,
	ServiceName,
	ServiceNamespace,
	SpanDetailRequest,
	SpanHierarchyRequest,
	SpanName,
} from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { computeTraceTimeWindow } from "@/lib/trace-time-window"
import {
	WarehouseDateTimeString,
	WarehouseTransformError,
	decodeInput,
	executeQueryEngine,
	extractAttributeValues,
	extractFacets,
	extractStats,
	runWarehouseQuery,
} from "@/api/warehouse/effect-utils"
import { getHttpInfo, type HttpInfo } from "@maple/ui/lib/http"
import type { Span, SpanNode } from "@maple/ui/types"
import {
	buildSpanTree,
	dedupeBySpanId,
	parseAttributes,
	transformSpan,
	type SpanHierarchyRow,
} from "@maple/ui/lib/span-tree"

const toTraceId = Schema.decodeSync(TraceId)

const ContainsMatchMode = Schema.optional(Schema.Literals(["contains"]))

const AttributeFilterInput = Schema.Struct({
	key: Schema.String,
	value: Schema.String,
	matchMode: Schema.optional(Schema.String),
	negated: Schema.optional(Schema.Boolean),
})

const ListTracesInputSchema = Schema.Struct({
	limit: Schema.optional(
		Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1000)),
	),
	offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
	service: Schema.optional(ServiceName),
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	spanName: Schema.optional(SpanName),
	hasError: Schema.optional(Schema.Boolean),
	minDurationMs: Schema.optional(Schema.Number),
	maxDurationMs: Schema.optional(Schema.Number),
	httpMethod: Schema.optional(Schema.String),
	httpStatusCode: Schema.optional(Schema.String),
	deploymentEnv: Schema.optional(DeploymentEnvironment),
	namespace: Schema.optional(ServiceNamespace),
	attributeFilters: Schema.optional(Schema.Array(AttributeFilterInput)),
	resourceAttributeFilters: Schema.optional(Schema.Array(AttributeFilterInput)),
	rootOnly: Schema.optional(Schema.Boolean),
	serviceMatchMode: ContainsMatchMode,
	spanNameMatchMode: ContainsMatchMode,
	deploymentEnvMatchMode: ContainsMatchMode,
	namespaceMatchMode: ContainsMatchMode,
	excludedServices: Schema.optional(Schema.Array(ServiceName)),
	excludedSpanNames: Schema.optional(Schema.Array(SpanName)),
	excludedDeploymentEnvs: Schema.optional(Schema.Array(DeploymentEnvironment)),
	excludedNamespaces: Schema.optional(Schema.Array(ServiceNamespace)),
	excludedHttpMethods: Schema.optional(Schema.Array(Schema.String)),
	excludedHttpStatusCodes: Schema.optional(Schema.Array(Schema.String)),
})

export type ListTracesInput = (typeof ListTracesInputSchema)["Encoded"]
type ListTracesDecoded = (typeof ListTracesInputSchema)["Type"]

const DEFAULT_LIMIT = 100
const DEFAULT_OFFSET = 0

const LIST_PROJECTED_COLUMNS = [
	"spanAttributes.http.method",
	"spanAttributes.http.request.method",
	"spanAttributes.http.route",
	"spanAttributes.http.target",
	"spanAttributes.http.status_code",
	"spanAttributes.http.response.status_code",
	"spanAttributes.http.url",
	"spanAttributes.url.full",
	"spanAttributes.url.path",
	"spanAttributes.server.address",
	"spanAttributes.net.peer.name",
] as const

interface TraceRootSpanSummary {
	name: string
	kind: string
	statusCode: string
	attributes: Record<string, string>
	http: HttpInfo | null
}

export interface Trace {
	traceId: TraceId
	startTime: string
	endTime: string
	durationMs: number
	spanCount: number
	services: string[]
	rootSpan: TraceRootSpanSummary
	rootSpanName: string
	hasError: boolean
}

export interface TracesResponse {
	data: Trace[]
	meta: {
		limit: number
		offset: number
	}
}

function buildAttributeFilters(input: ListTracesDecoded): AttributeFilter[] {
	const filters: AttributeFilter[] = []

	if (input.httpMethod) {
		filters.push({ key: "http.method", value: input.httpMethod, mode: "equals" })
	}
	if (input.httpStatusCode) {
		filters.push({ key: "http.status_code", value: input.httpStatusCode, mode: "equals" })
	}
	if (input.attributeFilters) {
		for (const af of input.attributeFilters) {
			filters.push({
				key: af.key,
				value: af.value,
				mode: af.matchMode === "contains" ? "contains" : "equals",
				negated: af.negated || undefined,
			})
		}
	}
	for (const m of input.excludedHttpMethods ?? []) {
		filters.push({ key: "http.method", value: m, mode: "equals", negated: true })
	}
	for (const s of input.excludedHttpStatusCodes ?? []) {
		filters.push({ key: "http.status_code", value: s, mode: "equals", negated: true })
	}

	return filters
}

function buildResourceAttributeFilters(input: ListTracesDecoded): AttributeFilter[] {
	const filters: AttributeFilter[] = []

	if (input.resourceAttributeFilters) {
		for (const rf of input.resourceAttributeFilters) {
			filters.push({
				key: rf.key,
				value: rf.value,
				mode: rf.matchMode === "contains" ? "contains" : "equals",
				negated: rf.negated || undefined,
			})
		}
	}

	return filters
}

/** Transform a list row from tracesListQuery */
function transformSpanListRow(row: Record<string, unknown>): Trace {
	const spanAttrs = (row.spanAttributes ?? {}) as Record<string, string>
	const rootSpanAttributes: Record<string, string> = {}
	const PROJECTED_ATTR_KEYS = [
		"http.method",
		"http.request.method",
		"http.route",
		"http.target",
		"http.status_code",
		"http.response.status_code",
		"http.url",
		"url.full",
		"url.path",
		"server.address",
		"net.peer.name",
	] as const
	for (const key of PROJECTED_ATTR_KEYS) {
		if (spanAttrs[key]) rootSpanAttributes[key] = spanAttrs[key]
	}

	const timestamp = String(row.timestamp)
	return {
		traceId: toTraceId(String(row.traceId)),
		startTime: timestamp,
		endTime: timestamp,
		durationMs: Number(row.durationMs),
		spanCount: 1,
		services: [String(row.serviceName)],
		rootSpan: {
			name: String(row.spanName),
			kind: String(row.spanKind),
			statusCode: String(row.statusCode),
			attributes: rootSpanAttributes,
			http: getHttpInfo({
				spanName: String(row.spanName),
				spanAttributes: rootSpanAttributes,
				spanKind: String(row.spanKind),
			}),
		},
		rootSpanName: String(row.spanName),
		hasError: row.hasError === true || row.hasError === 1,
	}
}

export function listTraces({ data }: { data: ListTracesInput }) {
	return listTracesEffect({ data })
}

const listTracesEffect = Effect.fn("QueryEngine.listTraces")(function* ({ data }: { data: ListTracesInput }) {
	const input = yield* decodeInput(ListTracesInputSchema, data ?? {}, "listTraces")
	const limit = input.limit ?? DEFAULT_LIMIT
	const offset = input.offset ?? DEFAULT_OFFSET

	const attributeFilters = buildAttributeFilters(input)
	const resourceAttributeFilters = buildResourceAttributeFilters(input)

	const matchModes: Record<string, string> = {}
	if (input.serviceMatchMode === "contains") matchModes.serviceName = "contains"
	if (input.spanNameMatchMode === "contains") matchModes.spanName = "contains"
	if (input.deploymentEnvMatchMode === "contains") matchModes.deploymentEnv = "contains"
	if (input.namespaceMatchMode === "contains") matchModes.serviceNamespace = "contains"

	const rootOnly = input.rootOnly ?? true

	if (input.service) yield* Effect.annotateCurrentSpan("service", input.service)
	yield* Effect.annotateCurrentSpan("rootOnly", rootOnly)
	yield* Effect.annotateCurrentSpan("limit", limit)

	const request = new QueryEngineExecuteRequest({
		startTime: input.startTime ?? "2020-01-01 00:00:00",
		endTime: input.endTime ?? "2099-12-31 23:59:59",
		query: {
			kind: "list" as const,
			source: "traces" as const,
			limit,
			offset,
			// Only project the span attributes the list UI actually renders
			// (via transformSpanListRow → getHttpInfo). Avoids reading the full
			// SpanAttributes / ResourceAttributes maps — large win on wide traces.
			columns: LIST_PROJECTED_COLUMNS,
			filters: {
				serviceName: input.service,
				spanName: input.spanName,
				rootSpansOnly: rootOnly,
				errorsOnly: input.hasError,
				environments: input.deploymentEnv ? [input.deploymentEnv] : undefined,
				namespaces: input.namespace ? [input.namespace] : undefined,
				minDurationMs: input.minDurationMs,
				maxDurationMs: input.maxDurationMs,
				matchModes: Object.keys(matchModes).length > 0 ? matchModes : undefined,
				attributeFilters: attributeFilters.length > 0 ? attributeFilters : undefined,
				resourceAttributeFilters:
					resourceAttributeFilters.length > 0 ? resourceAttributeFilters : undefined,
				excludedServiceNames: input.excludedServices?.length ? input.excludedServices : undefined,
				excludedSpanNames: input.excludedSpanNames?.length ? input.excludedSpanNames : undefined,
				excludedEnvironments: input.excludedDeploymentEnvs?.length
					? input.excludedDeploymentEnvs
					: undefined,
				excludedNamespaces: input.excludedNamespaces?.length ? input.excludedNamespaces : undefined,
			},
		},
	})

	const response = yield* executeQueryEngine("queryEngine.listTraces", request)

	if (response.result.kind !== "list") {
		return yield* Effect.fail(
			new WarehouseTransformError({
				operation: "queryEngine.listTraces",
				message: `Unexpected result kind from query engine: ${response.result.kind}`,
			}),
		)
	}

	const traces = response.result.data.map(transformSpanListRow)

	return {
		data: traces,
		meta: { limit, offset },
	}
})

// Canonical Span/SpanNode shapes live in @maple/ui so the shared trace
// components can consume them; re-export here so existing
// `@/api/warehouse/traces` importers keep working unchanged.
export type { Span, SpanNode } from "@maple/ui/types"

export interface SpanHierarchyResponse {
	traceId: TraceId
	spans: Span[]
	rootSpans: SpanNode[]
	totalDurationMs: number
}

const GetSpanHierarchyInputSchema = Schema.Struct({
	traceId: TraceId,
	spanId: Schema.optional(SpanId),
	/**
	 * Any timestamp from the trace (e.g. parent log/span). When provided, the
	 * query is bounded to a ±1h window around this so ClickHouse can prune
	 * partitions instead of scanning full retention.
	 */
	timestamp: Schema.optional(Schema.String),
})

export type GetSpanHierarchyInput = Schema.Schema.Type<typeof GetSpanHierarchyInputSchema>

export function getSpanHierarchy({ data }: { data: GetSpanHierarchyInput }) {
	return getSpanHierarchyEffect({ data })
}

const getSpanHierarchyEffect = Effect.fn("QueryEngine.getSpanHierarchy")(function* ({
	data,
}: {
	data: GetSpanHierarchyInput
}) {
	const input = yield* decodeInput(GetSpanHierarchyInputSchema, data, "getSpanHierarchy")

	yield* Effect.annotateCurrentSpan("traceId", input.traceId)
	if (input.spanId) yield* Effect.annotateCurrentSpan("spanId", input.spanId)

	const range = computeTraceTimeWindow(input.timestamp)

	const result = yield* runWarehouseQuery("spanHierarchy", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.spanHierarchy({
				payload: new SpanHierarchyRequest({
					traceId: input.traceId,
					spanId: input.spanId,
					...(range && { startTime: range.startTime, endTime: range.endTime }),
				}),
			})
		}),
	)

	const spans = dedupeBySpanId(result.data.map((raw) => transformSpan(raw as SpanHierarchyRow)))
	const rootSpans = buildSpanTree(spans)
	const totalDurationMs = spans.length > 0 ? Math.max(...spans.map((span) => span.durationMs)) : 0

	return {
		traceId: input.traceId,
		spans,
		rootSpans,
		totalDurationMs,
	}
})

// ---------------------------------------------------------------------------
// Span detail — full attribute maps for a single span, loaded on demand.
// The hierarchy query intentionally returns only trimmed maps (the keys the
// tree views render); the detail panel fetches the full maps lazily for the
// one selected span.
// ---------------------------------------------------------------------------

const GetSpanDetailInputSchema = Schema.Struct({
	traceId: TraceId,
	spanId: SpanId,
	/** Any timestamp inside the trace — narrows the partition scan to ±1h. */
	timestamp: Schema.optional(Schema.String),
})

export type GetSpanDetailInput = Schema.Schema.Type<typeof GetSpanDetailInputSchema>

export interface SpanDetailResult {
	spanAttributes: Record<string, string>
	resourceAttributes: Record<string, string>
}

export function getSpanDetail({ data }: { data: GetSpanDetailInput }) {
	return getSpanDetailEffect({ data })
}

const getSpanDetailEffect = Effect.fn("QueryEngine.getSpanDetail")(function* ({
	data,
}: {
	data: GetSpanDetailInput
}) {
	const input = yield* decodeInput(GetSpanDetailInputSchema, data, "getSpanDetail")

	yield* Effect.annotateCurrentSpan("traceId", input.traceId)
	yield* Effect.annotateCurrentSpan("spanId", input.spanId)

	const range = computeTraceTimeWindow(input.timestamp)

	const result = yield* runWarehouseQuery("spanDetail", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.spanDetail({
				payload: new SpanDetailRequest({
					traceId: input.traceId,
					spanId: input.spanId,
					...(range && { startTime: range.startTime, endTime: range.endTime }),
				}),
			})
		}),
	)

	return {
		spanAttributes: parseAttributes(result.data?.spanAttributes),
		resourceAttributes: parseAttributes(result.data?.resourceAttributes),
	} satisfies SpanDetailResult
})

interface FacetItem {
	name: string
	count: number
}

interface TracesFacets {
	services: FacetItem[]
	spanNames: FacetItem[]
	httpMethods: FacetItem[]
	httpStatusCodes: FacetItem[]
	deploymentEnvs: FacetItem[]
	namespaces: FacetItem[]
	errorCount: number
	durationStats: {
		minDurationMs: number
		maxDurationMs: number
		p50DurationMs: number
		p95DurationMs: number
	}
}

export interface TracesFacetsResponse {
	data: TracesFacets
}

const GetTracesFacetsInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	service: Schema.optional(ServiceName),
	spanName: Schema.optional(SpanName),
	hasError: Schema.optional(Schema.Boolean),
	minDurationMs: Schema.optional(Schema.Number),
	maxDurationMs: Schema.optional(Schema.Number),
	httpMethod: Schema.optional(Schema.String),
	httpStatusCode: Schema.optional(Schema.String),
	deploymentEnv: Schema.optional(DeploymentEnvironment),
	namespace: Schema.optional(ServiceNamespace),
	attributeFilters: Schema.optional(Schema.Array(AttributeFilterInput)),
	resourceAttributeFilters: Schema.optional(Schema.Array(AttributeFilterInput)),
	serviceMatchMode: ContainsMatchMode,
	spanNameMatchMode: ContainsMatchMode,
	deploymentEnvMatchMode: ContainsMatchMode,
	namespaceMatchMode: ContainsMatchMode,
})

export type GetTracesFacetsInput = (typeof GetTracesFacetsInputSchema)["Encoded"]
type GetTracesFacetsDecoded = (typeof GetTracesFacetsInputSchema)["Type"]

function buildTracesFiltersFromInput(input: GetTracesFacetsDecoded) {
	const attributeFilters = buildAttributeFilters(input as ListTracesDecoded)
	const resourceAttributeFilters = buildResourceAttributeFilters(input as ListTracesDecoded)
	const matchModes: Record<string, string> = {}
	if (input.serviceMatchMode === "contains") matchModes.serviceName = "contains"
	if (input.spanNameMatchMode === "contains") matchModes.spanName = "contains"
	if (input.deploymentEnvMatchMode === "contains") matchModes.deploymentEnv = "contains"
	if (input.namespaceMatchMode === "contains") matchModes.serviceNamespace = "contains"

	return {
		serviceName: input.service,
		spanName: input.spanName,
		errorsOnly: input.hasError,
		minDurationMs: input.minDurationMs,
		maxDurationMs: input.maxDurationMs,
		environments: input.deploymentEnv ? [input.deploymentEnv] : undefined,
		namespaces: input.namespace ? [input.namespace] : undefined,
		matchModes: Object.keys(matchModes).length > 0 ? matchModes : undefined,
		attributeFilters: attributeFilters.length > 0 ? attributeFilters : undefined,
		resourceAttributeFilters: resourceAttributeFilters.length > 0 ? resourceAttributeFilters : undefined,
	}
}

export function getTracesFacets({ data }: { data: GetTracesFacetsInput }) {
	return getTracesFacetsEffect({ data })
}

const getTracesFacetsEffect = Effect.fn("QueryEngine.getTracesFacets")(function* ({
	data,
}: {
	data: GetTracesFacetsInput
}) {
	const input = yield* decodeInput(GetTracesFacetsInputSchema, data ?? {}, "getTracesFacets")

	if (input.service) yield* Effect.annotateCurrentSpan("service", input.service)

	const filters = buildTracesFiltersFromInput(input)
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const startTime = input.startTime ?? fallback.startTime
	const endTime = input.endTime ?? fallback.endTime

	const [facetsResponse, statsResponse] = yield* Effect.all([
		executeQueryEngine(
			"queryEngine.getTracesFacets",
			new QueryEngineExecuteRequest({
				startTime,
				endTime,
				query: { kind: "facets" as const, source: "traces" as const, filters },
			}),
		),
		executeQueryEngine(
			"queryEngine.getTracesDurationStats",
			new QueryEngineExecuteRequest({
				startTime,
				endTime,
				query: { kind: "stats" as const, source: "traces" as const, filters },
			}),
		),
	])

	const facetsData = extractFacets(facetsResponse)
	const statsData = extractStats(statsResponse)

	const toItem = (row: { name: string; count: number }): FacetItem => ({
		name: row.name,
		count: Number(row.count),
	})
	const byType = (type: string) => facetsData.filter((r) => r.facetType === type).map(toItem)
	const errorRow = facetsData.find((r) => r.facetType === "errorCount")

	return {
		data: {
			services: byType("service"),
			spanNames: byType("spanName"),
			httpMethods: byType("httpMethod"),
			httpStatusCodes: byType("httpStatus"),
			deploymentEnvs: byType("deploymentEnv"),
			namespaces: byType("serviceNamespace"),
			errorCount: errorRow ? Number(errorRow.count) : 0,
			durationStats: statsData,
		} satisfies TracesFacets,
	}
})

// Single facet list for dashboard variables: compiles only the requested UNION
// branch server-side and skips the duration-stats companion query, instead of
// the full multi-facet scan `getTracesFacets` runs for the traces sidebar.
const GetTracesFacetValuesInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	facet: TracesFacetDimension,
})

export type GetTracesFacetValuesInput = (typeof GetTracesFacetValuesInputSchema)["Encoded"]

export function getTracesFacetValues({ data }: { data: GetTracesFacetValuesInput }) {
	return getTracesFacetValuesEffect({ data })
}

const getTracesFacetValuesEffect = Effect.fn("QueryEngine.getTracesFacetValues")(function* ({
	data,
}: {
	data: GetTracesFacetValuesInput
}) {
	const input = yield* decodeInput(GetTracesFacetValuesInputSchema, data ?? {}, "getTracesFacetValues")

	yield* Effect.annotateCurrentSpan("facet", input.facet)

	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const response = yield* executeQueryEngine(
		"queryEngine.getTracesFacetValues",
		new QueryEngineExecuteRequest({
			startTime: input.startTime ?? fallback.startTime,
			endTime: input.endTime ?? fallback.endTime,
			query: { kind: "facets" as const, source: "traces" as const, facet: input.facet },
		}),
	)

	return {
		data: extractFacets(response)
			.filter((row) => row.facetType === input.facet)
			.map((row): FacetItem => ({ name: row.name, count: Number(row.count) })),
	}
})

export function getTracesDurationStats({ data }: { data: GetTracesFacetsInput }) {
	return getTracesDurationStatsEffect({ data })
}

const getTracesDurationStatsEffect = Effect.fn("QueryEngine.getTracesDurationStats")(function* ({
	data,
}: {
	data: GetTracesFacetsInput
}) {
	const input = yield* decodeInput(GetTracesFacetsInputSchema, data ?? {}, "getTracesDurationStats")
	const filters = buildTracesFiltersFromInput(input)
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)

	const response = yield* executeQueryEngine(
		"queryEngine.getTracesDurationStats",
		new QueryEngineExecuteRequest({
			startTime: input.startTime ?? fallback.startTime,
			endTime: input.endTime ?? fallback.endTime,
			query: { kind: "stats" as const, source: "traces" as const, filters },
		}),
	)

	return {
		data: [extractStats(response)],
	}
})

const GetSpanAttributeKeysInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
})

export type GetSpanAttributeKeysInput = Schema.Schema.Type<typeof GetSpanAttributeKeysInputSchema>

export function getSpanAttributeKeys({ data }: { data: GetSpanAttributeKeysInput }) {
	return getSpanAttributeKeysEffect({ data })
}

const defaultTimeRange = (nowMillis: number) => {
	const fmt = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19)
	return { startTime: fmt(nowMillis - 24 * 60 * 60 * 1000), endTime: fmt(nowMillis) }
}

const getSpanAttributeKeysEffect = Effect.fn("QueryEngine.getSpanAttributeKeys")(function* ({
	data,
}: {
	data: GetSpanAttributeKeysInput
}) {
	const input = yield* decodeInput(GetSpanAttributeKeysInputSchema, data ?? {}, "getSpanAttributeKeys")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const request = new QueryEngineExecuteRequest({
		startTime: input.startTime ?? fallback.startTime,
		endTime: input.endTime ?? fallback.endTime,
		query: { kind: "attributeKeys" as const, source: "traces" as const, scope: "span" as const },
	})
	const response = yield* executeQueryEngine("queryEngine.getSpanAttributeKeys", request)
	const result = response.result
	if (result.kind !== "attributeKeys") return { data: [] }

	return {
		data: result.data.map((row) => ({
			attributeKey: row.key,
			usageCount: Number(row.count),
		})),
	}
})

const GetSpanAttributeValuesInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	attributeKey: Schema.String,
})

export type GetSpanAttributeValuesInput = Schema.Schema.Type<typeof GetSpanAttributeValuesInputSchema>

export function getSpanAttributeValues({ data }: { data: GetSpanAttributeValuesInput }) {
	return getSpanAttributeValuesEffect({ data })
}

const getSpanAttributeValuesEffect = Effect.fn("QueryEngine.getSpanAttributeValues")(function* ({
	data,
}: {
	data: GetSpanAttributeValuesInput
}) {
	const input = yield* decodeInput(GetSpanAttributeValuesInputSchema, data ?? {}, "getSpanAttributeValues")

	yield* Effect.annotateCurrentSpan("attributeKey", input.attributeKey)

	if (!input.attributeKey) {
		return { data: [] }
	}

	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const response = yield* executeQueryEngine(
		"queryEngine.getSpanAttributeValues",
		new QueryEngineExecuteRequest({
			startTime: input.startTime ?? fallback.startTime,
			endTime: input.endTime ?? fallback.endTime,
			query: {
				kind: "attributeValues" as const,
				source: "traces" as const,
				scope: "span" as const,
				attributeKey: input.attributeKey,
			},
		}),
	)

	return {
		data: extractAttributeValues(response).map((row) => ({
			attributeValue: row.value,
			usageCount: Number(row.count),
		})),
	}
})

const GetResourceAttributeKeysInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
})

export type GetResourceAttributeKeysInput = Schema.Schema.Type<typeof GetResourceAttributeKeysInputSchema>

export function getResourceAttributeKeys({ data }: { data: GetResourceAttributeKeysInput }) {
	return getResourceAttributeKeysEffect({ data })
}

const getResourceAttributeKeysEffect = Effect.fn("QueryEngine.getResourceAttributeKeys")(function* ({
	data,
}: {
	data: GetResourceAttributeKeysInput
}) {
	const input = yield* decodeInput(
		GetResourceAttributeKeysInputSchema,
		data ?? {},
		"getResourceAttributeKeys",
	)
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const request = new QueryEngineExecuteRequest({
		startTime: input.startTime ?? fallback.startTime,
		endTime: input.endTime ?? fallback.endTime,
		query: { kind: "attributeKeys" as const, source: "traces" as const, scope: "resource" as const },
	})
	const response = yield* executeQueryEngine("queryEngine.getResourceAttributeKeys", request)
	const result = response.result
	if (result.kind !== "attributeKeys") return { data: [] }

	return {
		data: result.data.map((row) => ({
			attributeKey: row.key,
			usageCount: Number(row.count),
		})),
	}
})

const GetResourceAttributeValuesInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	attributeKey: Schema.String,
})

export type GetResourceAttributeValuesInput = Schema.Schema.Type<typeof GetResourceAttributeValuesInputSchema>

export function getResourceAttributeValues({ data }: { data: GetResourceAttributeValuesInput }) {
	return getResourceAttributeValuesEffect({ data })
}

const getResourceAttributeValuesEffect = Effect.fn("QueryEngine.getResourceAttributeValues")(function* ({
	data,
}: {
	data: GetResourceAttributeValuesInput
}) {
	const input = yield* decodeInput(
		GetResourceAttributeValuesInputSchema,
		data ?? {},
		"getResourceAttributeValues",
	)

	yield* Effect.annotateCurrentSpan("attributeKey", input.attributeKey)

	if (!input.attributeKey) {
		return { data: [] }
	}

	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const response = yield* executeQueryEngine(
		"queryEngine.getResourceAttributeValues",
		new QueryEngineExecuteRequest({
			startTime: input.startTime ?? fallback.startTime,
			endTime: input.endTime ?? fallback.endTime,
			query: {
				kind: "attributeValues" as const,
				source: "traces" as const,
				scope: "resource" as const,
				attributeKey: input.attributeKey,
			},
		}),
	)

	return {
		data: extractAttributeValues(response).map((row) => ({
			attributeValue: row.value,
			usageCount: Number(row.count),
		})),
	}
})
