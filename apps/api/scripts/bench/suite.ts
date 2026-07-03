// ---------------------------------------------------------------------------
// bench/suite.ts — committed, repeatable query benchmark suite
//
// Each case compiles a query from the SAME `@maple/query-engine` DSL that
// production runs, so the benchmark measures the exact SQL the app emits (not a
// hand-written approximation). Cases mirror ClickStack's representative
// patterns: needle-in-haystack body search, trace point lookup, attribute
// equality/contains filters, top-N list scans, facets, and autocomplete, plus a
// couple of service-scoped canaries to catch regressions from schema changes.
//
// The suite compiles to plain SQL strings, which the `bench` CLI writes into the
// same JSON shape `fetch` produces — so `run` / `inspect` / `compare` replay it
// unchanged. Keep this pure (no IO) so it stays unit-testable.
// ---------------------------------------------------------------------------

import { CH } from "@maple/query-engine"

/** Params substituted at compile time (the `param.*` placeholders every query shares). */
export interface SuiteParams {
	readonly orgId: string
	readonly startTime: string
	readonly endTime: string
}

/** Literal inputs baked into query construction (a real trace id, a real attribute, …). */
export interface SuiteInputs {
	/** Existing trace id for the point-lookup case (bloom + trace_detail_spans path). */
	readonly traceId: string
	/** A service present in the window, for the service-scoped canary. */
	readonly serviceName: string
	/** Multi-word phrase so the body-search token pre-filter actually engages. */
	readonly searchTerm: string
	/** Attribute key/value that occurs in the window (drives the items-index case). */
	readonly attrKey: string
	readonly attrValue: string
	/** Attribute scope for the autocomplete case ("span" | "resource" | "log"). */
	readonly attrScope: string
}

export interface SuiteCase {
	readonly name: string
	readonly profile: string
	readonly description: string
	/** Compile this case's SQL for the given window/org. */
	readonly compile: (params: SuiteParams) => string
}

/**
 * Build the benchmark suite. `inputs` supplies the literal values (trace id,
 * attribute, search phrase) that must exist in the target window for the query
 * to touch real data — the CLI resolves sensible defaults or takes them from
 * flags.
 */
export function buildSuite(inputs: SuiteInputs): ReadonlyArray<SuiteCase> {
	const q = (query: Parameters<typeof CH.compile>[0], p: SuiteParams): string => CH.compile(query, p).sql
	const u = (union: Parameters<typeof CH.compileUnion>[0], p: SuiteParams): string =>
		CH.compileUnion(union, p).sql

	return [
		{
			name: "logs_body_search",
			profile: "list",
			description: "Needle-in-haystack body search — exercises idx_body_tokens + ILIKE tail",
			compile: (p) => q(CH.logsListQuery({ search: inputs.searchTerm, limit: 50 }), p),
		},
		{
			name: "logs_count_search",
			profile: "list",
			description: "count(*) over a body search — pure granule-pruning win from the token index",
			compile: (p) => q(CH.logsCountQuery({ search: inputs.searchTerm }), p),
		},
		{
			name: "trace_point_lookup",
			profile: "list",
			description: "All spans of one trace — trace_detail_spans (OrgId,TraceId,SpanId) sort key",
			compile: (p) => q(CH.spanSearchQuery({ traceId: inputs.traceId, limit: 100 }), p),
		},
		{
			name: "traces_list",
			profile: "list",
			description: "Traces list ORDER BY Timestamp DESC LIMIT N (two-stage cutoff)",
			compile: (p) => q(CH.tracesListQuery({ limit: 50 }), p),
		},
		{
			name: "traces_list_attr_equals",
			profile: "list",
			description: "Traces list filtered by attribute equality — exercises idx_span_attr_items",
			compile: (p) =>
				q(
					CH.tracesListQuery({
						attributeFilters: [{ key: inputs.attrKey, value: inputs.attrValue, mode: "equals" }],
						limit: 50,
					}),
					p,
				),
		},
		{
			name: "traces_list_attr_contains",
			profile: "list",
			description: "Traces list filtered by attribute substring — no items index (positionCaseInsensitive)",
			compile: (p) =>
				q(
					CH.tracesListQuery({
						attributeFilters: [{ key: inputs.attrKey, value: inputs.attrValue, mode: "contains" }],
						limit: 50,
					}),
					p,
				),
		},
		{
			name: "logs_list",
			profile: "list",
			description: "Logs list ORDER BY Timestamp DESC LIMIT N (two-stage cutoff)",
			compile: (p) => q(CH.logsListQuery({ limit: 50 }), p),
		},
		{
			name: "traces_facets",
			profile: "unbounded",
			description: "Trace facet breakdown (multi-branch UNION ALL)",
			compile: (p) => u(CH.tracesFacetsQuery({}), p),
		},
		{
			name: "services_facets",
			profile: "unbounded",
			description: "Service facet breakdown (4-way UNION ALL over service_overview_spans)",
			compile: (p) => u(CH.servicesFacetsQuery(), p),
		},
		{
			name: "logs_facets",
			profile: "unbounded",
			description: "Log facet breakdown (UNION over logs_aggregates_hourly)",
			compile: (p) => u(CH.logsFacetsQuery({}), p),
		},
		{
			name: "attribute_keys_autocomplete",
			profile: "discovery",
			description: "Attribute-key autocomplete over the attribute_keys_hourly MV",
			compile: (p) => q(CH.attributeKeysQuery({ scope: inputs.attrScope, limit: 200 }), p),
		},
		{
			name: "top_operations",
			profile: "aggregation",
			description: "Top operations by count — aggregation canary (should stay flat)",
			compile: (p) => q(CH.topOperationsQuery({ metric: "count", limit: 20 }), p),
		},
		{
			name: "service_span_search",
			profile: "list",
			description: "Service-scoped raw span scan — sort-key-locality canary for the PK spike",
			compile: (p) => q(CH.spanSearchQuery({ serviceName: inputs.serviceName, limit: 50 }), p),
		},
	]
}
