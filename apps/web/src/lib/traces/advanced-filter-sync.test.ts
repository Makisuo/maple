import { describe, expect, it } from "vitest"

import { applyWhereClause, parseWhereClause, toWhereClause } from "@/lib/traces/advanced-filter-sync"

describe("parseWhereClause", () => {
	it("parses service.name", () => {
		const { filters } = parseWhereClause('service.name = "checkout"')
		expect(filters.service).toBe("checkout")
	})

	it("parses service alias", () => {
		const { filters } = parseWhereClause('service = "checkout"')
		expect(filters.service).toBe("checkout")
	})

	it("parses span.name", () => {
		const { filters } = parseWhereClause('span.name = "GET /orders"')
		expect(filters.spanName).toBe("GET /orders")
	})

	it("parses deployment.environment and aliases", () => {
		expect(parseWhereClause('deployment.environment = "production"').filters.deploymentEnv).toBe(
			"production",
		)
		expect(parseWhereClause('environment = "staging"').filters.deploymentEnv).toBe("staging")
		expect(parseWhereClause('env = "dev"').filters.deploymentEnv).toBe("dev")
	})

	it("parses http.method and http.status_code", () => {
		const { filters } = parseWhereClause('http.method = "POST" AND http.status_code = "404"')
		expect(filters.httpMethod).toBe("POST")
		expect(filters.httpStatusCode).toBe("404")
	})

	it("parses has_error = true", () => {
		const { filters } = parseWhereClause("has_error = true")
		expect(filters.hasError).toBe(true)
	})

	it("drops has_error = false", () => {
		const { filters } = parseWhereClause("has_error = false")
		expect(filters.hasError).toBeUndefined()
	})

	it("parses root_only = false", () => {
		const { filters } = parseWhereClause("root_only = false")
		expect(filters.rootOnly).toBe(false)
	})

	it("drops root_only = true", () => {
		const { filters } = parseWhereClause("root_only = true")
		expect(filters.rootOnly).toBeUndefined()
	})

	it("parses duration bounds", () => {
		const { filters } = parseWhereClause("min_duration_ms = 25 AND max_duration_ms = 1500")
		expect(filters.minDurationMs).toBe(25)
		expect(filters.maxDurationMs).toBe(1500)
	})

	it("parses attr.* keys", () => {
		const { filters } = parseWhereClause('attr.http.route = "/orders/:id"')
		expect(filters.attributeFilters).toEqual([
			{ key: "http.route", value: "/orders/:id", matchMode: undefined },
		])
	})

	it("parses resource.* keys", () => {
		const { filters } = parseWhereClause('resource.service.version = "1.2.3"')
		expect(filters.resourceAttributeFilters).toEqual([
			{ key: "service.version", value: "1.2.3", matchMode: undefined },
		])
	})

	it("parses combined attr.* and resource.* keys", () => {
		const { filters } = parseWhereClause(
			'attr.http.route = "/orders/:id" AND resource.telemetry.sdk.name = "opentelemetry"',
		)
		expect(filters.attributeFilters).toEqual([
			{ key: "http.route", value: "/orders/:id", matchMode: undefined },
		])
		expect(filters.resourceAttributeFilters).toEqual([
			{ key: "telemetry.sdk.name", value: "opentelemetry", matchMode: undefined },
		])
	})

	it("parses multiple attr.* filters", () => {
		const { filters } = parseWhereClause(
			'attr.http.route = "/api" AND attr.db.system = "postgresql" AND attr.http.method = "POST"',
		)
		expect(filters.attributeFilters).toEqual([
			{ key: "http.route", value: "/api", matchMode: undefined },
			{ key: "db.system", value: "postgresql", matchMode: undefined },
			{ key: "http.method", value: "POST", matchMode: undefined },
		])
	})

	it("parses multiple resource.* filters", () => {
		const { filters } = parseWhereClause(
			'resource.service.version = "1.0" AND resource.deployment.environment = "prod"',
		)
		expect(filters.resourceAttributeFilters).toEqual([
			{ key: "service.version", value: "1.0", matchMode: undefined },
			{ key: "deployment.environment", value: "prod", matchMode: undefined },
		])
	})

	it("caps attr.* filters at 5", () => {
		const clause = Array.from({ length: 7 }, (_, i) => `attr.key${i} = "val${i}"`).join(" AND ")
		const { filters } = parseWhereClause(clause)
		expect(filters.attributeFilters).toHaveLength(5)
		expect(filters.attributeFilters[4].key).toBe("key4")
	})

	it("marks incomplete clauses for unclosed quotes", () => {
		const result = parseWhereClause('service.name = "check')
		expect(result.hasIncompleteClauses).toBe(true)
	})

	it("marks invalid number as incomplete", () => {
		const result = parseWhereClause("min_duration_ms = nope")
		expect(result.hasIncompleteClauses).toBe(true)
		expect(result.filters.minDurationMs).toBeUndefined()
	})

	it("returns empty for empty input", () => {
		const result = parseWhereClause("")
		expect(result.filters.attributeFilters).toEqual([])
		expect(result.filters.resourceAttributeFilters).toEqual([])
		expect(result.hasIncompleteClauses).toBe(false)
	})

	it("parses a full combined clause", () => {
		const { filters } = parseWhereClause(
			'service = "checkout" AND span = "GET /orders" AND env = "production" AND http.method = "POST" AND http.status_code = "404" AND has_error = true AND root_only = false AND min_duration_ms = 12.5 AND max_duration_ms = 88 AND attr.http.route = "/api/orders"',
		)

		expect(filters.service).toBe("checkout")
		expect(filters.spanName).toBe("GET /orders")
		expect(filters.deploymentEnv).toBe("production")
		expect(filters.httpMethod).toBe("POST")
		expect(filters.httpStatusCode).toBe("404")
		expect(filters.hasError).toBe(true)
		expect(filters.rootOnly).toBe(false)
		expect(filters.minDurationMs).toBe(12.5)
		expect(filters.maxDurationMs).toBe(88)
		expect(filters.attributeFilters[0].key).toBe("http.route")
		expect(filters.attributeFilters[0].value).toBe("/api/orders")
	})

	it("parses contains operator for service.name", () => {
		const { filters } = parseWhereClause('service.name contains "check"')
		expect(filters.service).toBe("check")
		expect(filters.matchModes).toEqual({ service: "contains" })
	})

	it("parses contains operator for span.name", () => {
		const { filters } = parseWhereClause('span.name contains "GET"')
		expect(filters.spanName).toBe("GET")
		expect(filters.matchModes).toEqual({ spanName: "contains" })
	})

	it("parses contains operator case-insensitively", () => {
		const { filters } = parseWhereClause('service.name CONTAINS "check"')
		expect(filters.service).toBe("check")
		expect(filters.matchModes).toEqual({ service: "contains" })
	})

	it("parses mixed = and contains operators", () => {
		const { filters } = parseWhereClause('service.name contains "check" AND span.name = "GET /orders"')
		expect(filters.service).toBe("check")
		expect(filters.spanName).toBe("GET /orders")
		expect(filters.matchModes).toEqual({ service: "contains" })
	})

	it("parses contains for attr.* keys", () => {
		const { filters } = parseWhereClause('attr.http.route contains "/api"')
		expect(filters.attributeFilters).toEqual([
			{ key: "http.route", value: "/api", matchMode: "contains" },
		])
	})

	it("parses contains for resource.* keys", () => {
		const { filters } = parseWhereClause('resource.service.version contains "1.2"')
		expect(filters.resourceAttributeFilters).toEqual([
			{ key: "service.version", value: "1.2", matchMode: "contains" },
		])
	})

	it("does not set matchModes for = operator", () => {
		const { filters } = parseWhereClause('service.name = "checkout"')
		expect(filters.service).toBe("checkout")
		expect(filters.matchModes).toBeUndefined()
	})

	it("routes != on named fields to excluded* arrays", () => {
		const { filters } = parseWhereClause('service.name != "checkout" AND span.name != "GET /health"')
		expect(filters.excludedServices).toEqual(["checkout"])
		expect(filters.excludedSpanNames).toEqual(["GET /health"])
		expect(filters.service).toBeUndefined()
		expect(filters.spanName).toBeUndefined()
	})

	it("marks attr.* filters as negated for !=", () => {
		const { filters } = parseWhereClause('attr.env != "prod"')
		expect(filters.attributeFilters).toEqual([
			{ key: "env", value: "prod", matchMode: undefined, negated: true },
		])
	})

	it("marks attr.* filters as negated for !contains", () => {
		const { filters } = parseWhereClause('attr.http.route !contains "/health"')
		expect(filters.attributeFilters).toEqual([
			{ key: "http.route", value: "/health", matchMode: "contains", negated: true },
		])
	})

	it("aggregates multiple excluded values for the same field", () => {
		const { filters } = parseWhereClause('service.name != "checkout" AND service.name != "billing"')
		expect(filters.excludedServices).toEqual(["checkout", "billing"])
	})
})

describe("toWhereClause", () => {
	it("builds a where clause from filters", () => {
		const clause = toWhereClause({
			service: "checkout",
			spanName: "GET /orders",
			hasError: true,
			minDurationMs: 25,
			attributeFilters: [],
			resourceAttributeFilters: [],
		})
		expect(clause).toBe(
			'service.name = "checkout" AND span.name = "GET /orders" AND has_error = true AND min_duration_ms = 25',
		)
	})

	it("returns undefined for empty filters", () => {
		expect(toWhereClause({ attributeFilters: [], resourceAttributeFilters: [] })).toBeUndefined()
	})

	it("includes attr.* clauses", () => {
		const clause = toWhereClause({
			attributeFilters: [{ key: "http.route", value: "/orders/:id" }],
			resourceAttributeFilters: [],
		})
		expect(clause).toBe('attr.http.route = "/orders/:id"')
	})

	it("includes resource.* clauses", () => {
		const clause = toWhereClause({
			attributeFilters: [],
			resourceAttributeFilters: [{ key: "service.version", value: "1.2.3" }],
		})
		expect(clause).toBe('resource.service.version = "1.2.3"')
	})

	it("includes both attr.* and resource.* clauses", () => {
		const clause = toWhereClause({
			attributeFilters: [{ key: "http.route", value: "/orders/:id" }],
			resourceAttributeFilters: [{ key: "service.version", value: "1.2.3" }],
		})
		expect(clause).toBe('attr.http.route = "/orders/:id" AND resource.service.version = "1.2.3"')
	})

	it("includes multiple attr.* clauses", () => {
		const clause = toWhereClause({
			attributeFilters: [
				{ key: "http.route", value: "/api" },
				{ key: "db.system", value: "postgresql" },
			],
			resourceAttributeFilters: [],
		})
		expect(clause).toBe('attr.http.route = "/api" AND attr.db.system = "postgresql"')
	})

	it("uses contains operator when matchModes is set", () => {
		const clause = toWhereClause({
			service: "check",
			matchModes: { service: "contains" },
			attributeFilters: [],
			resourceAttributeFilters: [],
		})
		expect(clause).toBe('service.name contains "check"')
	})

	it("mixes = and contains operators", () => {
		const clause = toWhereClause({
			service: "check",
			spanName: "GET /orders",
			matchModes: { service: "contains" },
			attributeFilters: [],
			resourceAttributeFilters: [],
		})
		expect(clause).toBe('service.name contains "check" AND span.name = "GET /orders"')
	})

	it("uses contains for attr.* when matchMode is set per-filter", () => {
		const clause = toWhereClause({
			attributeFilters: [{ key: "http.route", value: "/api", matchMode: "contains" }],
			resourceAttributeFilters: [],
		})
		expect(clause).toBe('attr.http.route contains "/api"')
	})

	it("round-trips multiple attr.* filters", () => {
		const original = 'attr.http.route = "/api" AND attr.db.system contains "postgres"'
		const { filters } = parseWhereClause(original)
		const clause = toWhereClause(filters)
		expect(clause).toBe('attr.http.route = "/api" AND attr.db.system contains "postgres"')
	})

	it("emits != for negated attribute filters", () => {
		const clause = toWhereClause({
			attributeFilters: [{ key: "env", value: "prod", negated: true }],
			resourceAttributeFilters: [],
		})
		expect(clause).toBe('attr.env != "prod"')
	})

	it("emits !contains for negated contains attribute filters", () => {
		const clause = toWhereClause({
			attributeFilters: [{ key: "http.route", value: "/health", matchMode: "contains", negated: true }],
			resourceAttributeFilters: [],
		})
		expect(clause).toBe('attr.http.route !contains "/health"')
	})

	it("emits != clauses for excluded named-field arrays", () => {
		const clause = toWhereClause({
			attributeFilters: [],
			resourceAttributeFilters: [],
			excludedServices: ["checkout"],
			excludedSpanNames: ["GET /health"],
		})
		expect(clause).toBe('service.name != "checkout" AND span.name != "GET /health"')
	})

	it("round-trips negated clauses (canonical emit order: attr.* before excluded named fields)", () => {
		const input =
			'service.name = "api" AND span.name != "GET /health" AND attr.http.route !contains "/health"'
		const { filters } = parseWhereClause(input)
		const clause = toWhereClause(filters)
		expect(clause).toBe(
			'service.name = "api" AND attr.http.route !contains "/health" AND span.name != "GET /health"',
		)
		// And parsing the emitted output yields the same filter state.
		expect(parseWhereClause(clause ?? "").filters).toEqual(filters)
	})
})

describe("applyWhereClause", () => {
	it("merges parsed values into search params", () => {
		const result = applyWhereClause(
			{ startTime: "2026-02-01 00:00:00", endTime: "2026-02-01 01:00:00" },
			'service.name = "checkout" AND has_error = true',
		)

		expect(result.whereClause).toBe('service.name = "checkout" AND has_error = true')
		expect(result.services).toEqual(["checkout"])
		expect(result.hasError).toBe(true)
		expect(result.startTime).toBe("2026-02-01 00:00:00")
		expect(result.endTime).toBe("2026-02-01 01:00:00")
	})

	it("preserves existing search params when clause doesn't override them", () => {
		const result = applyWhereClause(
			{
				services: ["billing"],
				hasError: true,
				startTime: "2026-02-01 00:00:00",
			},
			'span.name = "POST /pay"',
		)

		expect(result.spanNames).toEqual(["POST /pay"])
		expect(result.services).toEqual(["billing"])
		expect(result.hasError).toBe(true)
	})

	it("overrides search params when clause includes them", () => {
		const result = applyWhereClause({ services: ["billing"] }, 'service.name = "checkout"')

		expect(result.services).toEqual(["checkout"])
	})

	it("clears all filter params when clause is empty", () => {
		const result = applyWhereClause(
			{
				services: ["checkout"],
				hasError: true,
				minDurationMs: 100,
				startTime: "2026-02-01 00:00:00",
			},
			"",
		)

		expect(result.whereClause).toBeUndefined()
		expect(result.services).toBeUndefined()
		expect(result.hasError).toBeUndefined()
		expect(result.minDurationMs).toBeUndefined()
		expect(result.startTime).toBe("2026-02-01 00:00:00")
	})

	it("handles incomplete clauses gracefully", () => {
		const result = applyWhereClause({ services: ["billing"] }, 'service.name = "check')

		expect(result.whereClause).toBe('service.name = "check')
		expect(result.services).toEqual(["billing"])
	})

	it("handles whitespace-only clause as empty", () => {
		const result = applyWhereClause({ services: ["checkout"] }, "   ")

		expect(result.whereClause).toBeUndefined()
		expect(result.services).toBeUndefined()
	})

	it("merges resource attribute filters into search params", () => {
		const result = applyWhereClause(
			{ startTime: "2026-02-01 00:00:00" },
			'resource.service.version = "1.2.3"',
		)

		expect(result.resourceAttributeFilters).toEqual([
			{ key: "service.version", value: "1.2.3", matchMode: undefined },
		])
	})

	it("clears resource attribute filters when clause is empty", () => {
		const result = applyWhereClause(
			{ resourceAttributeFilters: [{ key: "service.version", value: "1.2.3" }] },
			"",
		)

		expect(result.resourceAttributeFilters).toBeUndefined()
	})

	it("sets serviceMatchMode when contains is used", () => {
		const result = applyWhereClause({}, 'service.name contains "check"')

		expect(result.services).toEqual(["check"])
		expect(result.serviceMatchMode).toBe("contains")
	})

	it("does not set matchMode for = operator", () => {
		const result = applyWhereClause({}, 'service.name = "checkout"')

		expect(result.services).toEqual(["checkout"])
		expect(result.serviceMatchMode).toBeUndefined()
	})

	it("clears matchMode params when clause is empty", () => {
		const result = applyWhereClause({ serviceMatchMode: "contains" as const }, "")

		expect(result.serviceMatchMode).toBeUndefined()
	})

	it("sets matchMode per attribute filter when contains is used", () => {
		const result = applyWhereClause({}, 'attr.http.route contains "/api"')

		expect(result.attributeFilters).toEqual([{ key: "http.route", value: "/api", matchMode: "contains" }])
	})

	it("merges multiple attribute filters into search params", () => {
		const result = applyWhereClause({}, 'attr.http.route = "/api" AND attr.db.system = "postgresql"')

		expect(result.attributeFilters).toEqual([
			{ key: "http.route", value: "/api", matchMode: undefined },
			{ key: "db.system", value: "postgresql", matchMode: undefined },
		])
	})

	it("merges excluded named-field clauses into excluded* search params", () => {
		const result = applyWhereClause({}, 'service.name != "checkout" AND span.name != "GET /health"')

		expect(result.excludedServices).toEqual(["checkout"])
		expect(result.excludedSpanNames).toEqual(["GET /health"])
	})

	it("merges negated attribute filters", () => {
		const result = applyWhereClause({}, 'attr.http.route !contains "/health"')

		expect(result.attributeFilters).toEqual([
			{ key: "http.route", value: "/health", matchMode: "contains", negated: true },
		])
	})

	it("clears excluded* params when clause is empty", () => {
		const result = applyWhereClause({ excludedServices: ["checkout"] }, "")

		expect(result.excludedServices).toBeUndefined()
	})
})
