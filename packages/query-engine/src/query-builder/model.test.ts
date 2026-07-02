import { describe, expect, it } from "vitest"
import type { QueryBuilderQueryDraftPayload } from "@maple/domain/http"
import { buildBreakdownQuerySpec, buildTimeseriesQuerySpec } from "./model"

// Minimal traces draft factory — only the fields the builder reads matter; the
// rest satisfy the payload shape.
function tracesDraft(overrides: Partial<QueryBuilderQueryDraftPayload> = {}): QueryBuilderQueryDraftPayload {
	return {
		id: "q1",
		name: "A",
		enabled: true,
		hidden: false,
		dataSource: "traces",
		aggregation: "count",
		whereClause: "",
		stepInterval: "",
		orderByDirection: "desc",
		addOns: { groupBy: false, having: false, orderBy: false, limit: false, legend: false },
		groupBy: [],
		having: "",
		orderBy: "",
		limit: "",
		legend: "",
		...overrides,
	} as QueryBuilderQueryDraftPayload
}

function attrFilters(whereClause: string) {
	const result = buildTimeseriesQuerySpec(tracesDraft({ whereClause }))
	const filters = (result.query as { filters?: { attributeFilters?: unknown[] } } | null)?.filters
	return { warnings: result.warnings, attributeFilters: filters?.attributeFilters ?? [], filters }
}

describe("buildTimeseriesQuerySpec where-clause → attribute filters", () => {
	it("auto-prefixes a bare attribute key instead of silently dropping it", () => {
		const { warnings, attributeFilters } = attrFilters('query.context = "tracesList"')
		expect(warnings).toEqual([])
		expect(attributeFilters).toEqual([{ key: "query.context", mode: "equals", value: "tracesList" }])
	})

	it("maps != to equals + negated (the negation-collapse bug fix)", () => {
		const { warnings, attributeFilters } = attrFilters('error.type != "Timeout"')
		expect(warnings).toEqual([])
		expect(attributeFilters).toEqual([
			{ key: "error.type", mode: "equals", negated: true, value: "Timeout" },
		])
	})

	it("maps !contains to contains + negated", () => {
		const { attributeFilters } = attrFilters('http.route !contains "/health"')
		expect(attributeFilters).toEqual([
			{ key: "http.route", mode: "contains", negated: true, value: "/health" },
		])
	})

	it("maps exists / !exists with no value", () => {
		expect(attrFilters("db.system exists").attributeFilters).toEqual([
			{ key: "db.system", mode: "exists" },
		])
		expect(attrFilters("db.system !exists").attributeFilters).toEqual([
			{ key: "db.system", mode: "exists", negated: true },
		])
	})

	it("still routes explicit attr.* and resource.* prefixes", () => {
		expect(attrFilters('attr.foo != "bar"').attributeFilters).toEqual([
			{ key: "foo", mode: "equals", negated: true, value: "bar" },
		])
		const resource = buildTimeseriesQuerySpec(
			tracesDraft({ whereClause: 'resource.host.name = "server-1"' }),
		)
		const resFilters = (resource.query as { filters?: { resourceAttributeFilters?: unknown[] } } | null)
			?.filters
		expect(resFilters?.resourceAttributeFilters).toEqual([
			{ key: "host.name", mode: "equals", value: "server-1" },
		])
	})

	it("keeps recognized structured keys bare (no attr prefix)", () => {
		const { attributeFilters, filters } = attrFilters('service.name = "api"')
		expect(attributeFilters).toEqual([])
		expect((filters as { serviceName?: string }).serviceName).toBe("api")
	})

	it("warns (blocking) when the 5 attr-filter cap is exceeded", () => {
		const clause = ["a = 1", "b = 2", "c = 3", "d = 4", "e = 5", "f = 6"].join(" AND ")
		const { warnings, attributeFilters } = attrFilters(clause)
		expect(attributeFilters).toHaveLength(5)
		expect(warnings.some((w) => w.includes("Maximum of 5 attr.* filters"))).toBe(true)
	})
})

describe("buildTimeseriesQuerySpec series limit", () => {
	function seriesLimitOf(overrides: Partial<QueryBuilderQueryDraftPayload>) {
		const result = buildTimeseriesQuerySpec(tracesDraft(overrides))
		return {
			warnings: result.warnings,
			seriesLimit: (result.query as { seriesLimit?: number } | null)?.seriesLimit,
		}
	}

	it("forwards a positive integer seriesLimit onto the spec", () => {
		const { seriesLimit, warnings } = seriesLimitOf({ seriesLimit: "5" })
		expect(seriesLimit).toBe(5)
		expect(warnings).toEqual([])
	})

	it("leaves seriesLimit undefined when blank", () => {
		expect(seriesLimitOf({ seriesLimit: "" }).seriesLimit).toBeUndefined()
		expect(seriesLimitOf({}).seriesLimit).toBeUndefined()
	})

	it("warns and disables the cap for a non-positive or non-integer value", () => {
		const zero = seriesLimitOf({ seriesLimit: "0" })
		expect(zero.seriesLimit).toBeUndefined()
		expect(zero.warnings.some((w) => w.includes("series limit"))).toBe(true)

		expect(seriesLimitOf({ seriesLimit: "-3" }).seriesLimit).toBeUndefined()
		expect(seriesLimitOf({ seriesLimit: "abc" }).seriesLimit).toBeUndefined()
	})
})

describe("group-by token aliases (MAP-49)", () => {
	const breakdownDraft = (overrides: Partial<QueryBuilderQueryDraftPayload> = {}) =>
		tracesDraft({
			addOns: { groupBy: true, having: false, orderBy: false, limit: false, legend: false },
			groupBy: ["service.name"],
			...overrides,
		})

	it("accepts canonical and snake_case traces group-by tokens", () => {
		for (const token of ["service.name", "service_name", "span_name", "status_code"]) {
			const result = buildBreakdownQuerySpec(breakdownDraft({ groupBy: [token] }))
			expect(result.query, `token ${token}`).not.toBeNull()
			expect(result.warnings).toEqual([])
		}
	})

	it("accepts snake_case logs group-by tokens", () => {
		for (const token of ["severity", "severity_text", "service_name"]) {
			const result = buildBreakdownQuerySpec(breakdownDraft({ dataSource: "logs", groupBy: [token] }))
			expect(result.query, `token ${token}`).not.toBeNull()
			expect(result.warnings).toEqual([])
		}
	})

	it("still rejects unknown tokens", () => {
		const result = buildBreakdownQuerySpec(breakdownDraft({ groupBy: ["not_a_column"] }))
		expect(result.query).toBeNull()
	})
})

describe("metrics resource.* support", () => {
	function metricsDraft(
		overrides: Partial<QueryBuilderQueryDraftPayload> = {},
	): QueryBuilderQueryDraftPayload {
		return tracesDraft({
			dataSource: "metrics",
			aggregation: "avg",
			metricName: "system.cpu.utilization",
			metricType: "gauge",
			isMonotonic: false,
			signalSource: "default",
			...overrides,
		} as Partial<QueryBuilderQueryDraftPayload>)
	}

	function metricsFiltersOf(overrides: Partial<QueryBuilderQueryDraftPayload>) {
		const result = buildTimeseriesQuerySpec(metricsDraft(overrides))
		return {
			result,
			warnings: result.warnings,
			groupBy: (result.query as { groupBy?: string[] } | null)?.groupBy,
			filters: (result.query as { filters?: Record<string, unknown> } | null)?.filters,
		}
	}

	it("resource.<key> where clauses become resourceAttributeFilters", () => {
		const { warnings, filters } = metricsFiltersOf({
			whereClause: 'resource.host.name = "web-01" AND resource.k8s.cluster.name != "staging"',
		})
		expect(warnings).toEqual([])
		expect(filters?.resourceAttributeFilters).toEqual([
			{ key: "host.name", mode: "equals", value: "web-01" },
			{ key: "k8s.cluster.name", mode: "equals", negated: true, value: "staging" },
		])
	})

	it("omits resourceAttributeFilters entirely when no resource.* clause is present", () => {
		const { filters } = metricsFiltersOf({ whereClause: 'service.name = "api"' })
		expect(filters).not.toHaveProperty("resourceAttributeFilters")
		expect(filters?.serviceName).toBe("api")
	})

	it("warns (blocking) when the 5 resource-filter cap is exceeded", () => {
		const clause = ["a", "b", "c", "d", "e", "f"].map((k) => `resource.${k} = "1"`).join(" AND ")
		const { warnings, filters } = metricsFiltersOf({ whereClause: clause })
		expect(filters?.resourceAttributeFilters).toHaveLength(5)
		expect(warnings.some((w) => w.includes("Maximum of 5 resource.* filters"))).toBe(true)
	})

	it("resource.<key> group-by resolves to resource_attribute + groupByResourceAttributeKey", () => {
		const { warnings, groupBy, filters } = metricsFiltersOf({
			addOns: { groupBy: true, having: false, orderBy: false, limit: false, legend: false },
			groupBy: ["resource.k8s.pod.name"],
		})
		expect(warnings).toEqual([])
		expect(groupBy).toEqual(["resource_attribute"])
		expect(filters?.groupByResourceAttributeKey).toBe("k8s.pod.name")
	})

	it("keeps the first dimension and warns when attr.* and resource.* group-bys are combined", () => {
		const { warnings, groupBy, filters } = metricsFiltersOf({
			addOns: { groupBy: true, having: false, orderBy: false, limit: false, legend: false },
			groupBy: ["attr.state", "resource.host.name"],
		})
		expect(warnings.some((w) => w.includes("single attribute group by"))).toBe(true)
		expect(groupBy).toEqual(["attribute"])
		expect(filters?.groupByAttributeKey).toBe("state")
		expect(filters).not.toHaveProperty("groupByResourceAttributeKey")
	})

	it("resource.* group-by drives breakdown specs", () => {
		const result = buildBreakdownQuerySpec(
			metricsDraft({
				addOns: { groupBy: true, having: false, orderBy: false, limit: false, legend: false },
				groupBy: ["resource.host.name"],
			}),
		)
		expect(result.error).toBeNull()
		expect(result.warnings).toEqual([])
		expect((result.query as { groupBy?: string } | null)?.groupBy).toBe("resource_attribute")
	})
})

describe("has_error tri-state (MAP-49)", () => {
	const errorsOnlyOf = (whereClause: string) => {
		const result = buildTimeseriesQuerySpec(tracesDraft({ whereClause }))
		return (result.query as { filters?: { errorsOnly?: boolean } } | null)?.filters?.errorsOnly
	}

	it("has_error = true → errorsOnly: true", () => {
		expect(errorsOnlyOf("has_error = true")).toBe(true)
	})

	it("has_error = false survives as errorsOnly: false (not dropped)", () => {
		expect(errorsOnlyOf("has_error = false")).toBe(false)
	})

	it("absent clause leaves errorsOnly unset", () => {
		expect(errorsOnlyOf("")).toBeUndefined()
	})
})
