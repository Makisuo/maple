// Service Endpoints
//
// The HTTP-API view of a service: the same per-operation breakdown as
// `service-operations.ts`, narrowed to HTTP *server* spans and split into
// `method` + `route` so the UI never parses a fused span name — plus a cheap
// profile probe that decides whether a service is an HTTP API at all.
//
// v1 rides the existing rollups. `service_operations_minutely`/`_hourly` store
// the *normalized* span name (`NORMALIZED_SPAN_NAME_SQL`), so an HTTP server
// span is already recorded as "GET /api/users" — the rollup is an endpoint
// rollup in disguise. What it does NOT store is `SpanKind`, so the rollup
// fragments below fall back to matching the name shape:
//
//   - raw edges filter accurately: `SpanKind = 'Server'` AND a non-empty
//     route/url.path/target, the columns that actually exist there;
//   - rollup interiors filter on `match(SpanName, '^(GET|POST|…) /')`.
//
// The known consequence: a non-HTTP span literally named "GET /foo" is counted
// as an endpoint inside the rollup window. A dedicated `service_endpoints_hourly`
// MV keyed (OrgId, Hour, ServiceName, DeploymentEnv, HttpMethod, HttpRoute) and
// filtered to `SpanKind = 'Server'` at write time removes both the name-shape
// heuristic and the string split. THIS FILE IS THE SWAP POINT for that — nothing
// downstream of it knows how the rows are sourced.

import { Schema } from "effect"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param } from "@maple-dev/clickhouse-builder"
import { from, fromUnion, unionAll, type ColumnAccessor } from "@maple-dev/clickhouse-builder"
import { httpDisplaySpanName } from "../../traces-shared"
import { CHNumber } from "../schema"
import { ServiceOperationsHourly, ServiceOperationsMinutely, Traces } from "../tables"
import { tracesBaseWhereConditions } from "./query-helpers"
import { edgeCondition, hourGrain, interiorConditions, minuteGrain } from "./rollup-splice"

/**
 * The verbs `normalizedSpanNameExpr` rewrites into a display name. Kept in sync
 * with `packages/domain/src/tinybird/span-display-name.ts` — a verb missing here
 * is an endpoint the rollup fragments silently drop.
 */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const

/** Matches a stored display name: "<VERB> /path". */
const ENDPOINT_NAME_PATTERN = `^(${HTTP_METHODS.join("|")}) /`

const displaySpanName = ($: ColumnAccessor<typeof Traces.columns>) =>
	httpDisplaySpanName($.SpanName, $.SpanAttributes.get("http.route"), $.SpanAttributes.get("url.path"))

/**
 * "This span served an HTTP request." Uses the columns raw `traces` actually
 * has, so it does not depend on the display-name rewrite. `http.target` is the
 * pre-1.0 semconv spelling of `url.path` and is included for older SDKs.
 */
const httpServerSpanCondition = ($: ColumnAccessor<typeof Traces.columns>) =>
	$.SpanKind.eq("Server").and(
		$.SpanAttributes.get("http.route")
			.neq("")
			.or($.SpanAttributes.get("url.path").neq(""))
			.or($.SpanAttributes.get("http.target").neq("")),
	)

// -- Profile / detection ----------------------------------------------------

export interface ServiceApiProfileOpts {
	serviceName: string
	environments?: readonly string[]
}

export interface ServiceApiProfileOutput {
	readonly httpServerSpans: number
	readonly entrySpans: number
	readonly distinctEndpoints: number
}

export const serviceApiProfileRowSchema = Schema.Struct({
	httpServerSpans: CHNumber,
	entrySpans: CHNumber,
	distinctEndpoints: CHNumber,
})

/**
 * Whether to offer the Endpoints view for a service.
 *
 * Deliberately permissive, and deliberately NOT a ratio: the Endpoints tab is
 * additive (Operations stays), so a false positive costs a thin extra tab while
 * a false negative hides the feature entirely. A worker that also exposes a
 * health endpoint should still get it.
 *
 * The span floor exists only to keep a handful of stray probe requests from
 * turning every background job into an "API".
 */
export const isHttpApiService = (profile: ServiceApiProfileOutput): boolean =>
	profile.distinctEndpoints >= 1 && profile.httpServerSpans >= 20

/**
 * One-row probe: how much of this service's traffic is HTTP server traffic.
 *
 * Callers clamp this to a short recent window (see `serviceApiProfile` in the
 * query registry) — a service that serves HTTP now served HTTP an hour ago, and
 * scanning a year of spans to answer a yes/no question is pure waste.
 */
export function serviceApiProfileQuery(opts: ServiceApiProfileOpts) {
	return from(Traces)
		.select(($) => {
			const isHttpServer = httpServerSpanCondition($)
			return {
				httpServerSpans: CH.countIf(isHttpServer),
				entrySpans: CH.countIf($.IsEntryPoint.eq(1)),
				distinctEndpoints: CH.uniqIf(displaySpanName($), isHttpServer),
			}
		})
		.where(($) =>
			tracesBaseWhereConditions($, {
				serviceName: opts.serviceName,
				environments: opts.environments,
			}),
		)
		.limit(1)
		.format("JSON")
}

// -- Status-class distribution (one endpoint) -------------------------------

export interface EndpointStatusBreakdownOpts {
	serviceName: string
	/** Display span name, e.g. "GET /api/users". */
	spanName: string
	environments?: readonly string[]
}

export interface EndpointStatusBreakdownOutput {
	/** "2xx" | "3xx" | "4xx" | "5xx" | "1xx" | "unknown" */
	readonly statusClass: string
	readonly spanCount: number
	readonly estimatedSpanCount: number
}

export const endpointStatusBreakdownRowSchema = Schema.Struct({
	statusClass: Schema.String,
	spanCount: CHNumber,
	estimatedSpanCount: CHNumber,
})

/**
 * Status classes for one endpoint.
 *
 * Written as a builder here rather than driven through the generic breakdown
 * path (`groupBy: "attribute"`) because that path takes a single attribute key,
 * and HTTP status has two live spellings: `http.response.status_code` (semconv
 * ≥1.0) and `http.status_code` (before it). Coalescing them in SQL — the same
 * precedence `traceListMv` uses — is one query; picking one key is a silent
 * blind spot for every older SDK.
 */
export function endpointStatusBreakdownQuery(opts: EndpointStatusBreakdownOpts) {
	const statusCodeExpr = ($: ColumnAccessor<typeof Traces.columns>) =>
		CH.if_(
			$.SpanAttributes.get("http.response.status_code").neq(""),
			$.SpanAttributes.get("http.response.status_code"),
			$.SpanAttributes.get("http.status_code"),
		)

	return from(Traces)
		.select(($) => {
			const leadingDigit = CH.left_(statusCodeExpr($), CH.lit(1))
			return {
				// `left(code, 1)` classifies without parsing: "503" -> "5" -> "5xx".
				// An absent or non-numeric code lands in "unknown" rather than being
				// dropped, so the classes always sum to the endpoint's throughput.
				statusClass: CH.multiIf(
					[
						[leadingDigit.eq("1"), CH.lit("1xx")],
						[leadingDigit.eq("2"), CH.lit("2xx")],
						[leadingDigit.eq("3"), CH.lit("3xx")],
						[leadingDigit.eq("4"), CH.lit("4xx")],
						[leadingDigit.eq("5"), CH.lit("5xx")],
					],
					CH.lit("unknown"),
				),
				spanCount: CH.count(),
				estimatedSpanCount: CH.sum($.SampleRate),
			}
		})
		.where(($) =>
			tracesBaseWhereConditions($, {
				serviceName: opts.serviceName,
				spanName: opts.spanName,
				environments: opts.environments,
			}),
		)
		.groupBy("statusClass")
		.orderBy(["statusClass", "asc"])
		.limit(10)
		.format("JSON")
}

// -- Endpoint summary -------------------------------------------------------

export interface ServiceEndpointsSummaryOpts {
	serviceName: string
	environments?: readonly string[]
	limit?: number
}

export interface ServiceEndpointsSummaryOutput {
	/** Display span name ("GET /api/users") — the key the /traces `spanNames` filter accepts. */
	readonly spanName: string
	readonly method: string
	readonly route: string
	readonly spanCount: number
	readonly estimatedSpanCount: number
	readonly errorCount: number
	readonly estimatedErrorCount: number
	readonly errorRate: number
	readonly avgDurationMs: number
	readonly p50DurationMs: number
	readonly p95DurationMs: number
	readonly p99DurationMs: number
}

/**
 * UInt64 columns (`count`, `countIf`) arrive as JSON strings from BYO
 * ClickHouse; {@link CHNumber} coerces them centrally via `decodeRows`.
 */
export const serviceEndpointsSummaryRowSchema = Schema.Struct({
	spanName: Schema.String,
	method: Schema.String,
	route: Schema.String,
	spanCount: CHNumber,
	estimatedSpanCount: CHNumber,
	errorCount: CHNumber,
	estimatedErrorCount: CHNumber,
	errorRate: CHNumber,
	avgDurationMs: CHNumber,
	p50DurationMs: CHNumber,
	p95DurationMs: CHNumber,
	p99DurationMs: CHNumber,
})

const RAW_DURATION_STATE = "quantilesTDigestState(0.5, 0.95, 0.99)(Duration)"
const ROLLUP_DURATION_STATE = "quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles)"

const mergedDurationQuantile = (index: 1 | 2 | 3) =>
	CH.rawExpr<number>(
		`if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), ${index}) / 1000000, 0)`,
	)

/** `extract` returns the first capture group, so both halves come from one split rule. */
const methodOf = (spanName: CH.Expr<string>) => CH.extract_(spanName, "^([A-Z]+) ")
const routeOf = (spanName: CH.Expr<string>) => CH.extract_(spanName, "^[A-Z]+ (.*)$")

function rollupEnvironmentCondition(
	$: ColumnAccessor<typeof ServiceOperationsMinutely.columns>,
	environments: readonly string[] | undefined,
) {
	return environments?.length ? CH.inList($.DeploymentEnv, environments) : undefined
}

function hourlyEnvironmentCondition(
	$: ColumnAccessor<typeof ServiceOperationsHourly.columns>,
	environments: readonly string[] | undefined,
) {
	return environments?.length ? CH.inList($.DeploymentEnv, environments) : undefined
}

/**
 * All-raw rollback companion, mirroring `serviceOperationsSummaryRawQuery` — the
 * path taken per-org when a cluster is missing the rollup tables (UNKNOWN_TABLE).
 */
export function serviceEndpointsSummaryRawQuery(opts: ServiceEndpointsSummaryOpts) {
	return from(Traces)
		.select(($) => {
			const weight = CH.sum($.SampleRate)
			const errorWeight = CH.sumIf($.SampleRate, $.StatusCode.eq("Error"))
			const name = displaySpanName($)
			return {
				spanName: name,
				method: methodOf(name),
				route: routeOf(name),
				spanCount: CH.count(),
				estimatedSpanCount: weight,
				errorCount: CH.countIf($.StatusCode.eq("Error")),
				estimatedErrorCount: errorWeight,
				errorRate: CH.if_(weight.gt(0), errorWeight.div(weight), CH.lit(0)),
				avgDurationMs: CH.avg($.Duration).div(1_000_000),
				p50DurationMs: CH.quantile(0.5)($.Duration).div(1_000_000),
				p95DurationMs: CH.quantile(0.95)($.Duration).div(1_000_000),
				p99DurationMs: CH.quantile(0.99)($.Duration).div(1_000_000),
			}
		})
		.where(($) => [
			...tracesBaseWhereConditions($, {
				serviceName: opts.serviceName,
				environments: opts.environments,
			}),
			httpServerSpanCondition($),
		])
		.groupBy("spanName", "method", "route")
		.orderBy(["estimatedSpanCount", "desc"])
		.limit(opts.limit ?? 25)
		.format("JSON")
}

export function serviceEndpointsSummaryQuery(opts: ServiceEndpointsSummaryOpts) {
	const rawEdges = from(Traces)
		.select(($) => ({
			bSpanName: displaySpanName($),
			bSpanCount: CH.count(),
			bEstimatedSpanCount: CH.sum($.SampleRate),
			bErrorCount: CH.countIf($.StatusCode.eq("Error")),
			bEstimatedErrorCount: CH.sumIf($.SampleRate, $.StatusCode.eq("Error")),
			bDurationSum: CH.sum(CH.rawExpr<number>("toFloat64(Duration)")),
			bDurationQuantiles: CH.rawExpr<string>(RAW_DURATION_STATE),
		}))
		.where(($) => [
			...tracesBaseWhereConditions($, {
				serviceName: opts.serviceName,
				environments: opts.environments,
			}),
			edgeCondition("Timestamp", minuteGrain),
			// Accurate filter — the raw table has the columns the rollups dropped.
			httpServerSpanCondition($),
		])
		.groupBy("bSpanName")

	const minutelyEdges = from(ServiceOperationsMinutely)
		.select(($) => ({
			bSpanName: $.SpanName,
			bSpanCount: CH.sum($.SpanCount),
			bEstimatedSpanCount: CH.sum($.EstimatedSpanCount),
			bErrorCount: CH.sum($.ErrorCount),
			bEstimatedErrorCount: CH.sum($.EstimatedErrorCount),
			bDurationSum: CH.sum($.DurationSum),
			bDurationQuantiles: CH.rawExpr<string>(ROLLUP_DURATION_STATE),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(opts.serviceName),
			rollupEnvironmentCondition($, opts.environments),
			...interiorConditions($.Minute, minuteGrain),
			edgeCondition("Minute", hourGrain),
			CH.matchCond($.SpanName, ENDPOINT_NAME_PATTERN),
		])
		.groupBy("bSpanName")

	const hourlyInterior = from(ServiceOperationsHourly)
		.select(($) => ({
			bSpanName: $.SpanName,
			bSpanCount: CH.sum($.SpanCount),
			bEstimatedSpanCount: CH.sum($.EstimatedSpanCount),
			bErrorCount: CH.sum($.ErrorCount),
			bEstimatedErrorCount: CH.sum($.EstimatedErrorCount),
			bDurationSum: CH.sum($.DurationSum),
			bDurationQuantiles: CH.rawExpr<string>(ROLLUP_DURATION_STATE),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(opts.serviceName),
			hourlyEnvironmentCondition($, opts.environments),
			...interiorConditions($.Hour, hourGrain),
			CH.matchCond($.SpanName, ENDPOINT_NAME_PATTERN),
		])
		.groupBy("bSpanName")

	return fromUnion(unionAll(rawEdges, minutelyEdges, hourlyInterior), "endpoint_windows")
		.select(($) => {
			const spanCount = CH.sum($.bSpanCount)
			const estimatedSpanCount = CH.sum($.bEstimatedSpanCount)
			const estimatedErrorCount = CH.sum($.bEstimatedErrorCount)
			return {
				spanName: $.bSpanName,
				method: methodOf($.bSpanName),
				route: routeOf($.bSpanName),
				spanCount,
				estimatedSpanCount,
				errorCount: CH.sum($.bErrorCount),
				estimatedErrorCount,
				errorRate: CH.if_(
					estimatedSpanCount.gt(0),
					estimatedErrorCount.div(estimatedSpanCount),
					CH.lit(0),
				),
				avgDurationMs: CH.if_(
					spanCount.gt(0),
					CH.sum($.bDurationSum).div(spanCount).div(1_000_000),
					CH.lit(0),
				),
				p50DurationMs: mergedDurationQuantile(1),
				p95DurationMs: mergedDurationQuantile(2),
				p99DurationMs: mergedDurationQuantile(3),
			}
		})
		.groupBy("spanName", "method", "route")
		.orderBy(["estimatedSpanCount", "desc"])
		.limit(opts.limit ?? 25)
		.format("JSON")
}
