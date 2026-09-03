// The shared operation surface the CLI commands call.
//
// This is also where local and remote diverge. Local mode runs the
// @maple/query-engine observability helpers through `WarehouseExecutor`;
// remote mode calls Maple's public v2 API (see `remote-ops.ts`). The branch
// lives here, at the operation level, rather than behind a shared executor:
// v2 is a resource API with no generic `query(pipeName, params)` to implement,
// so there is nothing for an executor-shaped seam to stand in for.
//
// Every operation returns the same type in both modes, so commands and
// renderers never learn which backend answered.

import { Clock, Effect } from "effect"
import type { TracesMetric } from "@maple/query-engine"
import {
	WarehouseExecutor,
	listServices as obsListServices,
	searchTraces as obsSearchTraces,
	inspectTrace as obsInspectTrace,
	findErrors as obsFindErrors,
	errorDetail as obsErrorDetail,
	diagnoseService as obsDiagnoseService,
	searchLogs as obsSearchLogs,
	mineLogPatterns as obsMineLogPatterns,
	exploreAttributeKeys as obsAttributeKeys,
	exploreAttributeValues as obsAttributeValues,
	serviceMap as obsServiceMap,
	findSlowTraces as obsFindSlowTraces,
	topOperations as obsTopOperations,
} from "@maple/query-engine/observability"
import { WarehouseClientError, WarehouseQueryError } from "@maple/domain/http/warehouse-errors"
import { executeLocalQuery } from "@maple/query-engine/local"
import { fingerprintSql, mapWarehouseError, SQL_TRACE_MAX, truncateSql } from "@maple/query-engine/execution"
import { HttpClient } from "effect/unstable/http"
import { Mode } from "./mode"
import * as Remote from "./remote-ops"
import { makeV2Client, toWarehouseError, unsupportedInRemote } from "./v2-client"
import type { Range } from "./time"

type AttrSource = "traces" | "metrics" | "services"
type AttrScope = "span" | "resource"

const ATTRIBUTE_DISCOVERY_GAP =
	"v2 exposes no attribute-discovery surface — /v2/attribute_mappings is mapping configuration, not the keys and values observed in your telemetry."

/**
 * Resolve the backend once per operation. `local` yields undefined so the
 * caller falls through to the observability helper; `remote` yields a v2
 * client bound to the configured workspace and token.
 */
const remoteClient = Effect.gen(function* () {
	const mode = yield* Mode
	const resolved = yield* mode.resolve.pipe(
		Effect.mapError(
			(error) => new WarehouseClientError({ message: error.message, pipeName: "mode", cause: error }),
		),
	)
	if (resolved._tag === "local") return undefined
	return yield* makeV2Client(resolved.apiUrl, resolved.token)
})

type V2Client = NonNullable<Effect.Success<typeof remoteClient>>

/** Run `remote` against v2 when a workspace is configured, else `local`. */
const dispatch = <A, E, R, E2, R2>(
	local: Effect.Effect<A, E, R>,
	remote: (client: V2Client) => Effect.Effect<A, E2, R2>,
	pipeName: string,
): Effect.Effect<A, E | WarehouseClientError | WarehouseQueryError, R | R2 | Mode | HttpClient.HttpClient> =>
	Effect.flatMap(
		remoteClient,
		(client): Effect.Effect<A, E | WarehouseClientError | WarehouseQueryError, R | R2> =>
			client === undefined ? local : Effect.mapError(remote(client), toWarehouseError(pipeName)),
	)

export const listServices = (p: { range: Range; environment?: string }) =>
	dispatch(
		obsListServices({ timeRange: p.range, environment: p.environment }),
		(client) => Remote.listServices(client, p),
		"service_overview",
	)

export const searchTraces = (p: {
	range: Range
	service?: string
	spanName?: string
	hasError?: boolean
	minDurationMs?: number
	maxDurationMs?: number
	httpMethod?: string
	traceId?: string
	rootOnly?: boolean
	limit?: number
	offset?: number
}) =>
	dispatch(
		obsSearchTraces({
			timeRange: p.range,
			service: p.service,
			spanName: p.spanName,
			spanNameMatchMode: p.spanName ? "contains" : undefined,
			hasError: p.hasError,
			minDurationMs: p.minDurationMs,
			maxDurationMs: p.maxDurationMs,
			httpMethod: p.httpMethod,
			traceId: p.traceId,
			rootOnly: p.rootOnly,
			limit: p.limit,
			offset: p.offset,
		}),
		(client) => Remote.searchTraces(client, p),
		"list_traces",
	)

export const inspectTrace = (p: { traceId: string }) =>
	dispatch(obsInspectTrace(p.traceId), (client) => Remote.inspectTrace(client, p), "span_hierarchy")

export const findErrors = (p: { range: Range; service?: string; environment?: string; limit?: number }) =>
	dispatch(
		obsFindErrors({ timeRange: p.range, service: p.service, environment: p.environment, limit: p.limit }),
		() =>
			unsupportedInRemote(
				"errors_by_type",
				"/v2/error_issues lists one triage issue per fingerprint, so it cannot report how many services an error spans, and it only covers fingerprints a sweep has already turned into issues.",
			),
		"errors_by_type",
	)

export const errorDetail = (p: { fingerprintHash: string; range: Range; service?: string; limit?: number }) =>
	dispatch(
		obsErrorDetail({
			fingerprintHash: p.fingerprintHash,
			timeRange: p.range,
			service: p.service,
			includeTimeseries: true,
			limit: p.limit,
		}),
		(client) => Remote.errorDetail(client, p),
		"error_detail_traces",
	)

export const diagnoseService = (p: { serviceName: string; range: Range; environment?: string }) =>
	dispatch(
		obsDiagnoseService({ serviceName: p.serviceName, timeRange: p.range, environment: p.environment }),
		() =>
			unsupportedInRemote(
				"diagnose",
				"its error breakdown depends on exception-type aggregates that v2 does not expose, so a remote diagnosis would silently omit the errors section.",
			),
		"diagnose",
	)

export const searchLogs = (p: {
	range: Range
	service?: string
	severity?: string
	search?: string
	traceId?: string
	limit?: number
	offset?: number
}) =>
	dispatch(
		obsSearchLogs({
			timeRange: p.range,
			service: p.service,
			severity: p.severity,
			search: p.search,
			traceId: p.traceId,
			limit: p.limit,
			offset: p.offset,
		}),
		(client) => Remote.searchLogs(client, p),
		"list_logs",
	)

export const mineLogPatterns = (p: {
	range: Range
	service?: string
	severity?: string
	search?: string
	limit?: number
}) =>
	dispatch(
		obsMineLogPatterns({
			timeRange: p.range,
			service: p.service,
			severity: p.severity,
			search: p.search,
			limit: p.limit,
		}),
		(client) => Remote.mineLogPatterns(client, p),
		"list_logs",
	)

export const findSlowTraces = (p: { range: Range; service?: string; environment?: string; limit?: number }) =>
	dispatch(
		obsFindSlowTraces({
			timeRange: p.range,
			service: p.service,
			environment: p.environment,
			limit: p.limit,
		}),
		() =>
			unsupportedInRemote(
				"slow_traces",
				"/v2/traces/search can filter by minimum duration but cannot order by it, so the slowest traces cannot be selected.",
			),
		"slow_traces",
	)

export const serviceMap = (p: { range: Range; service?: string; environment?: string }) =>
	dispatch(
		obsServiceMap({ timeRange: p.range, service: p.service, environment: p.environment }),
		(client) => Remote.serviceMap(client, p),
		"service_dependencies",
	)

export const attributeKeys = (p: {
	source: AttrSource
	scope?: AttrScope
	service?: string
	range: Range
	limit?: number
}) =>
	dispatch(
		obsAttributeKeys({
			source: p.source,
			scope: p.scope,
			service: p.service,
			timeRange: p.range,
			limit: p.limit,
		}),
		() => unsupportedInRemote("attribute_keys", ATTRIBUTE_DISCOVERY_GAP),
		"attribute_keys",
	)

export const attributeValues = (p: {
	key: string
	source: AttrSource
	scope?: AttrScope
	service?: string
	range: Range
	limit?: number
}) =>
	dispatch(
		obsAttributeValues({
			source: p.source,
			scope: p.scope,
			key: p.key,
			service: p.service,
			timeRange: p.range,
			limit: p.limit,
		}),
		() => unsupportedInRemote("attribute_values", ATTRIBUTE_DISCOVERY_GAP),
		"attribute_values",
	)

export const topOperations = (p: {
	serviceName: string
	metric: TracesMetric
	range: Range
	limit?: number
}) =>
	dispatch(
		obsTopOperations({
			serviceName: p.serviceName,
			metric: p.metric,
			timeRange: p.range,
			limit: p.limit,
		}),
		() =>
			unsupportedInRemote(
				"top_operations",
				"it reports call count, latency and error rate per operation together, and /v2/traces/breakdown returns one aggregation per request without a combined ranking.",
			),
		"top_operations",
	)

export const listMetrics = (p: { range: Range; service?: string; search?: string; limit?: number }) =>
	dispatch(
		Effect.gen(function* () {
			const executor = yield* WarehouseExecutor
			const result = yield* executor.query("list_metrics", {
				start_time: p.range.startTime,
				end_time: p.range.endTime,
				...(p.service ? { service: p.service } : undefined),
				...(p.search ? { search: p.search } : undefined),
				limit: p.limit ?? 100,
			})
			return result.data
		}),
		(client) => Remote.listMetrics(client, p),
		"list_metrics",
	)

/**
 * Raw SQL escape hatch against the local chDB store — local mode only.
 * Arbitrary user SQL carries no OrgId guarantee, so it deliberately bypasses
 * the warehouse executor (whose `sqlQuery` enforces the OrgId scoping guard)
 * and posts straight to the single-tenant `/local/query` endpoint.
 */
const executeRawLocalQuery = Effect.fn("WarehouseExecutor.rawQuery", { kind: "client" })(function* (
	sql: string,
	baseUrl: string,
) {
	const startedAtMs = yield* Clock.currentTimeMillis
	yield* Effect.annotateCurrentSpan({
		clientSource: "managed",
		"db.client": "clickhouse",
		"db.system.name": "clickhouse",
		"peer.service": "chdb",
		"warehouse.backend": "chdb",
		"warehouse.route": "raw",
		"warehouse.config_source": "managed",
		"db.query.text": truncateSql(sql, SQL_TRACE_MAX),
		"db.query.length": sql.length,
		"db.query.truncated": sql.length > SQL_TRACE_MAX,
		"db.query.fingerprint": fingerprintSql(sql),
		"query.pipe": "rawSqlQuery",
		"query.context": "cli.rawQuery",
	})
	const rows = yield* Effect.tryPromise({
		try: () => executeLocalQuery<Record<string, unknown>>(sql, baseUrl),
		catch: (error) => mapWarehouseError("rawQuery", error),
	}).pipe(
		Effect.tapError(() =>
			Clock.currentTimeMillis.pipe(
				Effect.flatMap((completedAtMs) =>
					Effect.annotateCurrentSpan("db.duration_ms", completedAtMs - startedAtMs),
				),
			),
		),
	)
	yield* Effect.annotateCurrentSpan("result.rowCount", rows.length)
	yield* Effect.annotateCurrentSpan("db.duration_ms", (yield* Clock.currentTimeMillis) - startedAtMs)
	return rows
})

export const rawQuery = (sql: string) =>
	Effect.gen(function* () {
		const mode = yield* Mode
		const resolved = yield* mode.resolve.pipe(
			Effect.mapError(
				(error) =>
					new WarehouseClientError({ message: error.message, pipeName: "rawQuery", cause: error }),
			),
		)
		if (resolved._tag !== "local") {
			return yield* new WarehouseClientError({
				message: "Raw SQL is only available in local mode",
				pipeName: "rawQuery",
			})
		}
		return yield* executeRawLocalQuery(sql, resolved.baseUrl)
	})

// Custom traces analytics share the `group_by_*` presence-flag convention the
// pipe dispatcher expects (see `pipeParamsToTraces*Opts`).
const groupByParam = (groupBy?: string): Record<string, string> => {
	switch (groupBy) {
		case "service":
			return { group_by_service: "1" }
		case "span_name":
			return { group_by_span_name: "1" }
		case "status_code":
			return { group_by_status_code: "1" }
		case "http_method":
			return { group_by_http_method: "1" }
		default:
			return {}
	}
}

export const tracesTimeseries = (p: {
	range: Range
	service?: string
	spanName?: string
	groupBy?: string
	errorsOnly?: boolean
	environment?: string
	bucketSeconds?: number
}) =>
	dispatch(
		localTracesTimeseries(p),
		(client) => Remote.tracesTimeseries(client, p),
		"custom_traces_timeseries",
	)

const localTracesTimeseries = (p: {
	range: Range
	service?: string
	spanName?: string
	groupBy?: string
	errorsOnly?: boolean
	environment?: string
	bucketSeconds?: number
}) =>
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const result = yield* executor.query("custom_traces_timeseries", {
			start_time: p.range.startTime,
			end_time: p.range.endTime,
			...(p.bucketSeconds ? { bucket_seconds: p.bucketSeconds } : undefined),
			...(p.service ? { service_name: p.service } : undefined),
			...(p.spanName ? { span_name: p.spanName } : undefined),
			...(p.errorsOnly ? { errors_only: "1" } : undefined),
			...(p.environment ? { environments: p.environment } : undefined),
			...groupByParam(p.groupBy),
		})
		return result.data
	})

export const tracesBreakdown = (p: {
	range: Range
	service?: string
	spanName?: string
	groupBy?: string
	limit?: number
	errorsOnly?: boolean
	environment?: string
}) =>
	dispatch(
		localTracesBreakdown(p),
		(client) => Remote.tracesBreakdown(client, p),
		"custom_traces_breakdown",
	)

const localTracesBreakdown = (p: {
	range: Range
	service?: string
	spanName?: string
	groupBy?: string
	limit?: number
	errorsOnly?: boolean
	environment?: string
}) =>
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const result = yield* executor.query("custom_traces_breakdown", {
			start_time: p.range.startTime,
			end_time: p.range.endTime,
			limit: p.limit ?? 10,
			...(p.service ? { service_name: p.service } : undefined),
			...(p.spanName ? { span_name: p.spanName } : undefined),
			...(p.errorsOnly ? { errors_only: "1" } : undefined),
			...(p.environment ? { environments: p.environment } : undefined),
			...groupByParam(p.groupBy ?? "service"),
		})
		return result.data
	})

export const compareServiceOverview = (p: { current: Range; previous: Range; environment?: string }) =>
	dispatch(
		localCompareServiceOverview(p),
		() =>
			unsupportedInRemote(
				"service_overview_compare",
				"v2 has no window-comparison endpoint, and diffing two /v2/services calls client-side would lose the server-side weighting the comparison depends on.",
			),
		"service_overview_compare",
	)

const localCompareServiceOverview = (p: { current: Range; previous: Range; environment?: string }) =>
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const result = yield* executor.query("service_overview_compare", {
			current_start_time: p.current.startTime,
			current_end_time: p.current.endTime,
			previous_start_time: p.previous.startTime,
			previous_end_time: p.previous.endTime,
			...(p.environment ? { environments: p.environment } : undefined),
		})
		return result.data
	})
