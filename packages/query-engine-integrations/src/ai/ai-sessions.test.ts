import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { compileCH, compileUnion, type CompiledQuery } from "@maple-dev/clickhouse-builder"
import {
	aiSessionFacetsQuery,
	aiSessionFacetsRowSchema,
	aiSessionListQuery,
	aiSessionListRowSchema,
	aiSessionSpansQuery,
	aiSessionSpansRowSchema,
} from "./ai-sessions"

const params = {
	orgId: "org_1",
	startTime: "2026-08-18 00:00:00",
	endTime: "2026-08-19 23:59:59",
}

const spanParams = { ...params, sessionId: "wrun_01M0CSAEW96BH2W9185XZPRPKH" }

const decodeRows = <T>(compiled: CompiledQuery<T>, rows: ReadonlyArray<Record<string, unknown>>) =>
	Effect.runSync(compiled.decodeRows(rows))

/** `OrgId = 'x'` on the detection level AND on the fan-out level. */
const orgPredicateCount = (sql: string) => sql.split("OrgId = 'org_1'").length - 1

describe("aiSessionListQuery", () => {
	it("detects sessions on traces, then fans out over trace_detail_spans", () => {
		const { sql } = compileCH(aiSessionListQuery(), params)

		// The detection level is the one the SpanAttributes bloom index serves;
		// the fan-out reads the MV whose sort key starts (OrgId, TraceId).
		expect(sql).toContain("FROM trace_detail_spans")
		expect(sql).toContain("TraceId IN (SELECT")
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("GROUP BY traceId")
		expect(sql).toContain("GROUP BY sessionId")
		expect(sql).toContain("ORDER BY startTime DESC")
		expect(sql).toContain("LIMIT 50")
	})

	it("repeats the org predicate on every level that reads a table", () => {
		const { sql } = compileCH(aiSessionListQuery(), params)

		expect(orgPredicateCount(sql)).toBe(2)
	})

	it("is org-scoped", () => {
		expect(compileCH(aiSessionListQuery(), params).tenantScope).toBe("org")
	})

	it("tests session-id presence with mapContains AND a non-empty value", () => {
		const { sql } = compileCH(aiSessionListQuery(), params)

		// ClickHouse yields '' for a missing Map key, so mapContains alone would
		// admit spans carrying an empty session id.
		expect(sql).toContain(
			"(mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != '')",
		)
	})

	it("resolves the vendor from the earliest session-bearing span, not max()", () => {
		const { sql } = compileCH(aiSessionListQuery(), params)

		// max(vendorId) picked `vercel_ai_sdk` alphabetically over the `eve` that
		// actually ran the turn — see the builder's doc comment.
		expect(sql).not.toContain("max(SpanAttributes['maple_ai.vendor.id'])")
		expect(sql).toContain("argMin(SpanAttributes['maple_ai.vendor.id'], if(")
		expect(sql).toContain("argMin(SpanAttributes['maple_ai.vendor.version'], if(")
		expect(sql).toContain("argMin(vendorId, sessionStart) AS vendorId")
		expect(sql).toContain("argMin(vendorVersion, sessionStart) AS vendorVersion")
		// The sentinel must stay inside DateTime's range or toDateTime won't parse.
		expect(sql).toContain("toDateTime('2106-01-01 00:00:00')")
	})

	it("escapes an org id carrying a quote", () => {
		const { sql } = compileCH(aiSessionListQuery(), { ...params, orgId: "org'evil" })

		expect(sql).toContain("OrgId = 'org\\'evil'")
	})

	it("omits the optional filters when none are given", () => {
		const { sql } = compileCH(aiSessionListQuery(), params)

		expect(sql).not.toContain("SpanAttributes['maple_ai.vendor.id'] IN")
		expect(sql).not.toContain("ServiceName IN")
	})

	it("puts both optional filters on the detection level only", () => {
		const { sql } = compileCH(
			aiSessionListQuery({ limit: 25, vendorIds: ["eve"], serviceNames: ["maple-slack-agent"] }),
			params,
		)

		// Filtering the fan-out instead would drop spans and under-count spanCount.
		const [fanOut, detection] = sql.split("TraceId IN (SELECT")
		expect(detection).toContain("SpanAttributes['maple_ai.vendor.id'] IN ('eve')")
		expect(detection).toContain("ServiceName IN ('maple-slack-agent')")
		expect(fanOut).not.toContain("IN ('eve')")
		expect(sql).toContain("LIMIT 25")
	})

	it("leaves no unresolved param placeholder", () => {
		expect(compileCH(aiSessionListQuery(), params).sql).not.toContain("__PARAM_")
	})

	it("decodes quoted 64-bit aggregates and the service-name array", () => {
		const compiled = compileCH(aiSessionListQuery(), params, { rowSchema: aiSessionListRowSchema })

		const [row] = decodeRows(compiled, [
			{
				sessionId: "wrun_01M0CSAEW96BH2W9185XZPRPKH",
				vendorId: "eve",
				vendorVersion: "0",
				traceCount: "1",
				spanCount: "250",
				errorSpanCount: "4",
				serviceNames: ["maple-slack-agent", "maple-api"],
				startTime: "2026-08-19 10:33:25.825000000",
				endTime: "2026-08-19 10:33:36.242000000",
				durationMs: "10417",
			},
		])

		expect(row).toEqual({
			sessionId: "wrun_01M0CSAEW96BH2W9185XZPRPKH",
			vendorId: "eve",
			vendorVersion: "0",
			traceCount: 1,
			spanCount: 250,
			errorSpanCount: 4,
			serviceNames: ["maple-slack-agent", "maple-api"],
			startTime: "2026-08-19 10:33:25.825000000",
			endTime: "2026-08-19 10:33:36.242000000",
			durationMs: 10_417,
		})
	})
})

describe("aiSessionFacetsQuery", () => {
	it("groups the detection scan only — no fan-out over trace_detail_spans", () => {
		const { sql } = compileUnion(aiSessionFacetsQuery(), params)

		expect(sql).toContain("FROM traces")
		expect(sql).not.toContain("trace_detail_spans")
		expect(sql).not.toContain("TraceId IN (SELECT")
		expect(sql).toContain("UNION ALL")
	})

	it("counts distinct sessions per vendor and per service", () => {
		const { sql } = compileUnion(aiSessionFacetsQuery(), params)

		expect(sql).toContain("SpanAttributes['maple_ai.vendor.id'] AS name")
		expect(sql).toContain("ServiceName AS name")
		expect(sql).toContain("'vendor' AS facetType")
		expect(sql).toContain("'service' AS facetType")
		expect(sql.split("uniqExact(SpanAttributes['maple_ai.session.id']) AS count").length - 1).toBe(2)
		expect(sql.split("GROUP BY name").length - 1).toBe(2)
		expect(sql.split("ORDER BY count DESC").length - 1).toBe(2)
	})

	it("repeats the org and window predicates on every union branch", () => {
		const { sql } = compileUnion(aiSessionFacetsQuery(), params)

		expect(orgPredicateCount(sql)).toBe(2)
		expect(sql.split(`Timestamp >= '${params.startTime}'`).length - 1).toBe(2)
		expect(sql.split(`Timestamp <= '${params.endTime}'`).length - 1).toBe(2)
	})

	it("is org-scoped", () => {
		expect(compileUnion(aiSessionFacetsQuery(), params).tenantScope).toBe("org")
	})

	it("counts only session-bearing spans, and drops the blank option", () => {
		const { sql } = compileUnion(aiSessionFacetsQuery(), params)

		expect(
			sql.split(
				"(mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != '')",
			).length - 1,
		).toBe(2)
		expect(sql).toContain("SpanAttributes['maple_ai.vendor.id'] != ''")
		expect(sql).toContain("ServiceName != ''")
	})

	it("leaves no unresolved param placeholder", () => {
		expect(compileUnion(aiSessionFacetsQuery(), params).sql).not.toContain("__PARAM_")
	})

	it("decodes the quoted 64-bit uniqExact count", () => {
		const compiled = compileUnion(aiSessionFacetsQuery(), params, {
			rowSchema: aiSessionFacetsRowSchema,
		})

		expect(
			decodeRows(compiled, [
				{ name: "eve", count: "12", facetType: "vendor" },
				{ name: "maple-slack-agent", count: 9, facetType: "service" },
			]),
		).toEqual([
			{ name: "eve", count: 12, facetType: "vendor" },
			{ name: "maple-slack-agent", count: 9, facetType: "service" },
		])
	})
})

describe("aiSessionSpansQuery", () => {
	it("returns every span of every trace in the session, oldest first", () => {
		const { sql } = compileCH(aiSessionSpansQuery(), spanParams)

		expect(sql).toContain("FROM trace_detail_spans")
		expect(sql).toContain("TraceId IN (SELECT")
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("Duration / 1000000 AS durationMs")
		expect(sql).toContain("SpanAttributes AS spanAttributes")
		expect(sql).toContain("ResourceAttributes AS resourceAttributes")
		expect(sql).toContain("ORDER BY timestamp ASC")
		expect(sql).toContain("LIMIT 2000")
	})

	it("repeats the org predicate on every level that reads a table", () => {
		const { sql } = compileCH(aiSessionSpansQuery(), spanParams)

		expect(orgPredicateCount(sql)).toBe(2)
	})

	it("is org-scoped", () => {
		expect(compileCH(aiSessionSpansQuery(), spanParams).tenantScope).toBe("org")
	})

	it("substitutes and escapes the sessionId param", () => {
		const { sql } = compileCH(aiSessionSpansQuery(), spanParams)
		expect(sql).toContain("SpanAttributes['maple_ai.session.id'] = 'wrun_01M0CSAEW96BH2W9185XZPRPKH'")

		const escaped = compileCH(aiSessionSpansQuery(), { ...spanParams, sessionId: "sess'evil" })
		expect(escaped.sql).toContain("SpanAttributes['maple_ai.session.id'] = 'sess\\'evil'")
	})

	it("honours a caller-supplied limit", () => {
		expect(compileCH(aiSessionSpansQuery({ limit: 100 }), spanParams).sql).toContain("LIMIT 100")
	})

	it("leaves no unresolved param placeholder", () => {
		expect(compileCH(aiSessionSpansQuery(), spanParams).sql).not.toContain("__PARAM_")
	})

	it("decodes the raw Map columns as plain objects", () => {
		const compiled = compileCH(aiSessionSpansQuery(), spanParams, {
			rowSchema: aiSessionSpansRowSchema,
		})

		const [row] = decodeRows(compiled, [
			{
				traceId: "6b0c0e0a",
				spanId: "aa11",
				parentSpanId: "",
				spanName: "ai.eve.turn",
				spanKind: "Internal",
				serviceName: "maple-slack-agent",
				durationMs: "250",
				statusCode: "Ok",
				statusMessage: "",
				timestamp: "2026-08-19 10:33:25.825000000",
				spanAttributes: {
					"maple_ai.vendor.id": "eve",
					"maple_ai.session.id": "wrun_01M0CSAEW96BH2W9185XZPRPKH",
				},
				resourceAttributes: { "service.name": "maple-slack-agent" },
			},
		])

		expect(row?.durationMs).toBe(250)
		expect(row?.spanAttributes).toEqual({
			"maple_ai.vendor.id": "eve",
			"maple_ai.session.id": "wrun_01M0CSAEW96BH2W9185XZPRPKH",
		})
		expect(row?.resourceAttributes).toEqual({ "service.name": "maple-slack-agent" })
	})
})
