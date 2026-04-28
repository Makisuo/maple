import { describe, expect, it } from "vitest"
import { buildTimeseriesQuerySpec, createQueryDraft } from "@/lib/query-builder/model"

describe("query-builder model bucket parsing", () => {
	it("defaults new drafts to auto-bucket", () => {
		expect(createQueryDraft(0).stepInterval).toBe("")
	})

	it("parses hour shorthand step intervals", () => {
		const query = {
			...createQueryDraft(0),
			dataSource: "traces" as const,
			aggregation: "count",
			stepInterval: "1h",
		}

		const built = buildTimeseriesQuerySpec(query)
		expect(built.error).toBeNull()
		expect(built.query?.kind).toBe("timeseries")
		if (built.query?.kind !== "timeseries") {
			return
		}

		expect(built.query.bucketSeconds).toBe(3600)
	})

	it("parses minute shorthand step intervals", () => {
		const query = {
			...createQueryDraft(0),
			dataSource: "logs" as const,
			aggregation: "count",
			stepInterval: "5m",
		}

		const built = buildTimeseriesQuerySpec(query)
		expect(built.error).toBeNull()
		expect(built.query?.kind).toBe("timeseries")
		if (built.query?.kind !== "timeseries") {
			return
		}

		expect(built.query.bucketSeconds).toBe(300)
	})

	it("keeps invalid shorthand as auto-bucket with warning", () => {
		const query = {
			...createQueryDraft(0),
			dataSource: "traces" as const,
			aggregation: "count",
			stepInterval: "soon",
		}

		const built = buildTimeseriesQuerySpec(query)
		expect(built.error).toBeNull()
		expect(built.query?.kind).toBe("timeseries")
		if (built.query?.kind !== "timeseries") {
			return
		}

		expect(built.query.bucketSeconds).toBeUndefined()
		expect(built.warnings.some((warning) => warning.includes("Invalid step interval ignored"))).toBe(true)
	})

	it("dedupes repeated attribute group-by keys while preserving selected attributes", () => {
		const query = {
			...createQueryDraft(0),
			dataSource: "traces" as const,
			aggregation: "count",
			whereClause: 'service.name = "openrev-integrations" AND root_only = true',
			groupBy: ["attr.http.response.status_code", "attr.http.request.header.integration_id"],
			addOns: {
				groupBy: true,
				having: false,
				orderBy: false,
				limit: false,
				legend: false,
			},
		}

		const built = buildTimeseriesQuerySpec(query)
		expect(built.error).toBeNull()
		expect(built.query?.kind).toBe("timeseries")
		if (built.query?.kind !== "timeseries" || built.query.source !== "traces") {
			return
		}

		expect(built.query.groupBy).toEqual(["attribute"])
		expect(built.query.filters?.rootSpansOnly).toBe(true)
		expect(built.query.filters?.groupByAttributeKeys).toEqual([
			"http.response.status_code",
			"http.request.header.integration_id",
		])
	})
})
