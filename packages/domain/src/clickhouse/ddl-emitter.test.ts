import { describe, expect, it } from "vitest"
import { buildTinybirdProjectManifest } from "../tinybird/project-manifest"
import {
	emitCreateMaterializedView,
	emitCreateTable,
	emitJsonPathSpec,
	emitProjectDdl,
	extractColumnDefinition,
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

describe("extractColumnDefinition", () => {
	const SIMPLE = `CREATE TABLE IF NOT EXISTS service_overview_spans (
    OrgId LowCardinality(String),
    Timestamp DateTime,
    ServiceName LowCardinality(String),
    SampleRate Float64 DEFAULT 1
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (OrgId, ServiceName, Timestamp)`

	const COMPLEX_DEFAULT = `CREATE TABLE IF NOT EXISTS traces (
    OrgId LowCardinality(String),
    SampleRate Float64 DEFAULT multiIf(SpanAttributes['SampleRate'] != '' AND toFloat64OrZero(SpanAttributes['SampleRate']) >= 1.0, toFloat64OrZero(SpanAttributes['SampleRate']), match(TraceState, 'th:[0-9a-f]+'), 1.0 / greatest(1.0 - reinterpretAsUInt64(reverse(unhex(rightPad(extract(TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2.0, 64), 0.0001), 1.0),
    IsEntryPoint UInt8 DEFAULT if(SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '', 1, 0),
    INDEX idx_trace_id TraceId TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = MergeTree`

	it("returns the column line including a simple DEFAULT clause", () => {
		expect(extractColumnDefinition(SIMPLE, "SampleRate")).toBe("SampleRate Float64 DEFAULT 1")
	})

	it("returns the line with a multi-arg DEFAULT expression that contains commas and parens", () => {
		const line = extractColumnDefinition(COMPLEX_DEFAULT, "SampleRate")
		expect(line).not.toBeNull()
		// Must start with the column name and preserve the full multiIf body.
		expect(line!.startsWith("SampleRate Float64 DEFAULT multiIf(")).toBe(true)
		expect(line!.endsWith(", 1.0)")).toBe(true)
		// Sanity: the IsEntryPoint line must NOT bleed in.
		expect(line!).not.toContain("IsEntryPoint")
	})

	it("returns the IsEntryPoint line independently", () => {
		const line = extractColumnDefinition(COMPLEX_DEFAULT, "IsEntryPoint")
		expect(line).toBe(
			"IsEntryPoint UInt8 DEFAULT if(SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '', 1, 0)",
		)
	})

	it("returns a plain-type column line when there's no DEFAULT", () => {
		expect(extractColumnDefinition(SIMPLE, "OrgId")).toBe("OrgId LowCardinality(String)")
	})

	it("returns null for a column that doesn't exist", () => {
		expect(extractColumnDefinition(SIMPLE, "Nope")).toBeNull()
	})

	it("returns null for an INDEX line (never confused with a column)", () => {
		expect(extractColumnDefinition(COMPLEX_DEFAULT, "idx_trace_id")).toBeNull()
	})

	it("returns null for non-CREATE-TABLE input", () => {
		expect(
			extractColumnDefinition("CREATE MATERIALIZED VIEW foo TO bar AS SELECT 1", "OrgId"),
		).toBeNull()
		expect(extractColumnDefinition("not sql at all", "OrgId")).toBeNull()
	})

	it("works against actual emitted CREATE TABLE statements", async () => {
		const manifest = await buildTinybirdProjectManifest()
		const traces = manifest.datasources.find((ds) => ds.name === "traces")
		const ddl = emitCreateTable(traces!)

		const sampleRate = extractColumnDefinition(ddl, "SampleRate")
		expect(sampleRate).not.toBeNull()
		expect(sampleRate!).toContain("Float64")
		expect(sampleRate!).toContain("DEFAULT multiIf(")

		const isEntryPoint = extractColumnDefinition(ddl, "IsEntryPoint")
		expect(isEntryPoint).not.toBeNull()
		expect(isEntryPoint!).toContain("UInt8")
		expect(isEntryPoint!).toContain("DEFAULT if(")
	})
})
