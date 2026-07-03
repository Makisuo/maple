import type { QueryBuilderQueryDraftPayload } from "@maple/domain/http"
import type { QuerySpec } from "../query-engine"
import { normalizeKey, parseBoolean, parseWhereClause, splitCsv } from "../where-clause"
import { Match } from "effect"

export type QueryBuilderDataSource = "traces" | "logs" | "metrics"
export type QueryBuilderAddOnKey = "groupBy" | "having" | "orderBy" | "limit" | "legend"
export type QueryBuilderMetricType = "sum" | "gauge" | "histogram" | "exponential_histogram"
export type QueryBuilderSignalSource = "default" | "meter"

interface QueryBuilderQueryDraftBase {
	id: string
	name: string
	enabled: boolean
	hidden: boolean
	whereClause: string
	aggregation: string
	stepInterval: string
	orderByDirection: "desc" | "asc"
	addOns: Record<QueryBuilderAddOnKey, boolean>
	groupBy: string[]
	having: string
	orderBy: string
	limit: string
	legend: string
}

export interface TracesQueryDraft extends QueryBuilderQueryDraftBase {
	dataSource: "traces"
}

export interface LogsQueryDraft extends QueryBuilderQueryDraftBase {
	dataSource: "logs"
}

export interface MetricsQueryDraft extends QueryBuilderQueryDraftBase {
	dataSource: "metrics"
	signalSource: QueryBuilderSignalSource
	metricName: string
	metricType: QueryBuilderMetricType
	isMonotonic: boolean
}

export type QueryBuilderQueryDraft = TracesQueryDraft | LogsQueryDraft | MetricsQueryDraft

export interface BuildSpecResult {
	query: QuerySpec | null
	warnings: string[]
	error: string | null
}

export const AGGREGATIONS_BY_SOURCE: Record<
	QueryBuilderDataSource,
	Array<{ label: string; value: string }>
> = {
	traces: [
		{ label: "count", value: "count" },
		{ label: "avg(duration)", value: "avg_duration" },
		{ label: "p50(duration)", value: "p50_duration" },
		{ label: "p95(duration)", value: "p95_duration" },
		{ label: "p99(duration)", value: "p99_duration" },
		{ label: "error_rate", value: "error_rate" },
	],
	logs: [{ label: "count", value: "count" }],
	metrics: [
		{ label: "avg", value: "avg" },
		{ label: "sum", value: "sum" },
		{ label: "min", value: "min" },
		{ label: "max", value: "max" },
		{ label: "count", value: "count" },
		{ label: "rate", value: "rate" },
		{ label: "increase", value: "increase" },
	],
}

const METRICS_AGGREGATIONS_MONOTONIC_SUM = [
	{ label: "rate", value: "rate" },
	{ label: "increase", value: "increase" },
]

const METRICS_AGGREGATIONS_GAUGE_LIKE = [
	{ label: "avg", value: "avg" },
	{ label: "sum", value: "sum" },
	{ label: "min", value: "min" },
	{ label: "max", value: "max" },
	{ label: "count", value: "count" },
]

export function getMetricsAggregations(
	metricType: QueryBuilderMetricType,
	_isMonotonic?: boolean,
): Array<{ label: string; value: string }> {
	// Sum metrics are almost always monotonic counters in OpenTelemetry.
	// Show rate/increase for all Sum metrics by default.
	if (metricType === "sum") {
		return METRICS_AGGREGATIONS_MONOTONIC_SUM
	}
	return METRICS_AGGREGATIONS_GAUGE_LIKE
}

export function resetAggregationForMetricType(
	currentAggregation: string,
	metricType: QueryBuilderMetricType,
	isMonotonic: boolean,
): string {
	const validOptions = getMetricsAggregations(metricType, isMonotonic)
	if (validOptions.some((opt) => opt.value === currentAggregation)) {
		return currentAggregation
	}
	return validOptions[0]?.value ?? "avg"
}

export const QUERY_BUILDER_METRIC_TYPES: readonly QueryBuilderMetricType[] = [
	"sum",
	"gauge",
	"histogram",
	"exponential_histogram",
] as const

export const GROUP_BY_OPTIONS: Record<QueryBuilderDataSource, Array<{ label: string; value: string }>> = {
	traces: [
		{ label: "service.name", value: "service.name" },
		{ label: "span.name", value: "span.name" },
		{ label: "status.code", value: "status.code" },
		{ label: "http.method", value: "http.method" },
		{ label: "none", value: "none" },
	],
	logs: [
		{ label: "service.name", value: "service.name" },
		{ label: "severity", value: "severity" },
		{ label: "none", value: "none" },
	],
	metrics: [
		{ label: "service.name", value: "service.name" },
		{ label: "attr.*", value: "attr." },
		{ label: "resource.*", value: "resource." },
		{ label: "none", value: "none" },
	],
}

const QUERY_BADGE_COLORS = ["bg-chart-1", "bg-chart-2", "bg-chart-4", "bg-chart-5", "bg-chart-3"] as const

export function queryBadgeColor(index: number): string {
	return QUERY_BADGE_COLORS[index % QUERY_BADGE_COLORS.length]
}

function defaultWhereClause(): string {
	return ""
}

export function queryLabel(index: number): string {
	return String.fromCharCode(65 + index)
}

export function formulaLabel(index: number): string {
	return `F${index + 1}`
}

export function createQueryDraft(index: number): TracesQueryDraft {
	const isDefaultErrorRateQuery = index === 0

	return {
		id: crypto.randomUUID(),
		name: queryLabel(index),
		enabled: true,
		hidden: false,
		dataSource: "traces",
		whereClause: defaultWhereClause(),
		aggregation: isDefaultErrorRateQuery ? "error_rate" : "count",
		stepInterval: "",
		orderByDirection: "desc",
		addOns: {
			groupBy: true,
			having: false,
			orderBy: false,
			limit: false,
			legend: false,
		},
		groupBy: ["service.name"],
		having: "",
		orderBy: "",
		limit: "",
		legend: "",
	}
}

export interface QueryBuilderFormulaDraft {
	id: string
	name: string
	expression: string
	legend: string
	hidden: boolean
}

export function createFormulaDraft(index: number, queryNames: string[]): QueryBuilderFormulaDraft {
	const [first = "A", second = "B"] = queryNames

	return {
		id: crypto.randomUUID(),
		name: formulaLabel(index),
		expression: `${first} / ${second}`,
		legend: "Error ratio",
		hidden: false,
	}
}

export function resetQueryForDataSource(
	query: QueryBuilderQueryDraft,
	dataSource: QueryBuilderDataSource,
): QueryBuilderQueryDraft {
	const shared: QueryBuilderQueryDraftBase = {
		id: query.id,
		name: query.name,
		enabled: query.enabled,
		hidden: query.hidden,
		whereClause: query.whereClause,
		aggregation: AGGREGATIONS_BY_SOURCE[dataSource][0].value,
		stepInterval: query.stepInterval,
		orderByDirection: query.orderByDirection,
		addOns: query.addOns,
		groupBy: query.groupBy,
		having: query.having,
		orderBy: query.orderBy,
		limit: query.limit,
		legend: query.legend,
	}

	if (dataSource === "metrics") {
		const prev = query.dataSource === "metrics" ? query : undefined
		return {
			...shared,
			dataSource: "metrics",
			signalSource: prev?.signalSource ?? "default",
			metricName: prev?.metricName ?? "",
			metricType: prev?.metricType ?? "gauge",
			isMonotonic: prev?.isMonotonic ?? false,
		}
	}

	return { ...shared, dataSource }
}

function parseBucketSeconds(raw: string): number | undefined {
	const trimmed = raw.trim().toLowerCase()
	if (!trimmed) return undefined

	const shorthand = trimmed.match(
		/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/,
	)
	if (!shorthand) {
		return undefined
	}

	const amount = Number.parseInt(shorthand[1], 10)
	if (!Number.isFinite(amount) || amount <= 0) {
		return undefined
	}

	const unit = shorthand[2]
	if (!unit || unit.startsWith("s") || unit.startsWith("sec") || unit.startsWith("second")) {
		return amount
	}

	if (unit.startsWith("m") || unit.startsWith("min")) {
		return amount * 60
	}

	if (unit.startsWith("h") || unit.startsWith("hr") || unit.startsWith("hour")) {
		return amount * 60 * 60
	}

	if (unit.startsWith("d") || unit.startsWith("day")) {
		return amount * 60 * 60 * 24
	}

	return undefined
}

// ---------------------------------------------------------------------------
// Clause-to-filter mapping via Match
// ---------------------------------------------------------------------------

interface AccumulatedAttributeFilter {
	key: string
	value?: string
	mode: "equals" | "exists" | "gt" | "gte" | "lt" | "lte" | "contains"
	negated?: boolean
}

interface TracesFilterAccumulator {
	serviceName?: string
	spanName?: string
	rootSpansOnly?: boolean
	errorsOnly?: boolean
	environments?: string[]
	commitShas?: string[]
	attributeFilters: AccumulatedAttributeFilter[]
	groupByAttributeKeys?: string[]
	resourceAttributeFilters: AccumulatedAttributeFilter[]
}

// Maps a parsed where-clause operator to a positive attribute-filter `mode`
// plus a `negated` flag. The CH compiler (`buildAttrFilterCondition`) wraps a
// negated filter in `NOT (...)`, so `!=`/`!contains`/`!exists` reuse the
// positive mode with `negated: true` rather than introducing new modes. This is
// the bug fix for negation silently collapsing into the positive predicate.
function operatorToAttrFilter(operator: string): {
	mode: AccumulatedAttributeFilter["mode"]
	negated: boolean
} {
	return Match.value(operator).pipe(
		Match.when("exists", () => ({ mode: "exists" as const, negated: false })),
		Match.when("!exists", () => ({ mode: "exists" as const, negated: true })),
		Match.when(">", () => ({ mode: "gt" as const, negated: false })),
		Match.when(">=", () => ({ mode: "gte" as const, negated: false })),
		Match.when("<", () => ({ mode: "lt" as const, negated: false })),
		Match.when("<=", () => ({ mode: "lte" as const, negated: false })),
		Match.when("contains", () => ({ mode: "contains" as const, negated: false })),
		Match.when("!contains", () => ({ mode: "contains" as const, negated: true })),
		Match.when("!=", () => ({ mode: "equals" as const, negated: true })),
		Match.orElse(() => ({ mode: "equals" as const, negated: false })),
	)
}

// Builds an accumulated attribute filter from a clause, omitting `value` for the
// value-less `exists`/`!exists` operators and only setting `negated` when true.
function makeAttrFilter(attributeKey: string, operator: string, value: string): AccumulatedAttributeFilter {
	const { mode, negated } = operatorToAttrFilter(operator)
	const hasValue = operator !== "exists" && operator !== "!exists"
	return {
		key: attributeKey,
		mode,
		...(negated ? { negated: true } : {}),
		...(hasValue ? { value } : {}),
	}
}

function applyTracesClause(
	filters: TracesFilterAccumulator,
	clause: { key: string; operator: string; value: string },
	warnings: string[],
): TracesFilterAccumulator {
	const key = normalizeKey(clause.key)

	// Handle attr.* and resource.* prefixes before Match
	if (key.startsWith("attr.")) {
		const attributeKey = key.slice(5)
		if (filters.attributeFilters.length >= 5) {
			warnings.push(`Maximum of 5 attr.* filters supported; ignoring attr.${attributeKey}`)
			return filters
		}
		return {
			...filters,
			attributeFilters: [
				...filters.attributeFilters,
				makeAttrFilter(attributeKey, clause.operator, clause.value),
			],
		}
	}

	if (key.startsWith("resource.")) {
		const resourceKey = key.slice(9)
		if (filters.resourceAttributeFilters.length >= 5) {
			warnings.push(`Maximum of 5 resource.* filters supported; ignoring resource.${resourceKey}`)
			return filters
		}
		return {
			...filters,
			resourceAttributeFilters: [
				...filters.resourceAttributeFilters,
				makeAttrFilter(resourceKey, clause.operator, clause.value),
			],
		}
	}

	return Match.value(key).pipe(
		Match.when("service.name", () => ({ ...filters, serviceName: clause.value })),
		Match.when("span.name", () => ({ ...filters, spanName: clause.value })),
		Match.when("deployment.environment", () => ({
			...filters,
			environments: splitCsv(clause.value),
		})),
		Match.when("deployment.commit_sha", () => ({
			...filters,
			commitShas: splitCsv(clause.value),
		})),
		Match.when("root_only", () => {
			const boolValue = parseBoolean(clause.value)
			if (boolValue == null) {
				warnings.push(`Invalid root_only value ignored: ${clause.value}`)
				return filters
			}
			return { ...filters, rootSpansOnly: boolValue }
		}),
		Match.when("has_error", () => {
			const boolValue = parseBoolean(clause.value)
			if (boolValue == null) {
				warnings.push(`Invalid has_error value ignored: ${clause.value}`)
				return filters
			}
			return { ...filters, errorsOnly: boolValue }
		}),
		Match.orElse(() => {
			// A bare key outside the small structured allowlist is almost always a
			// span attribute (`query.context`, `error.type`, `db.system`, …).
			// Silently dropping the predicate was the #1 "confidently-wrong
			// dashboard" footgun, so treat it as `attr.<key>` — on traces every
			// Map-backed attribute is reachable this way. The only genuine drop
			// left is exceeding the 5-filter cap, which still warns (and is
			// escalated to a hard write error by the widget mutation tools).
			if (filters.attributeFilters.length >= 5) {
				warnings.push(`Maximum of 5 attr.* filters supported; ignoring ${clause.key}`)
				return filters
			}
			return {
				...filters,
				attributeFilters: [
					...filters.attributeFilters,
					makeAttrFilter(key, clause.operator, clause.value),
				],
			}
		}),
	)
}

function applyLogsClause(
	filters: { serviceName?: string; severity?: string },
	clause: { key: string; value: string },
	warnings: string[],
): { serviceName?: string; severity?: string } {
	const key = normalizeKey(clause.key)

	return Match.value(key).pipe(
		Match.when("service.name", () => ({ ...filters, serviceName: clause.value })),
		Match.when("severity", () => ({ ...filters, severity: clause.value })),
		Match.orElse(() => {
			warnings.push(`Unsupported logs filter ignored: ${clause.key}`)
			return filters
		}),
	)
}

interface MetricsFilterAccumulator {
	metricName: string
	metricType: QueryBuilderMetricType
	serviceName?: string
	groupByAttributeKey?: string
	groupByResourceAttributeKey?: string
	resourceAttributeFilters: AccumulatedAttributeFilter[]
}

function applyMetricsClause(
	filters: MetricsFilterAccumulator,
	clause: { key: string; operator: string; value: string },
	warnings: string[],
): MetricsFilterAccumulator {
	const key = normalizeKey(clause.key)

	// Host/pod/node identity on metrics lives in the ResourceAttributes map —
	// `resource.<key>` filters predicate on it (mirrors the traces handler).
	if (key.startsWith("resource.")) {
		const resourceKey = key.slice(9)
		if (filters.resourceAttributeFilters.length >= 5) {
			warnings.push(`Maximum of 5 resource.* filters supported; ignoring resource.${resourceKey}`)
			return filters
		}
		return {
			...filters,
			resourceAttributeFilters: [
				...filters.resourceAttributeFilters,
				makeAttrFilter(resourceKey, clause.operator, clause.value),
			],
		}
	}

	return Match.value(key).pipe(
		Match.when("service.name", () => ({ ...filters, serviceName: clause.value })),
		Match.when("metric.type", () => {
			if (QUERY_BUILDER_METRIC_TYPES.includes(clause.value as QueryBuilderMetricType)) {
				return { ...filters, metricType: clause.value as QueryBuilderMetricType }
			}
			warnings.push(`Invalid metric.type ignored: ${clause.value}`)
			return filters
		}),
		Match.orElse(() => {
			warnings.push(`Unsupported metrics filter ignored: ${clause.key}`)
			return filters
		}),
	)
}

// ---------------------------------------------------------------------------
// Group-by mapping via Match
// ---------------------------------------------------------------------------

type TracesGroupByKey = "service" | "span_name" | "status_code" | "http_method" | "attribute" | "none"

function resolveTracesGroupByToken(
	token: string,
	filters: TracesFilterAccumulator,
	warnings: string[],
	raw: string,
): TracesGroupByKey | null {
	return Match.value(token).pipe(
		// snake_case aliases match the warehouse column spellings — dashboard
		// widget presets (and widgets persisted from them) use those, so
		// dropping them silently broke every preset breakdown (MAP-49).
		Match.whenOr("service", "service.name", "service_name", () => "service" as const),
		Match.whenOr("span", "span.name", "span_name", () => "span_name" as const),
		Match.whenOr("status", "status.code", "status_code", () => "status_code" as const),
		Match.when("http.method", () => "http_method" as const),
		Match.whenOr("none", "all", () => "none" as const),
		Match.orElse((t) => {
			if (t.startsWith("attr.")) {
				const attributeKey = t.slice(5)
				if (!attributeKey) {
					warnings.push("Invalid attr.* group by ignored")
					return null
				}
				if (!filters.groupByAttributeKeys) filters.groupByAttributeKeys = []
				filters.groupByAttributeKeys.push(attributeKey)
				return "attribute" as const
			}
			warnings.push(`Unsupported traces group by ignored: ${raw}`)
			return null
		}),
	)
}

type LogsGroupByKey = "service" | "severity" | "none"

function resolveLogsGroupByToken(token: string, warnings: string[], raw: string): LogsGroupByKey | null {
	return Match.value(token).pipe(
		Match.whenOr("service", "service.name", "service_name", () => "service" as const),
		Match.whenOr("severity", "severity_text", () => "severity" as const),
		Match.whenOr("none", "all", () => "none" as const),
		Match.orElse(() => {
			warnings.push(`Unsupported logs group by ignored: ${raw}`)
			return null
		}),
	)
}

type MetricsGroupByKey = "service" | "attribute" | "resource_attribute" | "none"

function resolveMetricsGroupByToken(
	token: string,
	metricsFilters: {
		metricName: string
		metricType: string
		serviceName?: string
		groupByAttributeKey?: string
		groupByResourceAttributeKey?: string
	},
	warnings: string[],
	raw: string,
): MetricsGroupByKey | null {
	return Match.value(token).pipe(
		Match.whenOr("service", "service.name", () => "service" as const),
		Match.whenOr("none", "all", () => "none" as const),
		Match.orElse((t) => {
			if (t.startsWith("attr.")) {
				const attributeKey = t.slice(5)
				if (!attributeKey) {
					warnings.push("Invalid attr.* group by ignored")
					return null
				}
				metricsFilters.groupByAttributeKey = attributeKey
				return "attribute" as const
			}
			if (t.startsWith("resource.")) {
				const resourceKey = t.slice(9)
				if (!resourceKey) {
					warnings.push("Invalid resource.* group by ignored")
					return null
				}
				metricsFilters.groupByResourceAttributeKey = resourceKey
				return "resource_attribute" as const
			}
			warnings.push(`Unsupported metrics group by ignored: ${raw}`)
			return null
		}),
	)
}

// ---------------------------------------------------------------------------
// Shared resolveGroupBy — used by both the dashboard query builder and the
// alerting compiler so they interpret raw user tokens (`service.name`,
// `attr.<key>`, …) identically.
// ---------------------------------------------------------------------------

export interface ResolvedGroupBy {
	/** Internal QuerySpec groupBy tokens (e.g. "service", "span_name", "attribute"). */
	readonly tokens: ReadonlyArray<string>
	/** Span/metric attribute keys referenced via `attr.<key>` group-by tokens. */
	readonly attributeKeys: ReadonlyArray<string>
	/** Resource attribute keys referenced via `resource.<key>` group-by tokens (metrics only). */
	readonly resourceAttributeKeys: ReadonlyArray<string>
	/** Warnings emitted while resolving (unsupported tokens, malformed input). */
	readonly warnings: ReadonlyArray<string>
}

export function resolveGroupBy(
	source: QueryBuilderDataSource,
	rawTokens: ReadonlyArray<string>,
): ResolvedGroupBy {
	const tokens: string[] = []
	const attributeKeys: string[] = []
	const resourceAttributeKeys: string[] = []
	const warnings: string[] = []
	const seenTokens = new Set<string>()
	const seenAttrKeys = new Set<string>()
	const seenResourceKeys = new Set<string>()

	for (const raw of rawTokens) {
		const token = raw.trim().toLowerCase()
		if (!token) continue

		if (token.startsWith("attr.")) {
			const attributeKey = token.slice(5)
			if (!attributeKey) {
				warnings.push("Invalid attr.* group by ignored")
				continue
			}
			if (source === "logs") {
				warnings.push(`Logs source does not support attr.* group by: ${raw}`)
				continue
			}
			if (!seenAttrKeys.has(attributeKey)) {
				seenAttrKeys.add(attributeKey)
				attributeKeys.push(attributeKey)
			}
			if (!seenTokens.has("attribute")) {
				seenTokens.add("attribute")
				tokens.push("attribute")
			}
			continue
		}

		if (token.startsWith("resource.")) {
			const resourceKey = token.slice(9)
			if (!resourceKey) {
				warnings.push("Invalid resource.* group by ignored")
				continue
			}
			// Only the metrics QuerySpec has a resource_attribute group dimension.
			if (source !== "metrics") {
				warnings.push(`${source} source does not support resource.* group by: ${raw}`)
				continue
			}
			if (!seenResourceKeys.has(resourceKey)) {
				seenResourceKeys.add(resourceKey)
				resourceAttributeKeys.push(resourceKey)
			}
			if (!seenTokens.has("resource_attribute")) {
				seenTokens.add("resource_attribute")
				tokens.push("resource_attribute")
			}
			continue
		}

		const resolved: string | null = Match.value(source).pipe(
			Match.when("traces", () =>
				Match.value(token).pipe(
					Match.whenOr("service", "service.name", () => "service"),
					Match.whenOr("span", "span.name", () => "span_name"),
					Match.whenOr("status", "status.code", () => "status_code"),
					Match.when("http.method", () => "http_method"),
					Match.whenOr("none", "all", () => "none"),
					Match.orElse(() => null),
				),
			),
			Match.when("logs", () =>
				Match.value(token).pipe(
					Match.whenOr("service", "service.name", () => "service"),
					Match.when("severity", () => "severity"),
					Match.whenOr("none", "all", () => "none"),
					Match.orElse(() => null),
				),
			),
			Match.orElse(() =>
				Match.value(token).pipe(
					Match.whenOr("service", "service.name", () => "service"),
					Match.whenOr("none", "all", () => "none"),
					Match.orElse(() => null),
				),
			),
		)

		if (resolved == null) {
			warnings.push(`Unsupported ${source} group by ignored: ${raw}`)
			continue
		}
		if (!seenTokens.has(resolved)) {
			seenTokens.add(resolved)
			tokens.push(resolved)
		}
	}

	return { tokens, attributeKeys, resourceAttributeKeys, warnings }
}

// ---------------------------------------------------------------------------
// Accumulator → QuerySpec filters
// ---------------------------------------------------------------------------

function buildTracesSpecFilters(acc: TracesFilterAccumulator): Record<string, unknown> | undefined {
	const filters: Record<string, unknown> = {}

	if (acc.serviceName) filters.serviceName = acc.serviceName
	if (acc.spanName) filters.spanName = acc.spanName
	if (acc.rootSpansOnly) filters.rootSpansOnly = acc.rootSpansOnly
	// Tri-state: `has_error = false` must survive as an explicit filter (only
	// non-errored spans), not collapse into "no filter".
	if (acc.errorsOnly != null) filters.errorsOnly = acc.errorsOnly
	if (acc.environments?.length) filters.environments = acc.environments
	if (acc.commitShas?.length) filters.commitShas = acc.commitShas
	if (acc.groupByAttributeKeys?.length) filters.groupByAttributeKeys = acc.groupByAttributeKeys
	if (acc.attributeFilters.length > 0) filters.attributeFilters = acc.attributeFilters
	if (acc.resourceAttributeFilters.length > 0)
		filters.resourceAttributeFilters = acc.resourceAttributeFilters

	return Object.keys(filters).length > 0 ? filters : undefined
}

function dedupeGroupByKeys<T extends string>(keys: readonly T[]): T[] {
	const seen = new Set<T>()
	const result: T[] = []
	for (const key of keys) {
		if (seen.has(key)) continue
		seen.add(key)
		result.push(key)
	}
	return result
}

// ---------------------------------------------------------------------------
// Query spec builders
// ---------------------------------------------------------------------------

export function buildTimeseriesQuerySpec(query: QueryBuilderQueryDraftPayload): BuildSpecResult {
	const warnings: string[] = []
	const { clauses, warnings: parseWarnings } = parseWhereClause(query.whereClause ?? "")
	for (const w of parseWarnings) warnings.push(w.message)

	const stepInterval = query.stepInterval ?? ""
	const bucketSeconds = parseBucketSeconds(stepInterval)
	if (stepInterval.trim() && !bucketSeconds) {
		warnings.push("Invalid step interval ignored; auto interval will be used")
	}

	// Opt-in top-N series cap. Parsed from the builder's string field; a blank,
	// zero, negative, or non-integer value disables the cap.
	const seriesLimitRaw = query.seriesLimit?.trim()
	const seriesLimitParsed = seriesLimitRaw ? Number.parseInt(seriesLimitRaw, 10) : Number.NaN
	const seriesLimit =
		Number.isInteger(seriesLimitParsed) && seriesLimitParsed > 0 ? seriesLimitParsed : undefined
	if (seriesLimitRaw && seriesLimit === undefined) {
		warnings.push("Invalid series limit ignored; all series will be fetched")
	}

	if (query.dataSource === "traces") {
		// A non-empty `valueField` (e.g. "attr.result.rowCount") switches the query
		// into numeric-attribute aggregation mode: `aggregation` becomes a numeric
		// function over that span attribute instead of a duration-based metric.
		const numericValueField = (query.valueField ?? "").trim()
		const isNumericAggregation = numericValueField.length > 0
		const numericAggregationFns = new Set(["avg", "sum", "min", "max", "p50", "p95", "p99"])

		if (isNumericAggregation) {
			if (!numericAggregationFns.has(query.aggregation)) {
				return {
					query: null,
					warnings,
					error: `Numeric-attribute aggregation requires one of avg/sum/min/max/p50/p95/p99 (got: ${query.aggregation})`,
				}
			}
		} else {
			const allowedMetrics = new Set([
				"count",
				"avg_duration",
				"p50_duration",
				"p95_duration",
				"p99_duration",
				"error_rate",
			])

			if (!allowedMetrics.has(query.aggregation)) {
				return {
					query: null,
					warnings,
					error: `Unsupported traces metric: ${query.aggregation}`,
				}
			}
		}

		// Preserve attribute-key case (ClickHouse Map keys are case-sensitive); only
		// strip a leading `attr.` prefix if present.
		const numericAttributeKey = isNumericAggregation
			? numericValueField.replace(/^attr\./i, "").trim()
			: ""
		if (isNumericAggregation && !numericAttributeKey) {
			return {
				query: null,
				warnings,
				error: "valueField must reference a span attribute, e.g. attr.result.rowCount",
			}
		}

		const filters = clauses.reduce<TracesFilterAccumulator>(
			(acc, clause) => applyTracesClause(acc, clause, warnings),
			{ attributeFilters: [], resourceAttributeFilters: [] },
		)

		const groupByKeys: TracesGroupByKey[] = []
		if (query.addOns?.groupBy && (query.groupBy?.length ?? 0) > 0) {
			for (const raw of query.groupBy ?? []) {
				const token = raw.trim().toLowerCase()
				if (!token) continue
				const resolved = resolveTracesGroupByToken(token, filters, warnings, raw)
				if (resolved) groupByKeys.push(resolved)
			}
		}

		const groupBy = groupByKeys.length > 0 ? dedupeGroupByKeys(groupByKeys) : undefined

		if (groupByKeys.includes("attribute") && !filters.groupByAttributeKeys?.length) {
			return {
				query: null,
				warnings,
				error: "groupBy=attribute requires attr.<key> in Group By or Where clause",
			}
		}

		const specFilters = buildTracesSpecFilters(filters)
		const finalFilters = isNumericAggregation
			? {
					...specFilters,
					numericAggregation: {
						key: numericAttributeKey,
						fn: query.aggregation as "avg" | "sum" | "min" | "max" | "p50" | "p95" | "p99",
					},
				}
			: specFilters

		return {
			query: {
				kind: "timeseries",
				source: "traces",
				// Numeric-attribute aggregations carry `metric: "count"` (still a useful
				// sample count); the charted value comes from `filters.numericAggregation`.
				metric: isNumericAggregation
					? "count"
					: (query.aggregation as
							| "count"
							| "avg_duration"
							| "p50_duration"
							| "p95_duration"
							| "p99_duration"
							| "error_rate"),
				groupBy,
				filters: finalFilters,
				bucketSeconds,
				seriesLimit,
			} as QuerySpec,
			warnings,
			error: null,
		}
	}

	if (query.dataSource === "logs") {
		if (query.aggregation !== "count") {
			return {
				query: null,
				warnings,
				error: "Logs source currently supports only count metric",
			}
		}

		const filters = clauses.reduce<{ serviceName?: string; severity?: string }>(
			(acc, clause) => applyLogsClause(acc, clause, warnings),
			{},
		)

		const logsGroupByKeys: LogsGroupByKey[] = []
		if (query.addOns?.groupBy && (query.groupBy?.length ?? 0) > 0) {
			for (const raw of query.groupBy ?? []) {
				const token = raw.trim().toLowerCase()
				if (!token) continue
				const resolved = resolveLogsGroupByToken(token, warnings, raw)
				if (resolved) logsGroupByKeys.push(resolved)
			}
		}

		const groupBy = logsGroupByKeys.length > 0 ? dedupeGroupByKeys(logsGroupByKeys) : undefined

		return {
			query: {
				kind: "timeseries",
				source: "logs",
				metric: "count",
				groupBy,
				filters: Object.keys(filters).length ? filters : undefined,
				bucketSeconds,
				seriesLimit,
			} as QuerySpec,
			warnings,
			error: null,
		}
	}

	const allowedMetrics = new Set(["avg", "sum", "min", "max", "count", "rate", "increase"])
	if (!allowedMetrics.has(query.aggregation)) {
		return {
			query: null,
			warnings,
			error: `Unsupported metrics aggregation: ${query.aggregation}`,
		}
	}

	if (!query.metricName) {
		return {
			query: null,
			warnings,
			error: "Metric source requires a metric name",
		}
	}

	const metricsFilters = clauses.reduce<MetricsFilterAccumulator>(
		(acc, clause) => applyMetricsClause(acc, clause, warnings),
		{
			metricName: query.metricName,
			metricType: query.metricType ?? "gauge",
			resourceAttributeFilters: [],
		},
	)

	const metricsGroupByKeys: MetricsGroupByKey[] = []
	if (query.addOns?.groupBy && (query.groupBy?.length ?? 0) > 0) {
		for (const raw of query.groupBy ?? []) {
			const token = raw.trim().toLowerCase()
			if (!token) continue
			const resolved = resolveMetricsGroupByToken(token, metricsFilters, warnings, raw)
			if (resolved) metricsGroupByKeys.push(resolved)
		}
	}

	// The metrics queries carry a single attribute group column; when both an
	// attr.* and a resource.* token are given, keep whichever came first and
	// warn about the other (silently dropping either is the footgun this file
	// exists to prevent).
	const attrIdx = metricsGroupByKeys.indexOf("attribute")
	const resourceIdx = metricsGroupByKeys.indexOf("resource_attribute")
	if (attrIdx !== -1 && resourceIdx !== -1) {
		const dropResource = attrIdx < resourceIdx
		warnings.push(
			`Metrics queries support a single attribute group by; ignoring ${
				dropResource
					? `resource.${metricsFilters.groupByResourceAttributeKey}`
					: `attr.${metricsFilters.groupByAttributeKey}`
			}`,
		)
		const dropped: MetricsGroupByKey = dropResource ? "resource_attribute" : "attribute"
		for (let i = metricsGroupByKeys.length - 1; i >= 0; i--) {
			if (metricsGroupByKeys[i] === dropped) metricsGroupByKeys.splice(i, 1)
		}
		if (dropResource) delete metricsFilters.groupByResourceAttributeKey
		else delete metricsFilters.groupByAttributeKey
	}

	const groupBy = metricsGroupByKeys.length > 0 ? dedupeGroupByKeys(metricsGroupByKeys) : undefined

	const { resourceAttributeFilters: metricsResourceFilters, ...metricsSpecFilters } = metricsFilters

	return {
		query: {
			kind: "timeseries",
			source: "metrics",
			metric: query.aggregation as "avg" | "sum" | "min" | "max" | "count" | "rate" | "increase",
			groupBy,
			filters: {
				...metricsSpecFilters,
				...(metricsResourceFilters.length > 0
					? { resourceAttributeFilters: metricsResourceFilters }
					: {}),
			},
			bucketSeconds,
		} as QuerySpec,
		warnings,
		error: null,
	}
}

export function buildBreakdownQuerySpec(query: QueryBuilderQueryDraftPayload): BuildSpecResult {
	const timeseriesResult = buildTimeseriesQuerySpec(query)
	if (!timeseriesResult.query) return timeseriesResult

	const spec = timeseriesResult.query
	if (spec.kind !== "timeseries") return timeseriesResult

	const groupByArray = (spec as { groupBy?: string[] }).groupBy ?? []
	const breakdownGroupBy = groupByArray.find((g) => g !== "none")
	if (!breakdownGroupBy) {
		return {
			query: null,
			warnings: timeseriesResult.warnings,
			error: "Breakdown requires a non-none group-by field",
		}
	}

	const limitRaw = query.addOns?.limit ? (query.limit ?? "").trim() : ""
	const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined
	const limit =
		parsedLimit && Number.isFinite(parsedLimit) && parsedLimit > 0 && parsedLimit <= 100
			? parsedLimit
			: undefined

	return {
		query: {
			kind: "breakdown" as const,
			source: spec.source,
			metric: (spec as { metric: string }).metric,
			groupBy: breakdownGroupBy,
			filters: (spec as { filters?: unknown }).filters,
			limit,
		} as QuerySpec,
		warnings: timeseriesResult.warnings,
		error: null,
	}
}

export function buildListQuerySpec(
	query: QueryBuilderQueryDraftPayload,
	limit?: number,
	columns?: string[],
): BuildSpecResult {
	// Reuse the timeseries spec builder to parse the where clause into filters
	const timeseriesResult = buildTimeseriesQuerySpec(query)
	if (!timeseriesResult.query) return timeseriesResult

	const spec = timeseriesResult.query
	if (spec.kind !== "timeseries") return timeseriesResult

	return {
		query: {
			kind: "list" as const,
			source: spec.source,
			filters: (spec as { filters?: unknown }).filters,
			limit,
			...(columns?.length ? { columns } : {}),
		} as QuerySpec,
		warnings: timeseriesResult.warnings,
		error: null,
	}
}

const FILTER_MODE_TO_DISPLAY: Record<string, string> = {
	equals: "=",
	gt: ">",
	gte: ">=",
	lt: "<",
	lte: "<=",
	contains: "contains",
}

function formatAttrFilterClause(
	prefix: string,
	af: { key: string; value?: string; mode: string; negated?: boolean },
): string {
	if (af.mode === "exists") {
		return `${prefix}.${af.key} ${af.negated ? "!exists" : "exists"}`
	}
	if (af.mode === "contains") {
		return `${prefix}.${af.key} ${af.negated ? "!contains" : "contains"} "${af.value ?? ""}"`
	}
	// `negated` only ever pairs with `equals` here (operatorToAttrFilter never
	// negates the numeric comparators), so render it as `!=`.
	const op = af.negated && af.mode === "equals" ? "!=" : (FILTER_MODE_TO_DISPLAY[af.mode] ?? "=")
	return `${prefix}.${af.key} ${op} "${af.value ?? ""}"`
}

export function formatFiltersAsWhereClause(params: Record<string, unknown>): string {
	const filters =
		params.filters && typeof params.filters === "object"
			? (params.filters as Record<string, unknown>)
			: {}

	const clauses: string[] = []

	if (typeof filters.serviceName === "string" && filters.serviceName.trim()) {
		clauses.push(`service.name = "${filters.serviceName.trim()}"`)
	}

	if (typeof filters.spanName === "string" && filters.spanName.trim()) {
		clauses.push(`span.name = "${filters.spanName.trim()}"`)
	}

	if (typeof filters.severity === "string" && filters.severity.trim()) {
		clauses.push(`severity = "${filters.severity.trim()}"`)
	}

	if (filters.rootSpansOnly === true) {
		clauses.push("root_only = true")
	}

	if (Array.isArray(filters.environments) && filters.environments.length > 0) {
		const val = filters.environments.filter((item): item is string => typeof item === "string").join(",")

		if (val) {
			clauses.push(`deployment.environment = "${val}"`)
		}
	}

	if (Array.isArray(filters.commitShas) && filters.commitShas.length > 0) {
		const val = filters.commitShas.filter((item): item is string => typeof item === "string").join(",")

		if (val) {
			clauses.push(`deployment.commit_sha = "${val}"`)
		}
	}

	if (Array.isArray(filters.attributeFilters)) {
		for (const af of filters.attributeFilters as Array<{ key: string; value?: string; mode: string }>) {
			clauses.push(formatAttrFilterClause("attr", af))
		}
	}

	if (Array.isArray(filters.resourceAttributeFilters)) {
		for (const rf of filters.resourceAttributeFilters as Array<{
			key: string
			value?: string
			mode: string
		}>) {
			clauses.push(formatAttrFilterClause("resource", rf))
		}
	}

	return clauses.join(" AND ")
}
