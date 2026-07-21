// The shared operation surface — thin wrappers over @maple/query-engine
// observability functions, parameterised by simple request objects. The CLI
// commands call these. Every operation returns an Effect requiring
// `WarehouseExecutor` (provided by the local executor layer).

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
import { WarehouseClientError } from "@maple/domain/http/warehouse-errors"
import { executeLocalQuery } from "@maple/query-engine/local"
import { fingerprintSql, mapWarehouseError, SQL_TRACE_MAX, truncateSql } from "@maple/query-engine/execution"
import { Mode } from "./mode"
import type { Range } from "./time"

type AttrSource = "traces" | "metrics" | "services"
type AttrScope = "span" | "resource"

export const listServices = (p: { range: Range; environment?: string }) =>
	obsListServices({ timeRange: p.range, environment: p.environment })

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
	})

export const inspectTrace = (p: { traceId: string }) => obsInspectTrace(p.traceId)

export const findErrors = (p: { range: Range; service?: string; environment?: string; limit?: number }) =>
	obsFindErrors({ timeRange: p.range, service: p.service, environment: p.environment, limit: p.limit })

export const errorDetail = (p: { fingerprintHash: string; range: Range; service?: string; limit?: number }) =>
	obsErrorDetail({
		fingerprintHash: p.fingerprintHash,
		timeRange: p.range,
		service: p.service,
		includeTimeseries: true,
		limit: p.limit,
	})

export const diagnoseService = (p: { serviceName: string; range: Range; environment?: string }) =>
	obsDiagnoseService({ serviceName: p.serviceName, timeRange: p.range, environment: p.environment })

export const searchLogs = (p: {
	range: Range
	service?: string
	severity?: string
	search?: string
	traceId?: string
	limit?: number
	offset?: number
}) =>
	obsSearchLogs({
		timeRange: p.range,
		service: p.service,
		severity: p.severity,
		search: p.search,
		traceId: p.traceId,
		limit: p.limit,
		offset: p.offset,
	})

export const mineLogPatterns = (p: {
	range: Range
	service?: string
	severity?: string
	search?: string
	limit?: number
}) =>
	obsMineLogPatterns({
		timeRange: p.range,
		service: p.service,
		severity: p.severity,
		search: p.search,
		limit: p.limit,
	})

export const findSlowTraces = (p: { range: Range; service?: string; environment?: string; limit?: number }) =>
	obsFindSlowTraces({ timeRange: p.range, service: p.service, environment: p.environment, limit: p.limit })

export const serviceMap = (p: { range: Range; service?: string; environment?: string }) =>
	obsServiceMap({ timeRange: p.range, service: p.service, environment: p.environment })

export const attributeKeys = (p: {
	source: AttrSource
	scope?: AttrScope
	service?: string
	range: Range
	limit?: number
}) =>
	obsAttributeKeys({
		source: p.source,
		scope: p.scope,
		service: p.service,
		timeRange: p.range,
		limit: p.limit,
	})

export const attributeValues = (p: {
	key: string
	source: AttrSource
	scope?: AttrScope
	service?: string
	range: Range
	limit?: number
}) =>
	obsAttributeValues({
		source: p.source,
		scope: p.scope,
		key: p.key,
		service: p.service,
		timeRange: p.range,
		limit: p.limit,
	})

export const topOperations = (p: {
	serviceName: string
	metric: TracesMetric
	range: Range
	limit?: number
}) => obsTopOperations({ serviceName: p.serviceName, metric: p.metric, timeRange: p.range, limit: p.limit })

export const listMetrics = (p: { range: Range; service?: string; search?: string; limit?: number }) =>
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const result = yield* executor.query("list_metrics", {
			start_time: p.range.startTime,
			end_time: p.range.endTime,
			...(p.service ? { service: p.service } : {}),
			...(p.search ? { search: p.search } : {}),
			limit: p.limit ?? 100,
		})
		return result.data
	})

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
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const result = yield* executor.query("custom_traces_timeseries", {
			start_time: p.range.startTime,
			end_time: p.range.endTime,
			...(p.bucketSeconds ? { bucket_seconds: p.bucketSeconds } : {}),
			...(p.service ? { service_name: p.service } : {}),
			...(p.spanName ? { span_name: p.spanName } : {}),
			...(p.errorsOnly ? { errors_only: "1" } : {}),
			...(p.environment ? { environments: p.environment } : {}),
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
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const result = yield* executor.query("custom_traces_breakdown", {
			start_time: p.range.startTime,
			end_time: p.range.endTime,
			limit: p.limit ?? 10,
			...(p.service ? { service_name: p.service } : {}),
			...(p.spanName ? { span_name: p.spanName } : {}),
			...(p.errorsOnly ? { errors_only: "1" } : {}),
			...(p.environment ? { environments: p.environment } : {}),
			...groupByParam(p.groupBy ?? "service"),
		})
		return result.data
	})

export const compareServiceOverview = (p: { current: Range; previous: Range; environment?: string }) =>
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const result = yield* executor.query("service_overview_compare", {
			current_start_time: p.current.startTime,
			current_end_time: p.current.endTime,
			previous_start_time: p.previous.startTime,
			previous_end_time: p.previous.endTime,
			...(p.environment ? { environments: p.environment } : {}),
		})
		return result.data
	})
