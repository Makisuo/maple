import { describe, expect, it } from "vitest"
import { tinybirdProjectManifest } from "../generated/tinybird-project-manifest"

const RETENTION_DAYS = {
	alert_checks: 365,
	attribute_keys_hourly: 90,
	attribute_values_hourly: 90,
	error_events: 90,
	error_events_by_time: 90,
	error_spans: 90,
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
} as const

describe("Tinybird retention matrix", () => {
	it("assigns every datasource to the intended 30/90/365-day tier", () => {
		const actualNames = tinybirdProjectManifest.datasources.map(({ name }) => name).sort()
		expect(actualNames).toEqual(Object.keys(RETENTION_DAYS).sort())

		for (const datasource of tinybirdProjectManifest.datasources) {
			const expectedDays = RETENTION_DAYS[datasource.name as keyof typeof RETENTION_DAYS]
			expect(datasource.content, datasource.name).toMatch(
				new RegExp(`ENGINE_TTL "[^"]+ \\+ INTERVAL ${expectedDays} DAY"`),
			)
		}
	})

	it("does not retain completed forward queries on ALTER-compatible annual rollups", () => {
		const alterCompatibleRollups = [
			"logs_aggregates_hourly",
			"service_map_db_edges_hourly",
			"service_map_db_query_shapes_hourly",
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
})
