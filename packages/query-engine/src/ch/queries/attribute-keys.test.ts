import { describe, expect, it } from "vitest"
import { compileCH } from "@maple-dev/clickhouse-builder"
import {
	attributeKeysQuery,
	logAttributeValuesQuery,
	metricAttributeValuesQuery,
	metricScopedAttributeKeysQuery,
	metricScopedAttributeValuesQuery,
	resourceAttributeValuesQuery,
	spanAttributeValuesQuery,
} from "./attribute-keys"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
}

// ---------------------------------------------------------------------------
// attributeKeysQuery
// ---------------------------------------------------------------------------

describe("attributeKeysQuery", () => {
	it("compiles basic attribute keys query", () => {
		const q = attributeKeysQuery({ scope: "span" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM attribute_keys_hourly")
		expect(sql).toContain("AttributeKey AS attributeKey")
		expect(sql).toContain("sum(UsageCount) AS usageCount")
		expect(sql).toContain("AttributeScope = 'span'")
		expect(sql).toContain("GROUP BY attributeKey")
		expect(sql).toContain("ORDER BY usageCount DESC")
		expect(sql).toContain("LIMIT 200")
		expect(sql).toContain("FORMAT JSON")
		expect(sql).not.toMatch(/__PARAM_\w+__/)
	})

	it("interpolates the scope literal for resource", () => {
		const q = attributeKeysQuery({ scope: "resource" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("AttributeScope = 'resource'")
		expect(sql).not.toMatch(/__PARAM_\w+__/)
	})

	it("interpolates the scope literal for metric", () => {
		const q = attributeKeysQuery({ scope: "metric" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("AttributeScope = 'metric'")
		expect(sql).not.toMatch(/__PARAM_\w+__/)
	})

	it("applies custom limit", () => {
		const q = attributeKeysQuery({ scope: "resource", limit: 50 })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("LIMIT 50")
	})
})

// ---------------------------------------------------------------------------
// spanAttributeValuesQuery
// ---------------------------------------------------------------------------

describe("spanAttributeValuesQuery", () => {
	it("compiles span attribute values", () => {
		const q = spanAttributeValuesQuery({ attributeKey: "http.method" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM attribute_values_hourly")
		expect(sql).toContain("AttributeValue AS attributeValue")
		expect(sql).toContain("sum(UsageCount) AS usageCount")
		expect(sql).toContain("AttributeScope = 'span'")
		expect(sql).toContain("AttributeKey = 'http.method'")
		expect(sql).toContain("GROUP BY attributeValue")
		expect(sql).toContain("ORDER BY usageCount DESC")
		expect(sql).toContain("LIMIT 50")
		expect(sql).toContain("FORMAT JSON")
	})

	it("applies custom limit", () => {
		const q = spanAttributeValuesQuery({ attributeKey: "http.method", limit: 100 })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("LIMIT 100")
	})
})

// ---------------------------------------------------------------------------
// resourceAttributeValuesQuery
// ---------------------------------------------------------------------------

describe("resourceAttributeValuesQuery", () => {
	it("compiles resource attribute values", () => {
		const q = resourceAttributeValuesQuery({ attributeKey: "host.name" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM attribute_values_hourly")
		expect(sql).toContain("AttributeValue AS attributeValue")
		expect(sql).toContain("AttributeScope = 'resource'")
		expect(sql).toContain("AttributeKey = 'host.name'")
		expect(sql).toContain("GROUP BY attributeValue")
		expect(sql).toContain("ORDER BY usageCount DESC")
	})
})

// ---------------------------------------------------------------------------
// logAttributeValuesQuery
// ---------------------------------------------------------------------------

describe("logAttributeValuesQuery", () => {
	it("compiles log attribute values", () => {
		const q = logAttributeValuesQuery({ attributeKey: "user.id" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM attribute_values_hourly")
		expect(sql).toContain("AttributeValue AS attributeValue")
		expect(sql).toContain("AttributeScope = 'log'")
		expect(sql).toContain("AttributeKey = 'user.id'")
		expect(sql).toContain("LIMIT 50")
	})
})

// ---------------------------------------------------------------------------
// metricAttributeValuesQuery
// ---------------------------------------------------------------------------

describe("metricAttributeValuesQuery", () => {
	it("compiles metric attribute values", () => {
		const q = metricAttributeValuesQuery({ attributeKey: "deployment.environment" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM attribute_values_hourly")
		expect(sql).toContain("AttributeScope = 'metric'")
		expect(sql).toContain("AttributeKey = 'deployment.environment'")
	})
})

// ---------------------------------------------------------------------------
// metricScopedAttributeKeysQuery
// ---------------------------------------------------------------------------

const scopedParams = { ...baseParams, metricName: "http.server.duration" }

describe("metricScopedAttributeKeysQuery", () => {
	it("reads the raw table for the metric type and filters by MetricName", () => {
		const q = metricScopedAttributeKeysQuery({ metricType: "gauge" })
		const { sql } = compileCH(q, scopedParams)
		expect(sql).toContain("FROM metrics_gauge")
		expect(sql).toContain("arrayJoin(mapKeys(Attributes)) AS attributeKey")
		expect(sql).toContain("count() AS usageCount")
		expect(sql).toContain("MetricName = 'http.server.duration'")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("GROUP BY attributeKey")
		expect(sql).toContain("ORDER BY usageCount DESC")
		expect(sql).toContain("LIMIT 200")
		expect(sql).not.toMatch(/__PARAM_\w+__/)
	})

	it("resolves each metric type to its table", () => {
		for (const [metricType, tableName] of [
			["sum", "metrics_sum"],
			["histogram", "metrics_histogram"],
			["exponential_histogram", "metrics_exponential_histogram"],
		] as const) {
			const { sql } = compileCH(metricScopedAttributeKeysQuery({ metricType }), scopedParams)
			expect(sql).toContain(`FROM ${tableName}`)
		}
	})

	it("applies custom limit", () => {
		const q = metricScopedAttributeKeysQuery({ metricType: "sum", limit: 25 })
		const { sql } = compileCH(q, scopedParams)
		expect(sql).toContain("LIMIT 25")
	})
})

// ---------------------------------------------------------------------------
// metricScopedAttributeValuesQuery
// ---------------------------------------------------------------------------

describe("metricScopedAttributeValuesQuery", () => {
	it("groups by the map value for the requested key, filtered by MetricName", () => {
		const q = metricScopedAttributeValuesQuery({
			metricType: "sum",
			attributeKey: "deployment.environment",
		})
		const { sql } = compileCH(q, scopedParams)
		expect(sql).toContain("FROM metrics_sum")
		expect(sql).toContain("Attributes['deployment.environment'] AS attributeValue")
		expect(sql).toContain("MetricName = 'http.server.duration'")
		expect(sql).toContain("Attributes['deployment.environment'] != ''")
		expect(sql).toContain("GROUP BY attributeValue")
		expect(sql).toContain("ORDER BY usageCount DESC")
		expect(sql).toContain("LIMIT 50")
		expect(sql).not.toMatch(/__PARAM_\w+__/)
	})
})
