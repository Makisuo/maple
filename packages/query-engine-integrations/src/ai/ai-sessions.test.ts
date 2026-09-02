import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { compileUnsafe, compileUnionUnsafe, type CompiledQuery } from "@maple-dev/clickhouse-builder"
import {
	aiSessionFacetsQuery,
	aiSessionListQuery,
	aiSessionSpansQuery,
	aiSessionSpansRowSchema,
	aiSessionSummaryQuery,
	aiSessionSummaryRowSchema,
	aiSessionTotalsQuery,
	aiSessionWindowQuery,
	aiTraceSpansQuery,
	aiTraceSummaryQuery,
	aiTraceTotalsQuery,
	aiTraceWindowQuery,
} from "./ai-sessions"

const params = {
	orgId: "org_1",
	startTime: "2026-08-18 00:00:00",
	endTime: "2026-08-19 23:59:59",
}

const spanParams = { ...params, sessionId: "wrun_01M0CSAEW96BH2W9185XZPRPKH" }

const TRACE_ID = "7f3a4b5c6d7e8f901234567890abcdef"
const traceParams = { ...params, traceId: TRACE_ID }

/** The trace's session id, or the synthesized one — the grouping key. */
const SESSION_KEY = "if(rawSessionId = '', concat('trace:', traceId), rawSessionId)"

const decodeRows = <T>(compiled: CompiledQuery<T>, rows: ReadonlyArray<Record<string, unknown>>) =>
	Effect.runSync(compiled.decodeRows(rows))

/** `OrgId = 'x'` on the detection level AND on the fan-out level. */
const orgPredicateCount = (sql: string) => sql.split("OrgId = 'org_1'").length - 1

describe("aiSessionListQuery", () => {
	it("detects sessions on ai_trace_index, then fans out over trace_detail_spans", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(), params)

		// The tier is the point: detection must read the filtered projection, not
		// raw `traces` — the raw scan reads the fat Map column for every span in
		// the window and cannot be saved by the bloom index (see the file header).
		// The fan-out reads the MV whose sort key starts (OrgId, TraceId).
		expect(sql).toContain("FROM trace_detail_spans")
		expect(sql).toContain("TraceId IN (SELECT")
		expect(sql).toContain("FROM ai_trace_index")
		expect(sql).not.toContain("FROM traces")
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

	it("detects on index membership, with no attribute predicate at all", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(), params)
		const [, detection] = sql.split("TraceId IN (SELECT")

		// The session id is sparse by vendor — several frameworks never emit one —
		// so detection keys on the vendor stamp. That predicate now lives in
		// `ai_trace_index_mv`'s write filter: every row of the index carries a
		// non-empty vendor id, so being in the table IS the guard and the read
		// touches no Map column.
		expect(detection).toContain("FROM ai_trace_index")
		expect(detection).not.toContain("mapContains")
		expect(detection).not.toContain("SpanAttributes")
	})

	it("keys a trace with no session id on the trace itself", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(), params)

		// One session per sessionless trace, and the per-trace derived table is the
		// only level that can say so: a span of a session-bearing trace carries no
		// session id of its own either.
		expect(sql).toContain(`${SESSION_KEY} AS sessionId`)
		expect(sql).toContain("max(SpanAttributes['maple_ai.session.id']) AS rawSessionId")
		expect(sql).toContain("GROUP BY sessionId")
		// The guard that used to drop them. The key is never empty now, and a
		// blank one would have swallowed every such trace into one session.
		expect(sql).not.toContain("WHERE sessionId != ''")
	})

	it("tests session-id presence with mapContains AND a non-empty value", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(), params)

		// ClickHouse yields '' for a missing Map key, so mapContains alone would
		// rank spans carrying an empty session id as session-bearing.
		expect(sql).toContain(
			"(mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != '')",
		)
	})

	it("resolves the vendor from the earliest session-bearing span, not max()", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(), params)

		// max(vendorId) picked `vercel_ai_sdk` alphabetically over the `eve` that
		// actually ran the turn — see the builder's doc comment.
		expect(sql).not.toContain("max(SpanAttributes['maple_ai.vendor.id'])")
		expect(sql).toContain("argMin(SpanAttributes['maple_ai.vendor.id'], tuple(multiIf(")
		expect(sql).toContain("argMin(SpanAttributes['maple_ai.vendor.version'], tuple(multiIf(")
		expect(sql).toContain("argMin(vendorId, sessionStart) AS vendorId")
		expect(sql).toContain("argMin(vendorVersion, sessionStart) AS vendorVersion")
		// The sentinel must stay inside DateTime's range or toDateTime won't parse.
		expect(sql).toContain("toDateTime('2106-01-01 00:00:00')")
	})

	it("ranks a sessionless trace's spans so a vendor-stamped one wins", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(), params)

		// Every span of a sessionless trace ties at the sentinel under the session
		// ordering alone, and argMin over ties is non-deterministic — it handed
		// back whichever span was read first, blank vendor included. Rank first,
		// then time, compared as a tuple.
		expect(sql).toContain(
			`tuple(multiIf((mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != ''), 0, SpanAttributes['maple_ai.vendor.id'] != '', 1, 2), Timestamp)`,
		)
	})

	it("escapes an org id carrying a quote", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(), { ...params, orgId: "org'evil" })

		expect(sql).toContain("OrgId = 'org\\'evil'")
	})

	it("omits the optional filters when none are given", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(), params)

		expect(sql).not.toContain("VendorId IN")
		expect(sql).not.toContain("ServiceName IN")
	})

	it("puts both optional filters on the detection level only", () => {
		const { sql } = compileUnsafe(
			aiSessionListQuery({ limit: 25, vendorIds: ["eve"], serviceNames: ["maple-slack-agent"] }),
			params,
		)

		// Filtering the fan-out instead would drop spans and under-count spanCount.
		const [fanOut, detection] = sql.split("TraceId IN (SELECT")
		expect(detection).toContain("VendorId IN ('eve')")
		expect(detection).toContain("ServiceName IN ('maple-slack-agent')")
		expect(fanOut).not.toContain("IN ('eve')")
		expect(sql).toContain("LIMIT 25")
	})

	it("skips past the previous pages on the outermost level only", () => {
		const { sql } = compileUnsafe(aiSessionListQuery({ limit: 50, offset: 100 }), params)

		// The offset must apply to the ordered SESSION rows — the derived per-trace
		// level has no order to page over.
		expect(sql).toContain("LIMIT 50\n        OFFSET 100")
		expect(sql.split("OFFSET").length - 1).toBe(1)
	})

	it("emits no OFFSET clause for the first page", () => {
		expect(compileUnsafe(aiSessionListQuery({ offset: 0 }), params).sql).not.toContain("OFFSET")
		expect(compileUnsafe(aiSessionListQuery(), params).sql).not.toContain("OFFSET")
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

		expect(sql).toContain("FROM ai_trace_index")
		expect(sql).not.toContain("FROM traces")
		expect(sql).not.toContain("trace_detail_spans")
		expect(sql).not.toContain("TraceId IN (SELECT")
		expect(sql).toContain("UNION ALL")
	})

	it("counts distinct sessions per vendor and per service", () => {
		const { sql } = compileUnionUnsafe(aiSessionFacetsQuery(), params)

		expect(sql).toContain("groupUniqArray(VendorId) AS names")
		expect(sql).toContain("groupUniqArray(ServiceName) AS names")
		expect(sql.split("arrayJoin(names) AS name").length - 1).toBe(2)
		expect(sql).toContain("'vendor' AS facetType")
		expect(sql).toContain("'service' AS facetType")
		expect(sql.split("GROUP BY name").length - 1).toBe(2)
		expect(sql.split("ORDER BY count DESC").length - 1).toBe(2)
	})

	it("counts the trace's session key, resolved one level below the count", () => {
		const { sql } = compileUnionUnsafe(aiSessionFacetsQuery(), params)

		// Keyed per span, a facet would count every agent span of a session-bearing
		// trace that lacks the id — most of them — as its own sessionless trace,
		// and roughly double every number in the sidebar. So the key is resolved
		// per trace and only then counted.
		expect(sql.split(`uniqExact(${SESSION_KEY}) AS count`).length - 1).toBe(2)
		expect(sql.split("GROUP BY traceId").length - 1).toBe(2)
		expect(sql).not.toContain("uniqExact(SpanAttributes['maple_ai.session.id'])")
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

	it("counts over the same population the list detects, and drops the blank option", () => {
		const { sql } = compileUnionUnsafe(aiSessionFacetsQuery(), params)

		// Same surface as `aiSessionListQuery`'s detection — index membership is
		// the vendor guard — so the population a facet describes is exactly the
		// population its filter selects. Only the blank-option guard remains as a
		// predicate.
		expect(sql.split("FROM ai_trace_index").length - 1).toBe(2)
		expect(sql).not.toContain("mapContains")
		expect(sql).toContain("VendorId != ''")
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
		expect(sql).toContain("mapFilter((k, v) -> (k IN ('maple_ai.session.id', ")
		expect(sql).toContain("OR k LIKE 'gen_ai.prompt.variable.%'), SpanAttributes) AS spanAttributes")
		expect(sql).not.toContain("ResourceAttributes")
		expect(sql).toContain("ORDER BY timestamp ASC")
		expect(sql).toContain("LIMIT 2000")
	})

	it("projects every key the mapper reads, across vendors", () => {
		const { sql } = compileUnsafe(aiSessionSpansQuery(), spanParams)

		for (const key of [
			"maple_ai.vendor.id",
			"gen_ai.input.messages",
			"gen_ai.usage.prompt_tokens", // legacy alias
			"ai.usage.inputTokens", // vercel_ai_sdk
			"llm.token_count.prompt", // openinference
			"openinference.span.kind", // read by a refine hook, not a source list
			"eve.turn.id",
			"maple_ai.turn.id",
			"error.type",
		]) {
			expect(sql, key).toContain(`'${key}'`)
		}
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
			},
		])

		expect(row?.durationMs).toBe(250)
		expect(row?.spanAttributes).toEqual({
			"maple_ai.vendor.id": "eve",
			"maple_ai.session.id": "wrun_01M0CSAEW96BH2W9185XZPRPKH",
		})
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

// The `trace:` half of the pair — a session whose vendor exposes no session key,
// so its id names the trace and neither read touches `maple_ai.session.id`.

describe("aiTraceWindowQuery", () => {
	const traceWindowParams = { orgId: params.orgId, traceId: TRACE_ID }

	it("resolves the bounds from the trace id, without a time predicate", () => {
		const { sql } = compileUnsafe(aiTraceWindowQuery(), traceWindowParams)

		// `idx_trace_id` on `traces` is what bounds this, exactly as the mapValues
		// bloom index bounds the session-id form.
		expect(sql).toContain("FROM traces")
		expect(sql).toContain(`TraceId = '${TRACE_ID}'`)
		expect(sql).not.toContain("SpanAttributes")
		expect(sql).not.toContain("Timestamp >=")
		expect(sql).not.toContain("Timestamp <=")
	})

	it("reports bounds padded exactly like the session form", () => {
		const { sql } = compileUnsafe(aiTraceWindowQuery(), traceWindowParams)

		expect(sql).toContain("toString(min(Timestamp) - INTERVAL 86400 SECOND) AS startTime")
		expect(sql).toContain("toString(max(Timestamp) + INTERVAL 86400 SECOND) AS endTime")
	})

	it("is org-scoped, and escapes the trace id", () => {
		const compiled = compileUnsafe(aiTraceWindowQuery(), traceWindowParams)
		expect(compiled.tenantScope).toBe("single-tenant")
		expect(orgPredicateCount(compiled.sql)).toBe(1)

		// The route only ever passes 32 hex characters, but the compiled SQL is
		// where that stops being the only thing between a forged id and the query.
		const escaped = compileUnsafe(aiTraceWindowQuery(), {
			...traceWindowParams,
			traceId: "trace'evil",
		})
		expect(escaped.sql).toContain("TraceId = 'trace\\'evil'")
	})

	it("leaves no unresolved param placeholder", () => {
		expect(compileUnsafe(aiTraceWindowQuery(), traceWindowParams).sql).not.toContain("__PARAM_")
	})

	it("decodes the quoted 64-bit count", () => {
		const compiled = compileUnsafe(aiTraceWindowQuery(), traceWindowParams)

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

describe("aiTraceSpansQuery", () => {
	it("reads one trace's spans directly, with no detection subquery", () => {
		const { sql } = compileUnsafe(aiTraceSpansQuery(), traceParams)

		// `TraceId` is a sort-key prefix of `trace_detail_spans`, so the id alone
		// is a seek — there is nothing left for a detection level to resolve.
		expect(sql).toContain("FROM trace_detail_spans")
		expect(sql).toContain(`TraceId = '${TRACE_ID}'`)
		expect(sql).not.toContain("TraceId IN (SELECT")
		expect(sql).not.toContain("FROM traces")
		// The projection still names the key; only the predicate is gone.
		expect(sql).not.toContain("SpanAttributes['maple_ai.session.id']")
	})

	it("keeps the projection and the order of the session form", () => {
		const { sql } = compileUnsafe(aiTraceSpansQuery(), traceParams)

		// One shape whichever kind of session the detail page opened.
		expect(sql).toContain("Duration / 1000000 AS durationMs")
		expect(sql).toContain("SpanAttributes) AS spanAttributes")
		expect(sql).not.toContain("ResourceAttributes")
		expect(sql).toContain("ORDER BY timestamp ASC, spanId ASC")
		expect(sql).toContain("LIMIT 2000")
		expect(compileUnsafe(aiTraceSpansQuery({ limit: 100 }), traceParams).sql).toContain("LIMIT 100")
	})

	it("still bounds the read by the window", () => {
		const { sql } = compileUnsafe(aiTraceSpansQuery(), traceParams)

		// The sort key prunes granules; only the `Timestamp` predicate prunes
		// partitions, and this table is PARTITION BY toDate(Timestamp).
		expect(sql).toContain(`Timestamp >= '${params.startTime}'`)
		expect(sql).toContain(`Timestamp <= '${params.endTime}'`)
	})

	it("is org-scoped on the one level it has, and escapes the trace id", () => {
		const compiled = compileUnsafe(aiTraceSpansQuery(), traceParams)
		expect(compiled.tenantScope).toBe("single-tenant")
		expect(orgPredicateCount(compiled.sql)).toBe(1)

		const escaped = compileUnsafe(aiTraceSpansQuery(), { ...traceParams, traceId: "trace'evil" })
		expect(escaped.sql).toContain("TraceId = 'trace\\'evil'")
	})

	it("leaves no unresolved param placeholder", () => {
		expect(compileUnsafe(aiTraceSpansQuery(), traceParams).sql).not.toContain("__PARAM_")
	})

	it("decodes through the same row schema as the session form", () => {
		const compiled = compileUnsafe(aiTraceSpansQuery(), traceParams, {
			rowSchema: aiSessionSpansRowSchema,
		})

		const [row] = decodeRows(compiled, [
			{
				traceId: TRACE_ID,
				spanId: "aa11",
				parentSpanId: "",
				spanName: "chat",
				spanKind: "Client",
				serviceName: "rag-service",
				durationMs: "250",
				statusCode: "Ok",
				statusMessage: "",
				timestamp: "2026-08-19 10:33:25.825000000",
				// A sessionless vendor: the stamp is there, the session key is not.
				spanAttributes: { "maple_ai.vendor.id": "llamaindex" },
			},
		])

		expect(row?.durationMs).toBe(250)
		expect(row?.spanAttributes).toEqual({ "maple_ai.vendor.id": "llamaindex" })
	})
})

describe("aiSessionSpansQuery — scope and cursor", () => {
	it("keeps the agent spans alone under the ai scope, and the app's alone under app", () => {
		const ai = compileUnsafe(aiSessionSpansQuery({ scope: "ai" }), spanParams).sql
		const app = compileUnsafe(aiSessionSpansQuery({ scope: "app" }), spanParams).sql
		const all = compileUnsafe(aiSessionSpansQuery(), spanParams).sql

		expect(ai).toContain("AND SpanAttributes['maple_ai.vendor.id'] != ''")
		expect(app).toContain("AND SpanAttributes['maple_ai.vendor.id'] = ''")
		expect(all).not.toContain("AND SpanAttributes['maple_ai.vendor.id']")
	})

	it("resumes strictly after the cursor in the page order", () => {
		const { sql } = compileUnsafe(
			aiSessionSpansQuery({ after: { timestamp: "2026-08-19 10:00:00.123456789", spanId: "aa11" } }),
			spanParams,
		)

		// Same pair, same direction as the ORDER BY — the tuple comparison
		// spelled out, since the tie-breaker only applies at an equal timestamp.
		expect(sql).toContain(
			"(Timestamp > '2026-08-19 10:00:00.123456789' OR (Timestamp = '2026-08-19 10:00:00.123456789' AND SpanId > 'aa11'))",
		)
		expect(sql).toContain("ORDER BY timestamp ASC, spanId ASC")
	})

	it("escapes a cursor span id carrying a quote", () => {
		const { sql } = compileUnsafe(
			aiSessionSpansQuery({ after: { timestamp: "2026-08-19 10:00:00.000000000", spanId: "a'b" } }),
			spanParams,
		)
		expect(sql).toContain("SpanId > 'a\\'b'")
	})
})

describe("aiTraceSpansQuery — a turn's traces", () => {
	it("reads the named traces and nothing else, with no detection level", () => {
		const { sql } = compileUnsafe(
			aiTraceSpansQuery({ traceIds: [TRACE_ID, "0123456789abcdef0123456789abcdef"], scope: "app" }),
			{ orgId: "org_1", startTime: "2026-08-18 00:00:00", endTime: "2026-08-19 23:59:59" },
		)

		expect(sql).toContain(`TraceId IN ('${TRACE_ID}', '0123456789abcdef0123456789abcdef')`)
		expect(sql).not.toContain("__PARAM_")
		expect(sql).not.toContain("FROM traces")
		expect(sql).toContain("SpanAttributes['maple_ai.vendor.id'] = ''")
	})
})

describe("aiSessionSummaryQuery", () => {
	const summaryParams = { ...spanParams }

	it("groups the session's spans by conversation id, falling back to the trace", () => {
		const { sql } = compileUnsafe(aiSessionSummaryQuery(), summaryParams)

		expect(sql).toContain("FROM trace_detail_spans")
		expect(sql).toContain("TraceId IN (SELECT")
		expect(sql).toContain(`SpanAttributes['maple_ai.session.id'] = 'wrun_01M0CSAEW96BH2W9185XZPRPKH'`)
		expect(sql).toContain("GROUP BY turnKey")
		expect(sql).toContain("ORDER BY startTime ASC")
		expect(sql).toContain("LIMIT 1001")
		// The turn ids the refine hooks lift into the field are read alongside it.
		expect(sql).toContain(
			"coalesce(nullIf(SpanAttributes['gen_ai.conversation.id'], ''), nullIf(SpanAttributes['eve.turn.id'], ''), nullIf(SpanAttributes['maple_ai.turn.id'], ''), '')",
		)
	})

	it("reads usage across every vendor spelling, per call and in total", () => {
		const { sql } = compileUnsafe(aiSessionSummaryQuery(), summaryParams)

		for (const key of ["gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens", "ai.usage.inputTokens", "llm.token_count.prompt"]) {
			expect(sql, key).toContain(`SpanAttributes['${key}']`)
		}
		expect(sql).toContain("AS inputTokens")
		expect(sql).toContain("AS llmInputTokens")
		expect(sql).toContain("IN ('chat', 'generate_content', 'text_completion', 'fetch_response')")
		expect(sql).toContain("NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent'")
	})

	it("is org-scoped on both levels", () => {
		const { sql } = compileUnsafe(aiSessionSummaryQuery(), summaryParams)
		expect(orgPredicateCount(sql)).toBe(2)
	})

	it("keys a trace session on the trace, with the same projection", () => {
		const session = compileUnsafe(aiSessionSummaryQuery(), summaryParams).sql
		const trace = compileUnsafe(aiTraceSummaryQuery(), traceParams).sql

		expect(trace).toContain(`TraceId = '${TRACE_ID}'`)
		expect(trace).not.toContain("FROM traces")
		expect(trace.split("FROM trace_detail_spans")[0]).toBe(session.split("FROM trace_detail_spans")[0])
		expect(orgPredicateCount(trace)).toBe(1)
	})

	it("guards every usage sum against a non-finite attribute", () => {
		const { sql } = compileUnsafe(aiSessionSummaryQuery(), summaryParams)
		for (const alias of ["inputTokens", "llmInputTokens", "cost", "llmCost"]) {
			expect(sql, alias).toMatch(new RegExp(`ifNotFinite\\(sum(If)?\\(toFloat64OrZero\\([^\\n]*, 0\\) AS ${alias},`))
		}
	})

	it("reads the whole session's measures ungrouped, under the same detection", () => {
		const totals = compileUnsafe(aiSessionTotalsQuery(), summaryParams).sql
		const trace = compileUnsafe(aiTraceTotalsQuery(), traceParams).sql

		expect(totals).toContain("uniqExact(TraceId) AS traceCount")
		expect(totals).not.toContain("GROUP BY")
		expect(totals).not.toContain("turnKey")
		expect(totals).toContain("AS llmInputTokens")
		expect(totals).toContain(`SpanAttributes['maple_ai.session.id'] = 'wrun_01M0CSAEW96BH2W9185XZPRPKH'`)
		expect(orgPredicateCount(totals)).toBe(2)
		expect(trace).toContain(`TraceId = '${TRACE_ID}'`)
		expect(orgPredicateCount(trace)).toBe(1)
	})

	it("decodes the quoted 64-bit aggregates and the arrays", () => {
		const compiled = compileUnsafe(aiSessionSummaryQuery(), summaryParams, {
			rowSchema: aiSessionSummaryRowSchema,
		})
		const [row] = decodeRows(compiled, [
			{
				turnKey: "turn_0",
				conversationId: "turn_0",
				traceIds: ["6b0c0e0a"],
				startTime: "2026-08-19 10:33:25.825000000",
				endTime: "2026-08-19 10:33:26.825000000",
				durationMs: "1000",
				spanCount: "12",
				aiSpanCount: "4",
				llmCalls: "2",
				toolCalls: "1",
				errorSpanCount: "0",
				inputTokens: "300",
				outputTokens: "40",
				cacheReadTokens: "0",
				llmInputTokens: "300",
				llmOutputTokens: "40",
				llmCacheReadTokens: "0",
				costReporters: "2",
				cost: 0.0123,
				llmCost: 0.0123,
				models: ["gpt-5"],
				agentNames: [],
			},
		])

		expect(row).toMatchObject({ spanCount: 12, durationMs: 1000, inputTokens: 300, cost: 0.0123, models: ["gpt-5"] })
	})
})
