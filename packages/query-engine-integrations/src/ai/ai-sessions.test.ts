import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { compileUnsafe, compileUnionUnsafe, type CompiledQuery } from "@maple-dev/clickhouse-builder"
import {
	aiSessionFacetsQuery,
	aiSessionListQuery,
	aiSessionSpansQuery,
	aiSessionSpansRowSchema,
	aiSessionWindowQuery,
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
		const { sql } = compileUnsafe(aiSessionListQuery(), params)

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
		const { sql } = compileUnsafe(aiSessionListQuery(), params)

		expect(orgPredicateCount(sql)).toBe(2)
	})

	it("is org-scoped", () => {
		expect(compileUnsafe(aiSessionListQuery(), params).tenantScope).toBe("single-tenant")
	})

	it("tests session-id presence with mapContains AND a non-empty value", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(), params)

		// ClickHouse yields '' for a missing Map key, so mapContains alone would
		// admit spans carrying an empty session id.
		expect(sql).toContain(
			"(mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != '')",
		)
	})

	it("resolves the vendor from the earliest session-bearing span, not max()", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(), params)

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
		const { sql } = compileUnsafe(aiSessionListQuery(), { ...params, orgId: "org'evil" })

		expect(sql).toContain("OrgId = 'org\\'evil'")
	})

	it("omits the optional filters when none are given", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(), params)

		expect(sql).not.toContain("SpanAttributes['maple_ai.vendor.id'] IN")
		expect(sql).not.toContain("ServiceName IN")
	})

	it("puts both optional filters on the detection level only", () => {
		const { sql } = compileUnsafe(
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

	it("pads the fan-out window rather than dropping it", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(), params)
		const [fanOut, detection] = sql.split("TraceId IN (SELECT")

		// `trace_detail_spans` is PARTITION BY toDate(Timestamp), so this predicate
		// is the only thing standing between a seek over the window's partitions
		// and a seek over every partition the 30-day TTL retains.
		expect(fanOut).toContain(`Timestamp >= '${params.startTime}' - INTERVAL 86400 SECOND`)
		expect(fanOut).toContain(`Timestamp <= '${params.endTime}' + INTERVAL 86400 SECOND`)
		// Detection stays exact: the pad keeps a straddling trace whole, it does not
		// widen which sessions the range reports.
		expect(detection).toContain(`Timestamp >= '${params.startTime}'`)
		expect(detection).toContain(`Timestamp <= '${params.endTime}'`)
		expect(detection).not.toContain("INTERVAL")
	})

	it("leaves no unresolved param placeholder", () => {
		expect(compileUnsafe(aiSessionListQuery(), params).sql).not.toContain("__PARAM_")
	})

	it("decodes quoted 64-bit aggregates and the service-name array", () => {
		const compiled = compileUnsafe(aiSessionListQuery(), params)

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
		const { sql } = compileUnionUnsafe(aiSessionFacetsQuery(), params)

		expect(sql).toContain("FROM traces")
		expect(sql).not.toContain("trace_detail_spans")
		expect(sql).not.toContain("TraceId IN (SELECT")
		expect(sql).toContain("UNION ALL")
	})

	it("counts distinct sessions per vendor and per service", () => {
		const { sql } = compileUnionUnsafe(aiSessionFacetsQuery(), params)

		expect(sql).toContain("SpanAttributes['maple_ai.vendor.id'] AS name")
		expect(sql).toContain("ServiceName AS name")
		expect(sql).toContain("'vendor' AS facetType")
		expect(sql).toContain("'service' AS facetType")
		expect(sql.split("uniqExact(SpanAttributes['maple_ai.session.id']) AS count").length - 1).toBe(2)
		expect(sql.split("GROUP BY name").length - 1).toBe(2)
		expect(sql.split("ORDER BY count DESC").length - 1).toBe(2)
	})

	it("repeats the org and window predicates on every union branch", () => {
		const { sql } = compileUnionUnsafe(aiSessionFacetsQuery(), params)

		expect(orgPredicateCount(sql)).toBe(2)
		expect(sql.split(`Timestamp >= '${params.startTime}'`).length - 1).toBe(2)
		expect(sql.split(`Timestamp <= '${params.endTime}'`).length - 1).toBe(2)
	})

	it("is org-scoped", () => {
		expect(compileUnionUnsafe(aiSessionFacetsQuery(), params).tenantScope).toBe("single-tenant")
	})

	it("counts only session-bearing spans, and drops the blank option", () => {
		const { sql } = compileUnionUnsafe(aiSessionFacetsQuery(), params)

		expect(
			sql.split(
				"(mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != '')",
			).length - 1,
		).toBe(2)
		expect(sql).toContain("SpanAttributes['maple_ai.vendor.id'] != ''")
		expect(sql).toContain("ServiceName != ''")
	})

	it("leaves no unresolved param placeholder", () => {
		expect(compileUnionUnsafe(aiSessionFacetsQuery(), params).sql).not.toContain("__PARAM_")
	})

	it("decodes the quoted 64-bit uniqExact count", () => {
		const compiled = compileUnionUnsafe(aiSessionFacetsQuery(), params)

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
		const { sql } = compileUnsafe(aiSessionSpansQuery(), spanParams)

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
		const { sql } = compileUnsafe(aiSessionSpansQuery(), spanParams)

		expect(orgPredicateCount(sql)).toBe(2)
	})

	it("is org-scoped", () => {
		expect(compileUnsafe(aiSessionSpansQuery(), spanParams).tenantScope).toBe("single-tenant")
	})

	it("substitutes and escapes the sessionId param", () => {
		const { sql } = compileUnsafe(aiSessionSpansQuery(), spanParams)
		expect(sql).toContain("SpanAttributes['maple_ai.session.id'] = 'wrun_01M0CSAEW96BH2W9185XZPRPKH'")

		const escaped = compileUnsafe(aiSessionSpansQuery(), { ...spanParams, sessionId: "sess'evil" })
		expect(escaped.sql).toContain("SpanAttributes['maple_ai.session.id'] = 'sess\\'evil'")
	})

	it("bounds both levels by the window", () => {
		const { sql } = compileUnsafe(aiSessionSpansQuery(), spanParams)

		// Both, not one: the fan-out's copy is what prunes partitions, and the
		// caller is responsible for bounds that contain the whole session.
		expect(sql.split(`Timestamp >= '${params.startTime}'`).length - 1).toBe(2)
		expect(sql.split(`Timestamp <= '${params.endTime}'`).length - 1).toBe(2)
	})

	it("honours a caller-supplied limit", () => {
		expect(compileUnsafe(aiSessionSpansQuery({ limit: 100 }), spanParams).sql).toContain("LIMIT 100")
	})

	it("leaves no unresolved param placeholder", () => {
		expect(compileUnsafe(aiSessionSpansQuery(), spanParams).sql).not.toContain("__PARAM_")
	})

	it("decodes the raw Map columns as plain objects", () => {
		const compiled = compileUnsafe(aiSessionSpansQuery(), spanParams, {
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

describe("aiSessionWindowQuery", () => {
	const windowParams = { orgId: params.orgId, sessionId: spanParams.sessionId }

	it("resolves the bounds from the id alone, without a time predicate", () => {
		const { sql } = compileUnsafe(aiSessionWindowQuery(), windowParams)

		// The one read in this file that runs unbounded, and the only one that can:
		// `traces` has the mapValues bloom index for the id and a 30-day TTL. The
		// fan-out has neither, which is why the caller resolves bounds first.
		expect(sql).toContain("FROM traces")
		expect(sql).not.toContain("trace_detail_spans")
		expect(sql).not.toContain("Timestamp >=")
		expect(sql).not.toContain("Timestamp <=")
	})

	it("reports bounds already padded for the fan-out", () => {
		const { sql } = compileUnsafe(aiSessionWindowQuery(), windowParams)

		// The bounds are measured over session-BEARING spans; the read they bound
		// returns every span of those spans' traces.
		expect(sql).toContain("toString(min(Timestamp) - INTERVAL 86400 SECOND) AS startTime")
		expect(sql).toContain("toString(max(Timestamp) + INTERVAL 86400 SECOND) AS endTime")
	})

	it("guards session-id presence, and escapes the id", () => {
		const { sql } = compileUnsafe(aiSessionWindowQuery(), windowParams)
		expect(sql).toContain(
			"(mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != '')",
		)

		const escaped = compileUnsafe(aiSessionWindowQuery(), { ...windowParams, sessionId: "sess'evil" })
		expect(escaped.sql).toContain("SpanAttributes['maple_ai.session.id'] = 'sess\\'evil'")
	})

	it("is org-scoped", () => {
		expect(compileUnsafe(aiSessionWindowQuery(), windowParams).tenantScope).toBe("single-tenant")
	})

	it("leaves no unresolved param placeholder", () => {
		expect(compileUnsafe(aiSessionWindowQuery(), windowParams).sql).not.toContain("__PARAM_")
	})

	it("decodes the quoted 64-bit count", () => {
		const compiled = compileUnsafe(aiSessionWindowQuery(), windowParams)

		expect(
			decodeRows(compiled, [
				{
					startTime: "2026-08-18 10:33:25.825000000",
					endTime: "2026-08-20 10:33:36.242000000",
					spanCount: "17",
				},
			]),
		).toEqual([
			{
				startTime: "2026-08-18 10:33:25.825000000",
				endTime: "2026-08-20 10:33:36.242000000",
				spanCount: 17,
			},
		])
	})
})
