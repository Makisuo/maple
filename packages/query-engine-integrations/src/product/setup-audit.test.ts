// BOUNDARY: Test doubles mirror intentionally untyped external callbacks.
import { describe, expect, it } from "vitest"
import { Schema, Effect } from "effect"
import { compileUnsafe } from "@maple-dev/clickhouse-builder"
import {
	auditAttributeKeyInventoryQuery,
	auditAttributeKeyInventoryRowSchema,
	auditDbEdgeIdentityQuery,
	auditDbEdgeRowSchema,
	auditLogCorrelationQuery,
	auditLogCorrelationRowSchema,
	auditLogSeverityByServiceQuery,
	auditLogSeverityRowSchema,
	auditMetricLabelCardinalityQuery,
	auditMetricLabelRowSchema,
	auditOrphanSpansSQL,
	auditRootlessTracesSQL,
	auditTraceSampleModulus,
	auditPeerValueInventoryQuery,
	auditPeerValueRowSchema,
	auditSamplingByServiceQuery,
	auditSamplingRowSchema,
	auditSpanProfileByServiceQuery,
	auditSpanProfileRowSchema,
} from "./setup-audit"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
}

/** Compiled up front: the builders return differently-shaped queries, and only the SQL is compared. */
const compiledQueries: ReadonlyArray<readonly [string, string]> = [
	["auditAttributeKeyInventoryQuery", compileUnsafe(auditAttributeKeyInventoryQuery(), baseParams).sql],
	["auditSpanShapeByServiceQuery", compileUnsafe(auditSpanProfileByServiceQuery(), baseParams).sql],
	["auditSamplingByServiceQuery", compileUnsafe(auditSamplingByServiceQuery(), baseParams).sql],
	["auditLogSeverityByServiceQuery", compileUnsafe(auditLogSeverityByServiceQuery(), baseParams).sql],
	["auditMetricLabelCardinalityQuery", compileUnsafe(auditMetricLabelCardinalityQuery(), baseParams).sql],
	["auditPeerValueInventoryQuery", compileUnsafe(auditPeerValueInventoryQuery(), baseParams).sql],
	["auditDbEdgeIdentityQuery", compileUnsafe(auditDbEdgeIdentityQuery(), baseParams).sql],
	["auditLogCorrelationQuery", compileUnsafe(auditLogCorrelationQuery(), baseParams).sql],
]

describe("setup-audit query invariants", () => {
	it.each(compiledQueries)("%s scopes to the org and bounds its result set", (_name, sql) => {
		// Tenant isolation is enforced at execution; a builder that forgets it fails there, not here.
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toMatch(/LIMIT \d+/)
	})
})

describe("auditAttributeKeyInventoryQuery", () => {
	it("reads all four scopes in one grouped pass over the hourly rollup", () => {
		const { sql } = compileUnsafe(auditAttributeKeyInventoryQuery(), baseParams)
		expect(sql).toContain("FROM attribute_keys_hourly")
		expect(sql).toContain("AttributeScope IN ('span', 'resource', 'log', 'metric')")
		expect(sql).toContain("GROUP BY scope, attributeKey")
		expect(sql).toContain("LIMIT 2000")
	})
})

describe("auditSpanShapeByServiceQuery", () => {
	it("splits weighted counts by span kind and flags non-Title-Case literals", () => {
		const { sql } = compileUnsafe(auditSpanProfileByServiceQuery(), baseParams)
		expect(sql).toContain("FROM traces_aggregates_hourly")
		expect(sql).toContain("sumIf(WeightedCount, SpanKind = 'Server')")
		expect(sql).toContain("sumIf(WeightedCount, DeploymentEnv = '')")
		expect(sql).toContain("uniq(SpanName)")
		expect(sql).toContain("StatusCode NOT IN ('Ok', 'Error', 'Unset', '')")
		expect(sql).toContain("SpanKind NOT IN ('Server', 'Client', 'Producer', 'Consumer', 'Internal', '')")
	})

	it("snaps both window bounds to the hour so partial windows still match the rollup", () => {
		const { sql } = compileUnsafe(auditSpanProfileByServiceQuery(), baseParams)
		expect(sql).toContain("Hour >= toStartOfHour(toDateTime('2024-01-01 00:00:00'))")
		expect(sql).toContain("Hour <= toStartOfHour(toDateTime('2024-01-02 00:00:00'))")
	})
})

describe("auditSamplingByServiceQuery", () => {
	it("returns raw and extrapolated counts separately rather than a ratio", () => {
		const { sql } = compileUnsafe(auditSamplingByServiceQuery(), baseParams)
		expect(sql).toContain("FROM service_overview_hourly")
		expect(sql).toContain("sum(SpanCount)")
		expect(sql).toContain("sum(EstimatedSpanCount)")
		expect(sql).toContain("sumIf(SpanCount, CommitSha != '')")
		// The ratio is computed app-side; builder arithmetic follows SQL precedence, not call order.
		expect(sql).not.toContain("/")
	})
})

describe("auditMetricLabelCardinalityQuery", () => {
	it("uses approximate uniq so an exploded-label org cannot exhaust query memory", () => {
		const { sql } = compileUnsafe(auditMetricLabelCardinalityQuery(), baseParams)
		expect(sql).toContain("AttributeScope = 'metric'")
		expect(sql).toContain("uniq(AttributeValue)")
		expect(sql).not.toContain("uniqExact")
	})
})

describe("auditPeerValueInventoryQuery", () => {
	it("restricts to the dependency-naming keys and drops empty values", () => {
		const { sql } = compileUnsafe(auditPeerValueInventoryQuery(), baseParams)
		expect(sql).toContain("AttributeScope = 'span'")
		expect(sql).toContain(
			"AttributeKey IN ('peer.service', 'db.system', 'db.system.name', 'messaging.system', 'rpc.system')",
		)
		expect(sql).toContain("AttributeValue != ''")
		expect(sql).toContain("GROUP BY attributeKey, attributeValue")
	})
})

describe("auditDbEdgeIdentityQuery", () => {
	it("counts calls whose database namespace is empty", () => {
		const { sql } = compileUnsafe(auditDbEdgeIdentityQuery(), baseParams)
		expect(sql).toContain("FROM service_map_db_edges_hourly")
		expect(sql).toContain("sumIf(CallCount, DbNamespace = '')")
		expect(sql).toContain("DbSystem != ''")
	})
})

describe("auditLogCorrelationQuery", () => {
	it("reads narrow columns and prunes on both timestamp columns", () => {
		const { sql } = compileUnsafe(auditLogCorrelationQuery(), baseParams)
		expect(sql).toContain("FROM logs")
		expect(sql).toContain("countIf(TraceId = '')")
		expect(sql).toContain("countIf(upper(SeverityText) IN ('ERROR', 'FATAL'))")
		expect(sql).toContain("countIf((TraceId = '' AND upper(SeverityText) IN ('ERROR', 'FATAL')))")
		// TimestampTime prunes day partitions; Timestamp narrows within them.
		expect(sql).toContain("TimestampTime >= '2024-01-01 00:00:00'")
		expect(sql).toContain("Timestamp >= '2024-01-01 00:00:00'")
		// Never the wide columns — this is the audit's only raw-table read.
		expect(sql).not.toContain("Body")
		expect(sql).not.toContain("LogAttributes")
	})
})

describe("auditTraceSampleModulus", () => {
	it("leaves small orgs unsampled and scales the divisor with volume", () => {
		expect(auditTraceSampleModulus(0)).toBe(1)
		expect(auditTraceSampleModulus(999_999)).toBe(1)
		expect(auditTraceSampleModulus(1_000_000)).toBe(4)
		expect(auditTraceSampleModulus(19_999_999)).toBe(4)
		expect(auditTraceSampleModulus(100_000_000)).toBe(16)
	})
})

describe("trace-completeness joins", () => {
	const window = {
		orgId: "org_1",
		childStart: "2024-01-01 10:00:00",
		childEnd: "2024-01-01 11:00:00",
		parentStart: "2024-01-01 09:00:00",
	}

	it("auditOrphanSpansSQL left-joins children to parents over a lagged window", () => {
		const { sql } = Effect.runSync(auditOrphanSpansSQL(window))
		expect(sql).toContain("FROM service_map_children")
		expect(sql).toContain("LEFT JOIN")
		expect(sql).toContain("FROM service_map_spans")
		expect(sql).toContain("ON (c.TraceId = p.TraceId AND c.ParentSpanId = p.SpanId)")
		// join_use_nulls = 0 makes a miss an empty string, not NULL.
		expect(sql).toContain("countIf(p.SpanId = '')")
		// Both sides scoped to the org; the parent side reaches further back for long spans.
		expect(sql.match(/OrgId = 'org_1'/g)).toHaveLength(2)
		expect(sql).toContain("Timestamp >= '2024-01-01 09:00:00'")
		expect(sql).toContain("Timestamp >= '2024-01-01 10:00:00'")
		// Sampling-marked orphans are split out rather than counted as defects.
		expect(sql).toContain("sampledOrphanCount")
	})

	it("auditRootlessTracesSQL joins observed traces against the root-span index", () => {
		const { sql } = Effect.runSync(auditRootlessTracesSQL(window))
		expect(sql).toContain("FROM trace_list_mv")
		expect(sql).toContain("argMin(ServiceName, Timestamp) AS entryService")
		expect(sql).toContain("countIf(r.TraceId = '')")
		expect(sql).toContain("GROUP BY TraceId")
	})

	it("applies the trace-sampling modulus to both sides of each join, or neither", () => {
		const unsampled = Effect.runSync(auditOrphanSpansSQL(window)).sql
		expect(unsampled).not.toContain("cityHash64")

		for (const sql of [
			Effect.runSync(auditOrphanSpansSQL({ ...window, traceSampleModulus: 16 })).sql,
			Effect.runSync(auditRootlessTracesSQL({ ...window, traceSampleModulus: 16 })).sql,
		]) {
			// Both sides, so every span of a kept trace survives and per-trace correctness is exact.
			expect(sql.match(/cityHash64\(TraceId\) % 16 = 0/g)).toHaveLength(2)
		}
	})

	it("clamps a nonsensical modulus rather than emitting it", () => {
		expect(Effect.runSync(auditOrphanSpansSQL({ ...window, traceSampleModulus: 0 })).sql).not.toContain(
			"cityHash64",
		)
		expect(Effect.runSync(auditOrphanSpansSQL({ ...window, traceSampleModulus: 99_999 })).sql).toContain(
			"cityHash64(TraceId) % 1024 = 0",
		)
	})

	it("derives tenant scope from the join sources rather than asserting it", () => {
		// Neither outer query carries an OrgId predicate — the scope comes from
		// both join sides being scoped. Asserting it by hand is what these used to
		// do, and an omitted filter would have sailed through the executor's gate.
		expect(Effect.runSync(auditOrphanSpansSQL(window)).tenantScope).toBe("single-tenant")
		expect(Effect.runSync(auditRootlessTracesSQL(window)).tenantScope).toBe("single-tenant")
	})

	it("escapes the org id so an embedded quote cannot terminate the literal", () => {
		const { sql } = Effect.runSync(
			auditOrphanSpansSQL({ ...window, orgId: "org_'; DROP TABLE traces; --" }),
		)
		// The injected quote is escaped, so the whole payload stays inside one string literal.
		expect(sql).toContain("OrgId = 'org_\\'; DROP TABLE traces; --'")
		expect(sql).not.toContain("OrgId = 'org_'")
	})
})

/**
 * ClickHouse `FORMAT JSON` quotes 64-bit integers; managed Tinybird returns numbers. Every row schema
 * has to decode both or BYO-ClickHouse orgs get a bare 500 on an otherwise healthy query.
 */
describe("row schemas decode both ClickHouse and Tinybird numeric encodings", () => {
	/** Decoding the quoted form must equal decoding the native form, field for field. */
	const expectBothEncodings = (
		decode: (input: unknown) => unknown,
		strings: Record<string, unknown>,
		numbers: Record<string, number>,
	) => {
		const quoted = Object.fromEntries(Object.entries(numbers).map(([key, value]) => [key, String(value)]))
		expect(decode({ ...strings, ...quoted })).toEqual(decode({ ...strings, ...numbers }))
	}

	const cases: ReadonlyArray<readonly [string, () => void]> = [
		[
			"attributeKeyInventory",
			() =>
				expectBothEncodings(
					Schema.decodeUnknownSync(auditAttributeKeyInventoryRowSchema),
					{ scope: "span", attributeKey: "http.method" },
					{ usageCount: 12 },
				),
		],
		[
			"spanShape",
			() =>
				expectBothEncodings(
					Schema.decodeUnknownSync(auditSpanProfileRowSchema),
					{ serviceName: "api", badStatusCodes: ["ERROR"], badSpanKinds: [] },
					{
						weightedSpanCount: 10,
						weightedErrorCount: 1,
						serverCount: 4,
						consumerCount: 0,
						clientCount: 6,
						producerCount: 0,
						noEnvCount: 2,
						spanNameCount: 3,
					},
				),
		],
		[
			"sampling",
			() =>
				expectBothEncodings(
					Schema.decodeUnknownSync(auditSamplingRowSchema),
					{ serviceName: "api" },
					{ spanCount: 10, estimatedSpanCount: 100, commitTaggedSpanCount: 10 },
				),
		],
		[
			"logSeverity",
			() =>
				expectBothEncodings(
					Schema.decodeUnknownSync(auditLogSeverityRowSchema),
					{ serviceName: "api", severityText: "INFO" },
					{ logCount: 42 },
				),
		],
		[
			"metricLabel",
			() =>
				expectBothEncodings(
					Schema.decodeUnknownSync(auditMetricLabelRowSchema),
					{ attributeKey: "user_id" },
					{ valueCardinality: 90_000, usageCount: 90_000 },
				),
		],
		[
			"peerValue",
			() =>
				expectBothEncodings(
					Schema.decodeUnknownSync(auditPeerValueRowSchema),
					{ attributeKey: "peer.service", attributeValue: "tinybird" },
					{ usageCount: 7 },
				),
		],
		[
			"dbEdge",
			() =>
				expectBothEncodings(
					Schema.decodeUnknownSync(auditDbEdgeRowSchema),
					{ serviceName: "api", dbSystem: "postgresql" },
					{ callCount: 500, unknownNamespaceCallCount: 500 },
				),
		],
		[
			"logCorrelation",
			() =>
				expectBothEncodings(
					Schema.decodeUnknownSync(auditLogCorrelationRowSchema),
					{ serviceName: "api" },
					{ logCount: 100, uncorrelatedCount: 99, errorLogCount: 5, uncorrelatedErrorCount: 5 },
				),
		],
	]

	it.each(cases)("%s", (_name, run) => run())
})
