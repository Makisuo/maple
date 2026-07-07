import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { OrgId } from "@maple/domain/http"
import { compilePipeQuery } from "./pipe-dispatch"

const asOrgId = Schema.decodeUnknownSync(OrgId)

const baseParams = () => ({
	org_id: asOrgId("test-org"),
	start_time: "2024-01-01 00:00:00",
	end_time: "2024-01-02 00:00:00",
})

describe("compilePipeQuery", () => {
	describe("returns compiled SQL for known pipes", () => {
		const knownPipes = [
			"list_traces",
			"span_hierarchy",
			"traces_duration_stats",
			"traces_facets",
			"list_logs",
			"logs_count",
			"logs_facets",
			"error_rate_by_service",
			"service_overview",
			"services_facets",
			"service_releases_timeline",
			"service_apdex_time_series",
			"get_service_usage",
			"service_dependencies",
			"errors_by_type",
			"errors_timeseries",
			"errors_facets",
			"errors_summary",
			"error_detail_traces",
			"list_metrics",
			"metrics_summary",
			"span_attribute_keys",
			"resource_attribute_keys",
			"metric_attribute_keys",
			"span_attribute_values",
			"resource_attribute_values",
			"metric_attribute_values",
			"custom_traces_timeseries",
			"custom_traces_breakdown",
			"top_operations",
			"slow_traces",
			"span_search",
		] as const

		for (const pipe of knownPipes) {
			it(pipe, () => {
				const result = compilePipeQuery(pipe, {
					...baseParams(),
					trace_id: "abc123",
					service_name: "my-svc",
					fingerprint_hash: "12345",
					attribute_key: "http.method",
					bucket_seconds: 60,
				})
				expect(result).toBeDefined()
				expect(result!.sql).toContain("test-org")
				expect(typeof result!.castRows).toBe("function")
				expect(typeof result!.decodeRows).toBe("function")
			})
		}
	})

	it("returns undefined for unknown pipes", () => {
		const result = compilePipeQuery("nonexistent_pipe", baseParams())
		expect(result).toBeUndefined()
	})

	it("metric_attribute_values reads metric-scoped values for the given key", () => {
		const result = compilePipeQuery("metric_attribute_values", {
			...baseParams(),
			attribute_key: "group",
			limit: 50,
		})
		expect(result).toBeDefined()
		expect(result!.sql).toContain("attribute_values_hourly")
		expect(result!.sql).toContain("'metric'")
		expect(result!.sql).toContain("group")
	})

	it("metric_attribute_keys routes to the raw table when metric_name + metric_type are set", () => {
		const result = compilePipeQuery("metric_attribute_keys", {
			...baseParams(),
			metric_name: "http.server.duration",
			metric_type: "gauge",
		})
		expect(result).toBeDefined()
		expect(result!.sql).toContain("metrics_gauge")
		expect(result!.sql).toContain("arrayJoin(mapKeys(Attributes))")
		expect(result!.sql).toContain("MetricName = 'http.server.duration'")
	})

	it("metric_attribute_keys ignores an invalid metric_type and stays on the rollup", () => {
		const result = compilePipeQuery("metric_attribute_keys", {
			...baseParams(),
			metric_name: "http.server.duration",
			metric_type: "not-a-type",
		})
		expect(result).toBeDefined()
		expect(result!.sql).toContain("attribute_keys_hourly")
	})

	it("metric_attribute_values routes to the raw table when metric_name + metric_type are set", () => {
		const result = compilePipeQuery("metric_attribute_values", {
			...baseParams(),
			attribute_key: "group",
			metric_name: "http.server.duration",
			metric_type: "sum",
		})
		expect(result).toBeDefined()
		expect(result!.sql).toContain("metrics_sum")
		expect(result!.sql).toContain("Attributes['group']")
		expect(result!.sql).toContain("MetricName = 'http.server.duration'")
	})

	describe("logs free-text search param", () => {
		// The dispatch reads `str("search")` for both list_logs and logs_count;
		// callers must emit `search` (not `body_search`) or the filter is dropped.
		for (const pipe of ["list_logs", "logs_count"] as const) {
			it(`${pipe} applies a Body ILIKE filter from the search param`, () => {
				const result = compilePipeQuery(pipe, { ...baseParams(), search: "boom" })
				expect(result).toBeDefined()
				expect(result!.sql).toContain("Body ILIKE '%boom%'")
			})

			it(`${pipe} ignores the stale body_search key`, () => {
				const result = compilePipeQuery(pipe, { ...baseParams(), body_search: "boom" })
				expect(result).toBeDefined()
				expect(result!.sql).not.toContain("Body ILIKE")
			})
		}
	})

	it("injects OrgId into SQL", () => {
		const result = compilePipeQuery("list_traces", baseParams())
		expect(result!.sql).toContain("test-org")
	})

	it("injects start_time and end_time into SQL", () => {
		const result = compilePipeQuery("list_traces", baseParams())
		expect(result!.sql).toContain("2024-01-01 00:00:00")
		expect(result!.sql).toContain("2024-01-02 00:00:00")
	})

	it("castRows passes through rows", () => {
		const result = compilePipeQuery("list_traces", baseParams())
		const rows = [{ traceId: "abc" }]
		expect(result!.castRows(rows)).toEqual(rows)
	})

	it.effect("decodeRows passes through rows for DSL-backed pipes without row schemas", () =>
		Effect.gen(function* () {
			const result = compilePipeQuery("list_traces", baseParams())
			const rows = [{ traceId: "abc" }]
			expect(yield* result!.decodeRows(rows)).toEqual(rows)
		}),
	)

	describe("compare pipes (UNION ALL with period discriminator)", () => {
		const compareParams = () => ({
			org_id: asOrgId("test-org"),
			current_start_time: "2024-01-08 00:00:00",
			current_end_time: "2024-01-15 00:00:00",
			previous_start_time: "2024-01-01 00:00:00",
			previous_end_time: "2024-01-08 00:00:00",
		})

		it("service_overview_compare wraps both windows into one SQL", () => {
			const result = compilePipeQuery("service_overview_compare", compareParams())
			expect(result).toBeDefined()
			const sql = result!.sql
			expect(sql).toContain("'current' AS period")
			expect(sql).toContain("'previous' AS period")
			expect(sql).toContain("UNION ALL")
			expect(sql).toContain("2024-01-08 00:00:00")
			expect(sql).toContain("2024-01-15 00:00:00")
			expect(sql).toContain("2024-01-01 00:00:00")
			expect(sql).toContain("test-org")
			expect(sql).toMatch(/FORMAT JSON\s*$/)
		})

		it("get_service_usage_compare wraps both windows into one SQL", () => {
			const result = compilePipeQuery("get_service_usage_compare", compareParams())
			expect(result).toBeDefined()
			const sql = result!.sql
			expect(sql).toContain("'current' AS period")
			expect(sql).toContain("'previous' AS period")
			expect(sql).toContain("UNION ALL")
			expect(sql).toContain("2024-01-08 00:00:00")
			expect(sql).toContain("2024-01-01 00:00:00")
			expect(sql).toContain("test-org")
			expect(sql).toMatch(/FORMAT JSON\s*$/)
		})

		it("service_overview_compare honors environments and commit_shas filters", () => {
			const result = compilePipeQuery("service_overview_compare", {
				...compareParams(),
				environments: "prod,staging",
				commit_shas: "abc123,def456",
			})
			expect(result).toBeDefined()
			expect(result!.sql).toContain("prod")
			expect(result!.sql).toContain("staging")
			expect(result!.sql).toContain("abc123")
			expect(result!.sql).toContain("def456")
		})

		it("get_service_usage_compare honors service filter", () => {
			const result = compilePipeQuery("get_service_usage_compare", {
				...compareParams(),
				service: "api-gateway",
			})
			expect(result).toBeDefined()
			expect(result!.sql).toContain("api-gateway")
		})
	})
})

describe("buildAttributeFiltersFromParams", () => {
	it("parses attribute filters with numbered suffixes", () => {
		const result = compilePipeQuery("custom_traces_timeseries", {
			...baseParams(),
			attribute_filter_key: "http.method",
			attribute_filter_value: "GET",
			attribute_filter_key_2: "http.status_code",
			attribute_filter_value_2: "200",
		})
		expect(result).toBeDefined()
		expect(result!.sql).toContain("http.method")
		expect(result!.sql).toContain("GET")
		expect(result!.sql).toContain("http.status_code")
		expect(result!.sql).toContain("200")
	})

	it("parses resource filters with numbered suffixes", () => {
		const result = compilePipeQuery("custom_traces_timeseries", {
			...baseParams(),
			resource_filter_key: "service.name",
			resource_filter_value: "api",
		})
		expect(result).toBeDefined()
		expect(result!.sql).toContain("service.name")
	})

	it("returns no filters when no filter keys present", () => {
		const result = compilePipeQuery("custom_traces_timeseries", baseParams())
		expect(result).toBeDefined()
		// Should compile without errors even with no filters
		expect(result!.sql).toBeTruthy()
	})

	it("handles exists mode filters", () => {
		const result = compilePipeQuery("custom_traces_timeseries", {
			...baseParams(),
			attribute_filter_key: "http.method",
			attribute_filter_exists: "1",
		})
		expect(result).toBeDefined()
		expect(result!.sql).toContain("http.method")
	})
})
