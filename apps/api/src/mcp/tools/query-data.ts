import {
	McpQueryError,
	optionalBooleanParam,
	optionalNumberParam,
	optionalStringParam,
	validationError,
	type McpToolRegistrar,
	type McpToolResult,
} from "./types"
import { resolveTimeRange } from "../lib/time"
import { Effect, Match, Schema } from "effect"
import { resolveTenant } from "@/mcp/lib/query-warehouse"
import { QueryEngineService } from "@/services/QueryEngineService"
import {
	MetricType,
	QuerySpec,
	type TracesFilters,
	type LogsFilters,
	type MetricsFilters,
	type QuerySpec as QuerySpecType,
	type TracesTimeseriesQuery,
	type TracesBreakdownQuery,
	type LogsTimeseriesQuery,
	type LogsBreakdownQuery,
	type MetricsTimeseriesQuery,
	type MetricsBreakdownQuery,
} from "@maple/query-engine"
import { formatQueryResult } from "../lib/format-query-result"
import { warehouseErrorText, warehouseHandlers } from "../lib/map-warehouse-error"
import {
	CommitSha,
	DeploymentEnvironment,
	MetricName,
	ServiceName,
	SpanName,
	type QueryDataQueryContext,
} from "@maple/domain"

const asServiceName = Schema.decodeUnknownSync(ServiceName)
const asSpanName = Schema.decodeUnknownSync(SpanName)
const asDeploymentEnvironment = Schema.decodeUnknownSync(DeploymentEnvironment)
const asCommitSha = Schema.decodeUnknownSync(CommitSha)
const asMetricName = Schema.decodeUnknownSync(MetricName)

const queryDataSchema = Schema.Struct({
	source: Schema.Literals(["traces", "logs", "metrics"]).annotate({
		description:
			"Data source. Use 'traces' for request/span analysis (latency, errors, throughput). " +
			"Use 'logs' for log volume analysis. " +
			"Use 'metrics' for custom metric aggregation (requires metric_name and metric_type — call list_metrics first).",
	}),
	kind: Schema.Literals(["timeseries", "breakdown"]).annotate({
		description:
			"Query shape. Use 'timeseries' when the user asks about trends, patterns, or 'how has X changed over time'. " +
			"Use 'breakdown' when asking about top-N, distribution, or 'which services have the most errors'. " +
			"Pick the right kind first — do not call this tool twice for the same question.",
	}),
	metric: optionalStringParam(
		"Metric to compute. Traces: count (request volume), avg_duration, p50_duration, p95_duration, p99_duration (latency), " +
			"error_rate (0-1 ratio), apdex (user satisfaction, requires apdex_threshold_ms). Logs: count only. " +
			"Metrics: avg, sum, min, max, count, rate, increase. For monotonic counters (typically metric_type=sum with isMonotonic=true from list_metrics), prefer rate or increase over raw sum. Default: 'count' for traces/logs, 'avg' for metrics.",
	),
	group_by: optionalStringParam(
		"Grouping dimension. Traces: service, span_name, status_code, http_method, attribute, none. " +
			"Logs: service, severity, none. Metrics: service, attribute, none. " +
			"Default: 'none' for timeseries, 'service' for breakdown.",
	),
	start_time: optionalStringParam("Start time (YYYY-MM-DD HH:mm:ss UTC). Defaults to 1 hour ago"),
	end_time: optionalStringParam("End time (YYYY-MM-DD HH:mm:ss UTC). Defaults to now"),
	service_name: optionalStringParam("Filter by service name (use list_services to discover)"),
	// Traces-specific
	span_name: optionalStringParam("Filter by span name (traces only)"),
	root_spans_only: optionalBooleanParam("Only include root spans (traces only)"),
	environments: optionalStringParam(
		"Comma-separated environments to filter (traces only, use explore_attributes source=services to discover)",
	),
	commit_shas: optionalStringParam("Comma-separated commit SHAs to filter (traces only)"),
	apdex_threshold_ms: optionalNumberParam(
		"Apdex threshold in milliseconds (traces only, required for apdex metric)",
	),
	// Logs-specific
	severity: optionalStringParam(
		"Filter by log severity: TRACE, DEBUG, INFO, WARN, ERROR, FATAL (logs only)",
	),
	// Metrics-specific
	metric_name: optionalStringParam(
		"Metric name — required for source=metrics. Use list_metrics to discover available metrics.",
	),
	metric_type: Schema.optional(MetricType).annotate({
		description:
			"Metric type — required for source=metrics. Values: sum, gauge, histogram, exponential_histogram",
	}),
	// Shared attribute filtering
	attribute_key: optionalStringParam(
		"Attribute key for filtering or group_by=attribute. Use explore_attributes to discover keys.",
	),
	attribute_value: optionalStringParam("Attribute value filter (requires attribute_key)"),
	bucket_seconds: optionalNumberParam("Bucket size in seconds (timeseries only, auto-computed if omitted)"),
	limit: optionalNumberParam("Max breakdown rows (breakdown only, default 10, max 100)"),
})

const queryDataDescription =
	"Query timeseries or breakdown data from traces, logs, or metrics. " +
	"Start here for trend analysis, comparisons, and top-N queries. " +
	"For error investigation, prefer find_errors and error_detail. " +
	"For attribute discovery, call explore_attributes first. " +
	"Defaults are applied automatically and shown in the response."

const decodeQuerySpecSync = Schema.decodeUnknownSync(QuerySpec)

const splitCsv = (value: string): Array<string> =>
	value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)

export function registerQueryDataTool(server: McpToolRegistrar) {
	server.tool(
		"query_data",
		queryDataDescription,
		queryDataSchema,
		Effect.fn("McpTool.queryData")(function* (params) {
			const { st, et } = resolveTimeRange(params.start_time, params.end_time)

			// Validate attribute params
			if (params.attribute_value && !params.attribute_key) {
				return validationError(
					"`attribute_value` requires `attribute_key`. Use explore_attributes to discover available keys.",
					'attribute_key="http.method" attribute_value="GET"',
				)
			}

			if (params.group_by === "attribute" && !params.attribute_key) {
				return validationError(
					"`group_by=attribute` requires `attribute_key`. Use explore_attributes to discover available keys.",
					'group_by="attribute" attribute_key="http.method"',
				)
			}

			// Validate metrics-specific required params
			if (params.source === "metrics") {
				if (!params.metric_name || !params.metric_type) {
					return validationError(
						"`source=metrics` requires `metric_name` and `metric_type`. Use list_metrics to discover available metrics.",
						'source="metrics" metric_name="http.server.duration" metric_type="histogram" metric="avg"',
					)
				}
			}

			// Track defaults applied for transparency
			const decisions: string[] = []

			if (!params.start_time) decisions.push(`start_time: defaulted to 1 hour ago (${st})`)
			if (!params.end_time) decisions.push(`end_time: defaulted to now (${et})`)

			const rawSpec: QuerySpecType = Match.value(params.source).pipe(
				Match.when("traces", (): QuerySpecType => {
					const attributeFilters: Array<{
						key: string
						value?: string
						mode: "equals" | "exists"
					}> = []
					if (params.attribute_key) {
						attributeFilters.push({
							key: params.attribute_key,
							...(params.attribute_value
								? { value: params.attribute_value, mode: "equals" as const }
								: { mode: "exists" as const }),
						})
					}

					const filters: TracesFilters = {
						...(params.service_name && { serviceName: asServiceName(params.service_name) }),
						...(params.span_name && { spanName: asSpanName(params.span_name) }),
						...(params.root_spans_only && { rootSpansOnly: params.root_spans_only }),
						...(params.environments && {
							environments: splitCsv(params.environments).map((env) =>
								asDeploymentEnvironment(env),
							),
						}),
						...(params.commit_shas && {
							commitShas: splitCsv(params.commit_shas).map((sha) => asCommitSha(sha)),
						}),
						...(params.group_by === "attribute" &&
							params.attribute_key && { groupByAttributeKeys: [params.attribute_key] }),
						...(attributeFilters.length > 0 && { attributeFilters }),
						...(params.apdex_threshold_ms && { apdexThresholdMs: params.apdex_threshold_ms }),
					}
					const hasFilters = Object.keys(filters).length > 0

					const tracesMetric = (params.metric ?? "count") as TracesTimeseriesQuery["metric"]
					if (!params.metric)
						decisions.push(
							`metric: defaulted to "count" (available: count, avg_duration, p50_duration, p95_duration, p99_duration, error_rate, apdex)`,
						)

					if (params.kind === "timeseries") {
						const groupBy = (params.group_by ? [params.group_by] : ["none"]) as NonNullable<
							TracesTimeseriesQuery["groupBy"]
						>
						if (!params.group_by)
							decisions.push(
								`group_by: defaulted to "none" (available: service, span_name, status_code, http_method, attribute, none)`,
							)
						return {
							kind: "timeseries",
							source: "traces",
							metric: tracesMetric,
							groupBy,
							...(hasFilters && { filters }),
							...(params.bucket_seconds && { bucketSeconds: params.bucket_seconds }),
						} satisfies TracesTimeseriesQuery
					}
					const groupBy = (params.group_by ?? "service") as TracesBreakdownQuery["groupBy"]
					if (!params.group_by)
						decisions.push(
							`group_by: defaulted to "service" (available: service, span_name, status_code, http_method, attribute)`,
						)
					return {
						kind: "breakdown",
						source: "traces",
						metric: tracesMetric,
						groupBy,
						...(hasFilters && { filters }),
						...(params.limit && { limit: params.limit }),
					} satisfies TracesBreakdownQuery
				}),
				Match.when("logs", (): QuerySpecType => {
					if (!params.metric) decisions.push(`metric: fixed to "count" (only option for logs)`)

					const filters: LogsFilters = {
						...(params.service_name && { serviceName: asServiceName(params.service_name) }),
						...(params.severity && { severity: params.severity }),
					}
					const hasFilters = Object.keys(filters).length > 0

					if (params.kind === "timeseries") {
						const groupBy = (params.group_by ? [params.group_by] : ["none"]) as NonNullable<
							LogsTimeseriesQuery["groupBy"]
						>
						if (!params.group_by)
							decisions.push(
								`group_by: defaulted to "none" (available: service, severity, none)`,
							)
						return {
							kind: "timeseries",
							source: "logs",
							metric: "count",
							groupBy,
							...(hasFilters && { filters }),
							...(params.bucket_seconds && { bucketSeconds: params.bucket_seconds }),
						} satisfies LogsTimeseriesQuery
					}
					const groupBy = (params.group_by ?? "service") as LogsBreakdownQuery["groupBy"]
					if (!params.group_by)
						decisions.push(`group_by: defaulted to "service" (available: service, severity)`)
					return {
						kind: "breakdown",
						source: "logs",
						metric: "count",
						groupBy,
						...(hasFilters && { filters }),
						...(params.limit && { limit: params.limit }),
					} satisfies LogsBreakdownQuery
				}),
				Match.when("metrics", (): QuerySpecType => {
					// metric_name presence is enforced by the validation above.
					const metricName = params.metric_name ?? ""
					const metricType = params.metric_type ?? "sum"

					const metricsAttributeFilters: Array<{
						key: string
						value?: string
						mode: "equals" | "exists"
					}> = []
					if (params.group_by !== "attribute" && params.attribute_key) {
						metricsAttributeFilters.push({
							key: params.attribute_key,
							...(params.attribute_value
								? { value: params.attribute_value, mode: "equals" as const }
								: { mode: "exists" as const }),
						})
					}

					const filters: MetricsFilters = {
						metricName: asMetricName(metricName),
						metricType,
						...(params.service_name && { serviceName: asServiceName(params.service_name) }),
						...(params.group_by === "attribute" &&
							params.attribute_key && { groupByAttributeKey: params.attribute_key }),
						...(metricsAttributeFilters.length > 0 && {
							attributeFilters: metricsAttributeFilters,
						}),
					}

					if (!params.metric)
						decisions.push(
							`metric: defaulted to "avg" (available: avg, sum, min, max, count, rate, increase)`,
						)

					if (params.kind === "timeseries") {
						const metricsMetric = (params.metric ?? "avg") as MetricsTimeseriesQuery["metric"]
						const groupBy = (params.group_by ? [params.group_by] : ["none"]) as NonNullable<
							MetricsTimeseriesQuery["groupBy"]
						>
						if (!params.group_by)
							decisions.push(
								`group_by: defaulted to "none" (available: service, attribute, none)`,
							)
						return {
							kind: "timeseries",
							source: "metrics",
							metric: metricsMetric,
							groupBy,
							filters,
							...(params.bucket_seconds && { bucketSeconds: params.bucket_seconds }),
						} satisfies MetricsTimeseriesQuery
					}
					const metricsMetric = (params.metric ?? "avg") as MetricsBreakdownQuery["metric"]
					if (!params.group_by)
						decisions.push(`group_by: defaulted to "service" (available: service, attribute)`)
					return {
						kind: "breakdown",
						source: "metrics",
						metric: metricsMetric,
						groupBy: params.group_by === "attribute" ? "attribute" : "service",
						filters,
						...(params.limit && { limit: params.limit }),
					} satisfies MetricsBreakdownQuery
				}),
				Match.exhaustive,
			)

			const decodedQuery = yield* Effect.try({
				try: () => decodeQuerySpecSync(rawSpec) as QuerySpecType,
				catch: (error) =>
					new McpQueryError({
						message: `Invalid query specification:\n${String(error)}`,
						pipeName: "query_data",
						cause: error,
					}),
			})

			const tenant = yield* resolveTenant
			const queryEngine = yield* QueryEngineService

			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				source: params.source,
				kind: params.kind,
			})

			const taggedErrorResult = (tag: string, message: string, details?: ReadonlyArray<string>) =>
				({
					ok: false as const,
					result: {
						isError: true,
						content: [
							{
								type: "text" as const,
								text: `${tag}: ${message}${details && details.length > 0 ? `\n${details.join("\n")}` : ""}`,
							},
						],
					} satisfies McpToolResult,
				}) as const

			const outcome = yield* queryEngine
				.execute(tenant, {
					startTime: st,
					endTime: et,
					query: decodedQuery,
				})
				.pipe(
					Effect.map((value) => ({ ok: true as const, value })),
					Effect.catchTag("@maple/http/errors/QueryEngineValidationError", (error) =>
						Effect.succeed(taggedErrorResult(error._tag, error.message, error.details)),
					),
					Effect.catchTags({
						"@maple/http/errors/QueryEngineExecutionError": (error) =>
							Effect.succeed(taggedErrorResult(error._tag, error.message)),
						"@maple/http/errors/QueryEngineTimeoutError": (error) =>
							Effect.succeed(taggedErrorResult(error._tag, error.message)),
						// Shared 9-tag warehouse table; warehouseErrorText appends the
						// schema-apply hint for schema drift, matching the other MCP tools.
						...warehouseHandlers((error) =>
							Effect.succeed(taggedErrorResult(error._tag, warehouseErrorText(error))),
						),
					}),
				)

			if (!outcome.ok) {
				return outcome.result
			}

			const queryContext: QueryDataQueryContext = {
				source: params.source,
				...(params.service_name && { serviceName: params.service_name }),
				...(params.span_name && { spanName: params.span_name }),
				...(params.root_spans_only && { rootSpansOnly: params.root_spans_only }),
				...(params.environments && { environments: splitCsv(params.environments) }),
				...(params.commit_shas && { commitShas: splitCsv(params.commit_shas) }),
				...(params.severity && { severity: params.severity }),
				...(params.metric_name && { metricName: params.metric_name }),
				...(params.metric_type && { metricType: params.metric_type }),
				...(params.apdex_threshold_ms && { apdexThresholdMs: params.apdex_threshold_ms }),
				...(params.bucket_seconds && { bucketSeconds: params.bucket_seconds }),
				...(params.limit && { limit: params.limit }),
				...(params.attribute_key && {
					attributeFilters: [
						{
							key: params.attribute_key,
							...(params.attribute_value
								? { value: params.attribute_value, mode: "equals" as const }
								: { mode: "exists" as const }),
						},
					],
				}),
			}

			return formatQueryResult(
				"query_data",
				outcome.value,
				params.source,
				params.kind,
				params.metric,
				st,
				et,
				params.group_by,
				decisions,
				queryContext,
			)
		}),
	)
}
