import type { QueryBuilderQueryDraftPayload } from "@maple/domain/http"
import type { QuerySpec } from "@maple/domain/query-engine"
import { normalizeKey, parseBoolean, parseWhereClause, splitCsv } from "@maple/domain/where-clause"
import { Match } from "effect"

export type {
	QueryBuilderDataSource,
	QueryBuilderMetricType,
	QueryBuilderSignalSource,
} from "@maple/query-model"
import { QUERY_BUILDER_METRIC_TYPES } from "@maple/query-model"
import type {
	QueryBuilderDataSource,
	QueryBuilderFormulaPayload,
	QueryBuilderMetricType,
	QueryBuilderSignalSource,
} from "@maple/query-model"

export type QueryBuilderAddOnKey = "groupBy" | "having" | "orderBy" | "limit" | "legend"

/**
 * EDITOR state, not the stored payload.
 *
 * Every field is required here and `Schema.optional` in
 * `QueryBuilderQueryDraftSchema` (`@maple/query-model`), and that difference is
 * the point: the builder always holds a fully-populated draft — an empty
 * where-clause is `""`, not absent — while a stored or wire draft omits what the
 * user never set. Collapsing this into the schema's inferred type would make
 * `query.whereClause` possibly-undefined at every read in the builder to buy
 * nothing.
 *
 * `normalizeRuleQueryDraft` / `toInitialState` are the boundary that fills a
 * payload out into this shape.
 */
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
} satisfies Record<QueryBuilderDataSource, Array<{ label: string; value: string }>>

/**
 * The aggregations legal on traces when `valueField` names a numeric span
 * attribute — a different vocabulary from `AGGREGATIONS_BY_SOURCE.traces`,
 * because the aggregation applies to an arbitrary number rather than to
 * duration. This is the ONLY place bare `p50`/`p95`/`p99` are valid; the
 * duration percentiles are spelled `p95_duration`.
 *
 * Exported because the MCP schema doc renders it: the instructions resource
 * previously advertised bare `p50`/`p95`/`p99` as *metrics* aggregations, which
 * `buildTimeseriesQuerySpec` hard-errors on. Documenting from the same array the
 * builder enforces is what keeps that from recurring.
 */
export const TRACES_NUMERIC_AGGREGATIONS = ["avg", "sum", "min", "max", "p50", "p95", "p99"] as const

/**
 * Enforcement sets, derived from the option lists above rather than retyped.
 *
 * These used to be inline `new Set([...])` literals inside
 * `buildQuerySpecFromDraft`, duplicating `AGGREGATIONS_BY_SOURCE` by hand. The
 * duplication is what let the docs drift: nothing tied the list an agent reads
 * to the list the builder accepts.
 */
const ALLOWED_AGGREGATIONS = {
	traces: new Set(AGGREGATIONS_BY_SOURCE.traces.map((option) => option.value)),
	logs: new Set(AGGREGATIONS_BY_SOURCE.logs.map((option) => option.value)),
	metrics: new Set(AGGREGATIONS_BY_SOURCE.metrics.map((option) => option.value)),
} satisfies Record<QueryBuilderDataSource, ReadonlySet<string>>

const ALLOWED_TRACES_NUMERIC_AGGREGATIONS: ReadonlySet<string> = new Set(TRACES_NUMERIC_AGGREGATIONS)

// `sum` belongs here alongside rate/increase because those two assume
// *cumulative* temporality — they lower to `metricsTimeseriesRateQuery`, which
// reconstructs increments with `lagInFrame` over per-replica accumulation
// epochs. A delta-temporality counter already exports its increment per
// interval, so the correct aggregation is a plain `sum(Value)` per bucket, and
// running rate/increase over it would double-difference the data. The query
// builder has no temporality dimension to branch on, so both are offered and
// `rate` stays first to keep the default unchanged for the common cumulative
// case.
const METRICS_AGGREGATIONS_MONOTONIC_SUM = [
	{ label: "rate", value: "rate" },
	{ label: "increase", value: "increase" },
	{ label: "sum", value: "sum" },
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
	isMonotonic?: boolean,
): Array<{ label: string; value: string }> {
	// A Sum metric explicitly flagged non-monotonic is an UpDownCounter — it can
	// decrease, so rate/increase are meaningless for it and the gauge-like set is
	// correct. `undefined` keeps the old assumption (Sum metrics in OpenTelemetry
	// are overwhelmingly monotonic counters) so callers that don't know stay on
	// rate/increase.
	if (metricType === "sum" && isMonotonic !== false) {
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

export { QUERY_BUILDER_METRIC_TYPES }

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
} satisfies Record<QueryBuilderDataSource, Array<{ label: string; value: string }>>

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

/**
 * Editor state for a formula, same total-vs-partial split as
 * `QueryBuilderQueryDraft`: `hidden` is always set here and optional in the
 * stored `QueryBuilderFormulaSchema`.
 */
export interface QueryBuilderFormulaDraft extends QueryBuilderFormulaPayload {
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

// Clause-to-filter mapping via Match

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
		...(negated ? { negated: true } : undefined),
		...(hasValue ? { value } : undefined),
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
		Match.when("vcs.ref.head.revision", () => ({
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
	environments?: string[]
	groupByAttributeKey?: string
	groupByResourceAttributeKey?: string
	attributeFilters: AccumulatedAttributeFilter[]
	resourceAttributeFilters: AccumulatedAttributeFilter[]
}

function applyMetricsClause(
	filters: MetricsFilterAccumulator,
	clause: { key: string; operator: string; value: string },
	warnings: string[],
): MetricsFilterAccumulator {
	const key = normalizeKey(clause.key)

	// Datapoint labels live in the Attributes map. The metrics CH path carries a
	// single equality predicate on it (attributeKey/attributeValue), so exactly
	// one `attr.<key> = value` clause is honored; anything else warns instead of
	// being silently dropped.
	if (key.startsWith("attr.")) {
		const attributeKey = key.slice(5)
		const { mode, negated } = operatorToAttrFilter(clause.operator)
		if (mode !== "equals" || negated) {
			warnings.push(`Metrics attr.* filters support only equality; ignoring attr.${attributeKey}`)
			return filters
		}
		if (filters.attributeFilters.length >= 1) {
			warnings.push(`Metrics queries support a single attr.* filter; ignoring attr.${attributeKey}`)
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
		Match.when("deployment.environment", () => ({
			...filters,
			environments: splitCsv(clause.value),
		})),
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

// Group-by vocabulary
//
// ONE alias map per data source is the authority for what a group-by token
// means. The dashboard query-spec builder below and the exported
// `resolveGroupBy` (used by alert compilation) both resolve through it, and the
// documented `GROUP_BY_TOKENS` catalogue — rendered into the MCP schema doc —
// is generated from it. Keeping these three in step by hand did not work: the
// catalogue and the builder accepted the snake_case aliases
// (`service_name`, `span_name`, `status_code`, `severity_text`) while
// `resolveGroupBy` did not, so a token an agent read out of the docs and saved
// in a dashboard widget hard-failed validation the moment the same expression
// was compiled for an alert rule.
//
// Consumer policy is deliberately NOT in here. Which tokens a surface offers,
// how many `attr.*` dimensions it tolerates, and whether an unusable token is a
// warning or a hard error stay with the consumer.

type TracesGroupByKey = "service" | "span_name" | "status_code" | "http_method" | "attribute" | "none"
type LogsGroupByKey = "service" | "severity" | "none"
type MetricsGroupByKey = "service" | "attribute" | "resource_attribute" | "none"

/** Which bucket a prefixed token's key lands in. */
type GroupByKeyBucket = "attributeKeys" | "resourceAttributeKeys"

interface GroupByPrefixSpec<K extends string> {
	readonly prefix: string
	readonly token: K
	readonly bucket: GroupByKeyBucket
}

interface GroupBySourceSpec<K extends string> {
	/** Accepted literal token → canonical QuerySpec group dimension. */
	readonly aliases: Readonly<Record<string, K>>
	readonly prefixes: ReadonlyArray<GroupByPrefixSpec<K>>
}

const ATTRIBUTE_PREFIX = {
	prefix: "attr.",
	token: "attribute",
	bucket: "attributeKeys",
} as const satisfies GroupByPrefixSpec<"attribute">

const RESOURCE_PREFIX = {
	prefix: "resource.",
	token: "resource_attribute",
	bucket: "resourceAttributeKeys",
} as const satisfies GroupByPrefixSpec<"resource_attribute">

/** Every prefix any source understands — a token wearing one of these is a
 * prefixed group-by everywhere, so a source that does not support it says so
 * rather than reporting it as an unknown token. */
const ALL_GROUP_BY_PREFIXES = [ATTRIBUTE_PREFIX, RESOURCE_PREFIX] as const

/** A source with no prefixed group-by forms at all. */
const NO_GROUP_BY_PREFIXES: ReadonlyArray<GroupByPrefixSpec<never>> = []

const GROUP_BY_ALIASES = {
	traces: {
		// snake_case aliases match the warehouse column spellings — dashboard
		// widget presets (and widgets persisted from them) use those, so
		// dropping them silently broke every preset breakdown (MAP-49).
		aliases: {
			service: "service",
			"service.name": "service",
			service_name: "service",
			span: "span_name",
			"span.name": "span_name",
			span_name: "span_name",
			status: "status_code",
			"status.code": "status_code",
			status_code: "status_code",
			"http.method": "http_method",
			none: "none",
			all: "none",
		},
		prefixes: [ATTRIBUTE_PREFIX],
	},
	logs: {
		aliases: {
			service: "service",
			"service.name": "service",
			service_name: "service",
			severity: "severity",
			severity_text: "severity",
			none: "none",
			all: "none",
		},
		// The logs QuerySpec has no attribute group dimension.
		prefixes: NO_GROUP_BY_PREFIXES,
	},
	metrics: {
		aliases: {
			service: "service",
			"service.name": "service",
			none: "none",
			all: "none",
		},
		prefixes: [ATTRIBUTE_PREFIX, RESOURCE_PREFIX],
	},
} as const satisfies {
	readonly traces: GroupBySourceSpec<TracesGroupByKey>
	readonly logs: GroupBySourceSpec<LogsGroupByKey>
	readonly metrics: GroupBySourceSpec<MetricsGroupByKey>
}

/**
 * The documented group-by vocabulary, per source — generated from
 * `GROUP_BY_ALIASES` so the docs cannot drift from the resolvers.
 */
export const GROUP_BY_TOKENS = {
	traces: {
		literals: Object.keys(GROUP_BY_ALIASES.traces.aliases),
		prefixes: GROUP_BY_ALIASES.traces.prefixes.map((p) => p.prefix),
	},
	logs: {
		literals: Object.keys(GROUP_BY_ALIASES.logs.aliases),
		prefixes: GROUP_BY_ALIASES.logs.prefixes.map((p) => p.prefix),
	},
	metrics: {
		literals: Object.keys(GROUP_BY_ALIASES.metrics.aliases),
		prefixes: GROUP_BY_ALIASES.metrics.prefixes.map((p) => p.prefix),
	},
} satisfies Readonly<
	Record<
		QueryBuilderDataSource,
		{ readonly literals: ReadonlyArray<string>; readonly prefixes: ReadonlyArray<string> }
	>
>

type GroupByTokenResolution<K extends string> =
	/** Blank/whitespace-only input — skip it without warning. */
	| { readonly _tag: "Empty" }
	| { readonly _tag: "Literal"; readonly token: K }
	| {
			readonly _tag: "Prefixed"
			readonly token: K
			readonly bucket: GroupByKeyBucket
			readonly key: string
	  }
	| { readonly _tag: "Rejected"; readonly warning: string }

/**
 * The single group-by token interpreter. Normalises the raw token, applies the
 * source's prefix handlers, then its alias map. It never decides policy — it
 * only answers "what does this token mean for this source".
 */
function resolveGroupByToken<K extends string>(
	source: QueryBuilderDataSource,
	spec: GroupBySourceSpec<K>,
	raw: string,
): GroupByTokenResolution<K> {
	const token = raw.trim().toLowerCase()
	if (!token) return { _tag: "Empty" }

	for (const known of ALL_GROUP_BY_PREFIXES) {
		if (!token.startsWith(known.prefix)) continue
		const key = token.slice(known.prefix.length)
		if (!key) return { _tag: "Rejected", warning: `Invalid ${known.prefix}* group by ignored` }
		const supported = spec.prefixes.find((p) => p.prefix === known.prefix)
		if (!supported) {
			return {
				_tag: "Rejected",
				warning: `${source} source does not support ${known.prefix}* group by: ${raw}`,
			}
		}
		return { _tag: "Prefixed", token: supported.token, bucket: supported.bucket, key }
	}

	const resolved = Object.hasOwn(spec.aliases, token) ? spec.aliases[token] : undefined
	if (resolved === undefined) {
		return { _tag: "Rejected", warning: `Unsupported ${source} group by ignored: ${raw}` }
	}
	return { _tag: "Literal", token: resolved }
}

function resolveTracesGroupByToken(
	raw: string,
	filters: TracesFilterAccumulator,
	warnings: string[],
): TracesGroupByKey | null {
	const resolution = resolveGroupByToken("traces", GROUP_BY_ALIASES.traces, raw)
	switch (resolution._tag) {
		case "Empty":
			return null
		case "Rejected":
			warnings.push(resolution.warning)
			return null
		case "Literal":
			return resolution.token
		case "Prefixed":
			// Traces carry an array of attribute group columns, so every distinct
			// key is kept.
			if (!filters.groupByAttributeKeys) filters.groupByAttributeKeys = []
			filters.groupByAttributeKeys.push(resolution.key)
			return resolution.token
	}
}

function resolveLogsGroupByToken(raw: string, warnings: string[]): LogsGroupByKey | null {
	const resolution = resolveGroupByToken("logs", GROUP_BY_ALIASES.logs, raw)
	switch (resolution._tag) {
		case "Empty":
			return null
		case "Rejected":
			warnings.push(resolution.warning)
			return null
		case "Literal":
			return resolution.token
		case "Prefixed":
			// Unreachable: the logs spec declares no prefixes.
			return null
	}
}

function resolveMetricsGroupByToken(
	raw: string,
	metricsFilters: {
		metricName: string
		metricType: string
		serviceName?: string
		groupByAttributeKey?: string
		groupByResourceAttributeKey?: string
	},
	warnings: string[],
): MetricsGroupByKey | null {
	const resolution = resolveGroupByToken("metrics", GROUP_BY_ALIASES.metrics, raw)
	switch (resolution._tag) {
		case "Empty":
			return null
		case "Rejected":
			warnings.push(resolution.warning)
			return null
		case "Literal":
			return resolution.token
		case "Prefixed": {
			// Consumer policy: the metrics QuerySpec carries a single attribute
			// group column and a single resource one, so a second distinct key
			// warns and is dropped rather than silently overwriting the first.
			if (resolution.bucket === "attributeKeys") {
				if (
					metricsFilters.groupByAttributeKey !== undefined &&
					metricsFilters.groupByAttributeKey !== resolution.key
				) {
					warnings.push(
						`Metrics queries support a single attr.* group by; ignoring attr.${resolution.key}`,
					)
					return null
				}
				metricsFilters.groupByAttributeKey = resolution.key
				return resolution.token
			}
			if (
				metricsFilters.groupByResourceAttributeKey !== undefined &&
				metricsFilters.groupByResourceAttributeKey !== resolution.key
			) {
				warnings.push(
					`Metrics queries support a single resource.* group by; ignoring resource.${resolution.key}`,
				)
				return null
			}
			metricsFilters.groupByResourceAttributeKey = resolution.key
			return resolution.token
		}
	}
}

// Shared resolveGroupBy — used by both the dashboard query builder and the
// alerting compiler so they interpret raw user tokens (`service.name`,
// `attr.<key>`, …) identically.

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
		const resolution = resolveGroupByToken(source, GROUP_BY_ALIASES[source], raw)
		switch (resolution._tag) {
			case "Empty":
				continue
			case "Rejected":
				warnings.push(resolution.warning)
				continue
			case "Prefixed": {
				const seenKeys = resolution.bucket === "attributeKeys" ? seenAttrKeys : seenResourceKeys
				const keys = resolution.bucket === "attributeKeys" ? attributeKeys : resourceAttributeKeys
				if (!seenKeys.has(resolution.key)) {
					seenKeys.add(resolution.key)
					keys.push(resolution.key)
				}
				break
			}
			case "Literal":
				break
		}
		if (!seenTokens.has(resolution.token)) {
			seenTokens.add(resolution.token)
			tokens.push(resolution.token)
		}
	}

	return { tokens, attributeKeys, resourceAttributeKeys, warnings }
}

// Accumulator → QuerySpec filters

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

// Query spec builders

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

		if (isNumericAggregation) {
			if (!ALLOWED_TRACES_NUMERIC_AGGREGATIONS.has(query.aggregation)) {
				return {
					query: null,
					warnings,
					error: `Numeric-attribute aggregation requires one of ${TRACES_NUMERIC_AGGREGATIONS.join("/")} (got: ${query.aggregation})`,
				}
			}
		} else {
			if (!ALLOWED_AGGREGATIONS.traces.has(query.aggregation)) {
				return {
					query: null,
					warnings,
					// Bare `p95` is the common miss: it is only valid with a
					// `valueField`, and the duration percentile is `p95_duration`.
					error: `Unsupported traces metric: ${query.aggregation}. Valid: ${[...ALLOWED_AGGREGATIONS.traces].join(", ")}${ALLOWED_TRACES_NUMERIC_AGGREGATIONS.has(query.aggregation) ? ` — \`${query.aggregation}\` is a numeric-attribute aggregation and requires \`valueField\`` : ""}`,
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
				const resolved = resolveTracesGroupByToken(raw, filters, warnings)
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
		if (!ALLOWED_AGGREGATIONS.logs.has(query.aggregation)) {
			return {
				query: null,
				warnings,
				error: `Logs source currently supports only ${[...ALLOWED_AGGREGATIONS.logs].join("/")} metric (got: ${query.aggregation})`,
			}
		}

		const filters = clauses.reduce<{ serviceName?: string; severity?: string }>(
			(acc, clause) => applyLogsClause(acc, clause, warnings),
			{},
		)

		const logsGroupByKeys: LogsGroupByKey[] = []
		if (query.addOns?.groupBy && (query.groupBy?.length ?? 0) > 0) {
			for (const raw of query.groupBy ?? []) {
				const resolved = resolveLogsGroupByToken(raw, warnings)
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

	if (!ALLOWED_AGGREGATIONS.metrics.has(query.aggregation)) {
		return {
			query: null,
			warnings,
			error: `Unsupported metrics aggregation: ${query.aggregation}. Valid: ${[...ALLOWED_AGGREGATIONS.metrics].join(", ")}`,
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
			attributeFilters: [],
			resourceAttributeFilters: [],
		},
	)

	const metricsGroupByKeys: MetricsGroupByKey[] = []
	if (query.addOns?.groupBy && (query.groupBy?.length ?? 0) > 0) {
		for (const raw of query.groupBy ?? []) {
			const resolved = resolveMetricsGroupByToken(raw, metricsFilters, warnings)
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

	const {
		attributeFilters: metricsAttributeFilters,
		resourceAttributeFilters: metricsResourceFilters,
		...metricsSpecFilters
	} = metricsFilters

	return {
		query: {
			kind: "timeseries",
			source: "metrics",
			metric: query.aggregation as "avg" | "sum" | "min" | "max" | "count" | "rate" | "increase",
			groupBy,
			filters: {
				...metricsSpecFilters,
				...(metricsAttributeFilters.length > 0
					? { attributeFilters: metricsAttributeFilters }
					: undefined),
				...(metricsResourceFilters.length > 0
					? {
							resourceAttributeFilters: metricsResourceFilters,
						}
					: undefined),
			},
			bucketSeconds,
		} as QuerySpec,
		warnings,
		error: null,
	}
}

/**
 * Rows to fetch for a breakdown that collapses its long tail into an "Other"
 * bucket, when the author set no explicit limit.
 *
 * The warehouse default is 10, which is also roughly what a pie can *draw* — so
 * the chart received exactly the rows it wanted to show and had no idea a tail
 * existed. Its "Other" bucket therefore never fired and the panel silently
 * claimed the top 10 was everything.
 *
 * `LIMIT` only bounds the rows returned, not the scan: the GROUP BY has already
 * aggregated every group, so 50 rows costs the same query as 10. Fetching past
 * what we render is what makes "Other" a real number and lets the legend say how
 * many categories it stands for. Panels that plot every row they receive
 * (funnel, heatmap) keep the warehouse default instead.
 */
export const BREAKDOWN_TAIL_LIMIT = 50

export function buildBreakdownQuerySpec(
	query: QueryBuilderQueryDraftPayload,
	options?: { defaultLimit?: number },
): BuildSpecResult {
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
			: options?.defaultLimit

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
			...(columns?.length ? { columns } : undefined),
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
} satisfies Record<string, string>

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
			clauses.push(`vcs.ref.head.revision = "${val}"`)
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
