import { describe, expect, it } from "vitest"
import { buildTinybirdProjectManifest } from "../tinybird/project-manifest"
import {
	emitCreateMaterializedView,
	emitCreateTable,
	emitJsonPathSpec,
	emitProjectDdl,
} from "./ddl-emitter"

describe("ClickHouse DDL emitter", () => {
	it("emits a CREATE TABLE for every datasource and a CREATE MATERIALIZED VIEW for every pipe", async () => {
		const manifest = await buildTinybirdProjectManifest()
		const stmts = emitProjectDdl(manifest)

		expect(stmts.length).toBe(manifest.datasources.length + manifest.pipes.length)
		expect(stmts.filter((s) => s.startsWith("CREATE TABLE")).length).toBe(
			manifest.datasources.length,
		)
		expect(stmts.filter((s) => s.startsWith("CREATE MATERIALIZED VIEW")).length).toBe(
			manifest.pipes.length,
		)
	})

	it("strips Tinybird `json:$.path` annotations from column definitions", async () => {
		const manifest = await buildTinybirdProjectManifest()
		const traces = manifest.datasources.find((ds) => ds.name === "traces")
		expect(traces).toBeDefined()

		const ddl = emitCreateTable(traces!)
		expect(ddl).not.toContain("`json:")
		expect(ddl).toContain("OrgId LowCardinality(String)")
		expect(ddl).toContain("ORDER BY (OrgId, ServiceName, SpanName, toDateTime(Timestamp))")
		expect(ddl).toContain("PARTITION BY toDate(Timestamp)")
		expect(ddl).toContain("TTL toDate(Timestamp) + INTERVAL 90 DAY")
	})

	it("preserves DEFAULT expressions on computed columns", async () => {
		const manifest = await buildTinybirdProjectManifest()
		const traces = manifest.datasources.find((ds) => ds.name === "traces")
		const ddl = emitCreateTable(traces!)

		expect(ddl).toContain("SampleRate Float64 DEFAULT multiIf(")
		expect(ddl).toContain("IsEntryPoint UInt8 DEFAULT if(SpanKind IN ('Server', 'Consumer')")
	})

	it("folds INDEXES blocks into the column list", async () => {
		const manifest = await buildTinybirdProjectManifest()
		const traces = manifest.datasources.find((ds) => ds.name === "traces")
		const ddl = emitCreateTable(traces!)

		expect(ddl).toContain("INDEX idx_trace_id TraceId TYPE bloom_filter(0.01) GRANULARITY 1")
		expect(ddl).toContain("INDEX idx_span_attr_keys mapKeys(SpanAttributes)")
		expect(ddl).toContain("INDEX idx_resource_attr_vals mapValues(ResourceAttributes)")
	})

	it("does not include FORWARD_QUERY blocks (Tinybird-only)", async () => {
		const manifest = await buildTinybirdProjectManifest()
		const traces = manifest.datasources.find((ds) => ds.name === "traces")
		const ddl = emitCreateTable(traces!)

		expect(ddl).not.toContain("FORWARD_QUERY")
	})

	it("emits CREATE MATERIALIZED VIEW … TO <target> AS … with the original SELECT", async () => {
		const manifest = await buildTinybirdProjectManifest()
		const errorEvents = manifest.pipes.find((p) => p.name === "error_events_mv")
		expect(errorEvents).toBeDefined()

		const ddl = emitCreateMaterializedView(errorEvents!)
		expect(ddl).toMatch(/^CREATE MATERIALIZED VIEW IF NOT EXISTS error_events_mv TO error_events AS/)
		expect(ddl).toContain("FROM traces")
		expect(ddl).toContain("WHERE StatusCode = 'Error'")
		expect(ddl).toContain("cityHash64(OrgId, ServiceName, _exType, _fpFrames, _msgFallback)")
	})

	it("emits a JSONPath spec mapping each ingested column to its $.path", async () => {
		const manifest = await buildTinybirdProjectManifest()
		const logs = manifest.datasources.find((ds) => ds.name === "logs")
		expect(logs).toBeDefined()

		const spec = emitJsonPathSpec(logs!)
		const orgId = spec.find((c) => c.column === "OrgId")
		expect(orgId?.jsonPath).toBe("$.resource_attributes.maple_org_id")
		const body = spec.find((c) => c.column === "Body")
		expect(body?.jsonPath).toBe("$.body")

		// Datasources populated only by MVs (e.g. service_usage) have no JSONPaths.
		const serviceUsage = manifest.datasources.find((ds) => ds.name === "service_usage")
		const serviceUsageSpec = emitJsonPathSpec(serviceUsage!)
		expect(serviceUsageSpec.every((c) => c.jsonPath === null)).toBe(true)
	})

	it("respects the engineFlavor option for swapping MergeTree → ReplicatedMergeTree", async () => {
		const manifest = await buildTinybirdProjectManifest()
		const logs = manifest.datasources.find((ds) => ds.name === "logs")
		const ddl = emitCreateTable(logs!, { engineFlavor: "ReplicatedMergeTree" })
		expect(ddl).toContain("ENGINE = ReplicatedMergeTree")

		// AggregatingMergeTree etc. stay as-is even when MergeTree is being remapped.
		const aggDs = manifest.datasources.find((ds) => ds.name === "logs_aggregates_hourly")
		const aggDdl = emitCreateTable(aggDs!, { engineFlavor: "ReplicatedMergeTree" })
		expect(aggDdl).toContain("ENGINE = AggregatingMergeTree")
	})
})
