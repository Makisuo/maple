// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
import { Clock, Effect, Schema } from "effect"
import {
	LogsFacetDimension,
	QueryEngineExecuteRequest,
	coerceLogRow,
	coerceLogRows,
	formatWarehouseDateTime,
	type LogRow,
} from "@maple/query-engine"
import { TraceId } from "@maple/domain"
import {
	DeploymentEnvironment,
	GetLogRequest,
	ListLogsRequest,
	ServiceName,
	ServiceNamespace,
} from "@maple/domain/http"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import {
	WarehouseDateTimeString,
	decodeInput,
	executeQueryEngine,
	extractCount,
	extractFacets,
	runWarehouseQuery,
} from "@/api/warehouse/effect-utils"

const ListLogsInputSchema = Schema.Struct({
	limit: Schema.optional(
		Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1000)),
	),
	service: Schema.optional(ServiceName),
	severity: Schema.optional(Schema.String),
	services: Schema.optional(Schema.Array(ServiceName)),
	severities: Schema.optional(Schema.Array(Schema.String)),
	deploymentEnvs: Schema.optional(Schema.Array(DeploymentEnvironment)),
	namespaces: Schema.optional(Schema.Array(ServiceNamespace)),
	excludedServices: Schema.optional(Schema.Array(ServiceName)),
	excludedSeverities: Schema.optional(Schema.Array(Schema.String)),
	excludedDeploymentEnvs: Schema.optional(Schema.Array(DeploymentEnvironment)),
	excludedNamespaces: Schema.optional(Schema.Array(ServiceNamespace)),
	minSeverity: Schema.optional(
		Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(255)),
	),
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	traceId: Schema.optional(TraceId),
	spanId: Schema.optional(Schema.String),
	cursor: Schema.optional(Schema.String),
	search: Schema.optional(Schema.String),
	deploymentEnv: Schema.optional(DeploymentEnvironment),
	deploymentEnvMatchMode: Schema.optional(Schema.Literal("contains")),
	namespace: Schema.optional(ServiceNamespace),
	namespaceMatchMode: Schema.optional(Schema.Literal("contains")),
})

export type ListLogsInput = (typeof ListLogsInputSchema)["Encoded"]

const DEFAULT_LIMIT = 100

/**
 * A log row as the list renders it. The shape (and `coerceLogRow`) lives in
 * `@maple/query-engine` so the share API's `list_logs` plan produces the same
 * rows this function does; the alias keeps the existing imports.
 */
export type Log = LogRow

export interface LogsResponse {
	data: Log[]
	meta: {
		limit: number
		cursor: string | null
	}
}

export function listLogs({ data }: { data: ListLogsInput }) {
	return listLogsEffect({ data })
}

const listLogsEffect = Effect.fn("QueryEngine.listLogs")(function* ({ data }: { data: ListLogsInput }) {
	const input = yield* decodeInput(ListLogsInputSchema, data ?? {}, "listLogs")
	const limit = input.limit ?? DEFAULT_LIMIT
	const fallback = defaultLogsTimeRange(yield* Clock.currentTimeMillis)

	const logsResult = yield* runWarehouseQuery("listLogs", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.listLogs({
				payload: new ListLogsRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					limit,
					service: input.service,
					severity: input.severity,
					services: input.services,
					severities: input.severities,
					deploymentEnvs: input.deploymentEnvs,
					namespaces: input.namespaces,
					excludedServices: input.excludedServices,
					excludedSeverities: input.excludedSeverities,
					excludedDeploymentEnvs: input.excludedDeploymentEnvs,
					excludedNamespaces: input.excludedNamespaces,
					minSeverity: input.minSeverity,
					traceId: input.traceId,
					spanId: input.spanId,
					cursor: input.cursor,
					search: input.search,
					deploymentEnv: input.deploymentEnv,
					deploymentEnvMatchMode: input.deploymentEnvMatchMode,
					namespace: input.namespace,
					namespaceMatchMode: input.namespaceMatchMode,
				}),
			})
		}),
	)

	const logs = coerceLogRows(logsResult.data)
	const cursor = logs.length === limit && logs.length > 0 ? logs[logs.length - 1].timestamp : null

	return {
		data: logs,
		meta: {
			limit,
			cursor,
		},
	}
})

// Single log lookup — exact-match by composite key, backs the `/logs/$logId`
// shareable detail page. `timestamp` is the raw ClickHouse DateTime64 string
// (sub-second precision), so it is not constrained to WarehouseDateTimeString.

const GetLogInputSchema = Schema.Struct({
	timestamp: Schema.String,
	serviceName: ServiceName,
	traceId: Schema.optional(TraceId),
	spanId: Schema.optional(Schema.String),
})

export type GetLogInput = (typeof GetLogInputSchema)["Encoded"]

export interface GetLogResult {
	data: Log | null
}

export function getLog({ data }: { data: GetLogInput }) {
	return getLogEffect({ data })
}

const getLogEffect = Effect.fn("QueryEngine.getLog")(function* ({ data }: { data: GetLogInput }) {
	const input = yield* decodeInput(GetLogInputSchema, data ?? {}, "getLog")

	const response = yield* runWarehouseQuery("getLog", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.getLog({
				payload: new GetLogRequest({
					timestamp: input.timestamp,
					serviceName: input.serviceName,
					traceId: input.traceId,
					spanId: input.spanId,
				}),
			})
		}),
	)

	return {
		data: response.data.length > 0 ? coerceLogRow(response.data[0]) : null,
	} satisfies GetLogResult
})

export function getLogsCount({ data }: { data: ListLogsInput }) {
	return getLogsCountEffect({ data })
}

const defaultLogsTimeRange = (nowMillis: number) => {
	return {
		startTime: formatWarehouseDateTime(nowMillis - 24 * 60 * 60 * 1000),
		endTime: formatWarehouseDateTime(nowMillis),
	}
}

const getLogsCountEffect = Effect.fn("QueryEngine.getLogsCount")(function* ({
	data,
}: {
	data: ListLogsInput
}) {
	const input = yield* decodeInput(ListLogsInputSchema, data ?? {}, "getLogsCount")
	const fallback = defaultLogsTimeRange(yield* Clock.currentTimeMillis)

	const response = yield* executeQueryEngine(
		"queryEngine.getLogsCount",
		new QueryEngineExecuteRequest({
			startTime: input.startTime ?? fallback.startTime,
			endTime: input.endTime ?? fallback.endTime,
			query: {
				kind: "count" as const,
				source: "logs" as const,
				filters: {
					serviceName: input.service,
					severity: input.severity,
					serviceNames: input.services,
					severities: input.severities,
					traceId: input.traceId,
					search: input.search,
					environments: input.deploymentEnvs?.length
						? input.deploymentEnvs
						: input.deploymentEnv
							? [input.deploymentEnv]
							: undefined,
					deploymentEnvMatchMode: input.deploymentEnvMatchMode,
					namespaces: input.namespaces?.length
						? input.namespaces
						: input.namespace
							? [input.namespace]
							: undefined,
					namespaceMatchMode: input.namespaceMatchMode,
					excludedServiceNames: input.excludedServices,
					excludedSeverities: input.excludedSeverities,
					excludedEnvironments: input.excludedDeploymentEnvs,
					excludedNamespaces: input.excludedNamespaces,
				},
			},
		}),
	)

	return {
		data: [{ total: extractCount(response) }],
	}
})

interface FacetItem {
	name: string
	count: number
}

const GetLogsFacetsInputSchema = Schema.Struct({
	service: Schema.optional(ServiceName),
	severity: Schema.optional(Schema.String),
	deploymentEnv: Schema.optional(DeploymentEnvironment),
	deploymentEnvMatchMode: Schema.optional(Schema.Literal("contains")),
	namespace: Schema.optional(ServiceNamespace),
	namespaceMatchMode: Schema.optional(Schema.Literal("contains")),
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
})

export type GetLogsFacetsInput = (typeof GetLogsFacetsInputSchema)["Encoded"]

export function getLogsFacets({ data }: { data: GetLogsFacetsInput }) {
	return getLogsFacetsEffect({ data })
}

const getLogsFacetsEffect = Effect.fn("QueryEngine.getLogsFacets")(function* ({
	data,
}: {
	data: GetLogsFacetsInput
}) {
	const input = yield* decodeInput(GetLogsFacetsInputSchema, data ?? {}, "getLogsFacets")
	const fallback = defaultLogsTimeRange(yield* Clock.currentTimeMillis)

	const response = yield* executeQueryEngine(
		"queryEngine.getLogsFacets",
		new QueryEngineExecuteRequest({
			startTime: input.startTime ?? fallback.startTime,
			endTime: input.endTime ?? fallback.endTime,
			query: {
				kind: "facets" as const,
				source: "logs" as const,
				filters: {
					serviceName: input.service,
					severity: input.severity,
					environments: input.deploymentEnv ? [input.deploymentEnv] : undefined,
					deploymentEnvMatchMode: input.deploymentEnvMatchMode,
					namespaces: input.namespace ? [input.namespace] : undefined,
					namespaceMatchMode: input.namespaceMatchMode,
				},
			},
		}),
	)

	const facetsData = extractFacets(response)
	const services: FacetItem[] = []
	const severities: FacetItem[] = []
	const deploymentEnvs: FacetItem[] = []
	const namespaces: FacetItem[] = []

	for (const row of facetsData) {
		const count = Number(row.count)
		if (row.facetType === "service" && row.name) {
			services.push({ name: row.name, count })
		} else if (row.facetType === "severity" && row.name) {
			severities.push({ name: row.name, count })
		} else if (row.facetType === "deploymentEnv" && row.name) {
			deploymentEnvs.push({ name: row.name, count })
		} else if (row.facetType === "namespace" && row.name) {
			namespaces.push({ name: row.name, count })
		}
	}

	return {
		data: { services, severities, deploymentEnvs, namespaces },
	}
})

// Single facet list for dashboard variables: compiles only the requested UNION
// branch server-side instead of the full four-facet scan `getLogsFacets` runs
// for the logs sidebar.
const GetLogsFacetValuesInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	facet: LogsFacetDimension,
})

export type GetLogsFacetValuesInput = (typeof GetLogsFacetValuesInputSchema)["Encoded"]

export function getLogsFacetValues({ data }: { data: GetLogsFacetValuesInput }) {
	return getLogsFacetValuesEffect({ data })
}

const getLogsFacetValuesEffect = Effect.fn("QueryEngine.getLogsFacetValues")(function* ({
	data,
}: {
	data: GetLogsFacetValuesInput
}) {
	const input = yield* decodeInput(GetLogsFacetValuesInputSchema, data ?? {}, "getLogsFacetValues")

	yield* Effect.annotateCurrentSpan("facet", input.facet)

	const fallback = defaultLogsTimeRange(yield* Clock.currentTimeMillis)
	const response = yield* executeQueryEngine(
		"queryEngine.getLogsFacetValues",
		new QueryEngineExecuteRequest({
			startTime: input.startTime ?? fallback.startTime,
			endTime: input.endTime ?? fallback.endTime,
			query: { kind: "facets" as const, source: "logs" as const, facet: input.facet },
		}),
	)

	return {
		data: extractFacets(response)
			.filter((row) => row.facetType === input.facet && row.name)
			.map((row): FacetItem => ({ name: row.name, count: Number(row.count) })),
	}
})

// Backed by `log_attribute_keys_mv` and `log_attribute_values_mv` →
// `attribute_keys_hourly` / `attribute_values_hourly`. Reads the rollup, not
// the raw `logs` table — autocomplete on log attribute name/value stays fast
// regardless of tenant log volume.

const GetLogAttributeKeysInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
})

export type GetLogAttributeKeysInput = Schema.Schema.Type<typeof GetLogAttributeKeysInputSchema>

export function getLogAttributeKeys({ data }: { data: GetLogAttributeKeysInput }) {
	return getLogAttributeKeysEffect({ data })
}

const getLogAttributeKeysEffect = Effect.fn("QueryEngine.getLogAttributeKeys")(function* ({
	data,
}: {
	data: GetLogAttributeKeysInput
}) {
	const input = yield* decodeInput(GetLogAttributeKeysInputSchema, data ?? {}, "getLogAttributeKeys")
	const fallback = defaultLogsTimeRange(yield* Clock.currentTimeMillis)
	const request = new QueryEngineExecuteRequest({
		startTime: input.startTime ?? fallback.startTime,
		endTime: input.endTime ?? fallback.endTime,
		query: { kind: "attributeKeys" as const, source: "logs" as const },
	})
	const response = yield* executeQueryEngine("queryEngine.getLogAttributeKeys", request)
	const result = response.result
	if (result.kind !== "attributeKeys") return { data: [] }

	return {
		data: result.data.map((row) => ({
			attributeKey: row.key,
			usageCount: Number(row.count),
		})),
	}
})
