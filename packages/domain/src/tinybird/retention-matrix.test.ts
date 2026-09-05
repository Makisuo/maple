import { describe, expect, it } from "vitest"
import { tinybirdProjectManifest } from "../generated/tinybird-project-manifest"

const RETENTION_DAYS = {
	alert_checks: 365,
	// Raw-tier sibling of trace_detail_spans: rebuilt from `traces`, so holding
	// it past the source's own retention would store rows detection can no
	// longer cross-check against a raw trace.
	ai_trace_index: 30,
	// Six years — HIPAA's documentation retention floor. Never rebuildable.
	audit_log: 2190,
	attribute_keys_hourly: 90,
	attribute_values_hourly: 90,
	error_events: 90,
	error_events_by_time: 90,
	error_fingerprints_minutely: 90,
	logs: 30,
	logs_aggregates_hourly: 365,
	metric_catalog: 90,
	metrics_exponential_histogram: 90,
	metrics_gauge: 90,
	metrics_histogram: 90,
	metrics_sum: 90,
	service_address_resolutions_hourly: 365,
	service_external_edges_hourly: 365,
	service_map_children: 30,
	service_map_db_edges_hourly: 365,
	service_map_db_query_shapes_hourly: 365,
	service_map_edges_hourly: 365,
	service_map_spans: 30,
	service_operations_hourly: 365,
	service_operations_minutely: 90,
	service_overview_hourly: 365,
	// Only reachable for windows under ~5 days (sub-hour buckets), so 90 is
	// generous rather than tight. A second annual tier here would be a second
	// table that cannot be rebuilt past the 30-day source retention.
	service_overview_minutely: 90,
	service_overview_spans: 30,
	service_platforms_hourly: 365,
	service_usage: 365,
	session_events: 30,
	session_replay_events: 30,
	session_replays: 30,
	span_metrics_calls_hourly: 90,
	trace_detail_spans: 30,
	trace_list_mv: 30,
	traces: 30,
	traces_aggregates_hourly: 365,
	// Browser rows past 30 days can never be rebuilt from `session_events`, but
	// direct-ingested (server/mobile) rows have no source: this table IS the copy.
	product_events: 365,
	identity_links: 365,
} as const

const ZERO_RETENTION_DATASOURCES = ["service_map_edges_hourly_ingest"] as const

describe("Tinybird retention matrix", () => {
	it("assigns every stored datasource to the intended 30/90/365-day tier", () => {
		const actualNames = tinybirdProjectManifest.datasources.map(({ name }) => name).sort()
		expect(actualNames).toEqual([...Object.keys(RETENTION_DAYS), ...ZERO_RETENTION_DATASOURCES].sort())

		for (const [name, expectedDays] of Object.entries(RETENTION_DAYS)) {
			const datasource = tinybirdProjectManifest.datasources.find(
				(candidate) => candidate.name === name,
			)
			expect(datasource, name).toBeDefined()
			expect(datasource!.content, datasource!.name).toMatch(
				new RegExp(`ENGINE_TTL "[^"]+ \\+ INTERVAL ${expectedDays} DAY"`),
			)
		}
	})

	it("does not retain Null-engine ingestion bridges", () => {
		for (const name of ZERO_RETENTION_DATASOURCES) {
			const datasource = tinybirdProjectManifest.datasources.find(
				(candidate) => candidate.name === name,
			)
			expect(datasource, name).toBeDefined()
			expect(datasource?.content, name).toContain("ENGINE Null")
			expect(datasource?.content, name).not.toContain("ENGINE_TTL")
		}
	})

	it("does not retain completed forward queries on ALTER-compatible annual rollups", () => {
		const alterCompatibleRollups = [
			"service_map_db_edges_hourly",
			"service_map_db_query_shapes_hourly",
			"service_operations_minutely",
			"service_platforms_hourly",
		]

		for (const name of alterCompatibleRollups) {
			const datasource = tinybirdProjectManifest.datasources.find(
				(candidate) => candidate.name === name,
			)
			expect(datasource, name).toBeDefined()
			expect(datasource?.content, name).not.toContain("FORWARD_QUERY")
		}
	})

	/**
	 * A materialized view whose target outlives its source cannot be rebuilt.
	 *
	 * Tinybird's default for a changed MV node is to REPLAY the source into the
	 * target. For these two that means `traces` (30 days) into a 90-day rollup,
	 * and that 90-day rollup into a 365-day one — so the deploy warns and then
	 * drops history that no longer exists anywhere to be reconstructed from.
	 * `DEPLOYMENT_METHOD alter` applies additive column changes in place with no
	 * data movement, which is the only correct shape here. Migration 0023's first
	 * deploy attempt failed on exactly this.
	 */
	it("applies service-operations rollup changes by ALTER, never by rebuild", () => {
		for (const name of ["service_operations_minutely_mv", "service_operations_hourly_mv"]) {
			const pipe = tinybirdProjectManifest.pipes.find((candidate) => candidate.name === name)
			expect(pipe, name).toBeDefined()
			expect(pipe?.content, name).toContain("DEPLOYMENT_METHOD alter")
		}
	})

	it("preserves longer-lived aggregates while raw logs are rebuilt", () => {
		const migrationForwardQueries = [
			"logs",
			"attribute_keys_hourly",
			"attribute_values_hourly",
			"logs_aggregates_hourly",
		]

		for (const name of migrationForwardQueries) {
			const datasource = tinybirdProjectManifest.datasources.find(
				(candidate) => candidate.name === name,
			)
			expect(datasource, name).toBeDefined()
			expect(datasource?.content, name).toContain("FORWARD_QUERY")
		}
	})
})
