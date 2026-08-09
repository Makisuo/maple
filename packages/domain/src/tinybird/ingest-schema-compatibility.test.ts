import { describe, expect, it } from "vitest"
import { datasources, pipes } from "../generated/tinybird-project-manifest"

describe("Tinybird Events API schema compatibility", () => {
	it("never combines JSONPaths with aggregate-state column types", () => {
		for (const datasource of datasources) {
			if (!datasource.content.includes("`json:$")) continue

			expect(datasource.content, datasource.name).not.toMatch(/\b(?:Simple)?AggregateFunction\s*\(/)
		}
	})

	it("bridges direct service-map writes through a zero-retention plain schema", () => {
		const ingress = datasources.find(({ name }) => name === "service_map_edges_hourly_ingest")
		const target = datasources.find(({ name }) => name === "service_map_edges_hourly")
		const bridge = pipes.find(({ name }) => name === "service_map_edges_hourly_ingest_mv")

		expect(ingress?.content).toContain("ENGINE Null")
		expect(ingress?.content).toContain("CallCount UInt64 `json:$.CallCount`")
		expect(ingress?.content).not.toContain("AggregateFunction(")

		expect(target?.content).toContain("CallCount SimpleAggregateFunction(sum, UInt64)")
		expect(target?.content).not.toContain("`json:$")
		expect(target?.content).toContain("FORWARD_QUERY >\n    SELECT *")

		expect(bridge?.content).toContain("FROM service_map_edges_hourly_ingest")
		expect(bridge?.content).toContain("DATASOURCE service_map_edges_hourly")
	})

	it("keeps deployed materialized-pipe triggers stable", () => {
		const timeOrderedErrors = pipes.find(({ name }) => name === "error_events_by_time_mv")
		const minutelyErrors = pipes.find(({ name }) => name === "error_fingerprints_minutely_mv")

		// Tinybird rejects changing the trigger datasource of an existing
		// materialized pipe. This long-lived pipe was deployed from traces.
		expect(timeOrderedErrors?.content).toContain("FROM traces")
		expect(timeOrderedErrors?.content).not.toContain("FROM error_events")

		// New rollups may cascade from an existing projection without mutating the
		// trigger of that projection's established sibling pipe.
		expect(minutelyErrors?.content).toContain("FROM error_events")
		expect(minutelyErrors?.content).toContain("DATASOURCE error_fingerprints_minutely")
	})
})
