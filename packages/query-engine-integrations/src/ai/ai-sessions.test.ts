import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
	compileUnsafe,
	compileUnionUnsafe,
	QueryBuilderDefect,
	type CompiledQuery,
} from "@maple-dev/clickhouse-builder"
import {
	aiSessionFacetsQuery,
	aiSessionListQuery,
	idSearchPattern,
	aiSessionPageQuery,
	aiSessionSpansQuery,
	aiSessionSpansRowSchema,
	aiSessionWindowQuery,
	aiTraceSpansQuery,
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

/** The same key on the list's joined level, where both sides are qualified. */
const LIST_SESSION_KEY =
	"if(index_traces.rawSessionId = '', concat('trace:', session_traces.traceId), index_traces.rawSessionId)"

/** The extent of one page's agent spans — what `aiSessionPageQuery` reports and
 *  the only window the fan-out is ever run over. Inside the caller's, by
 *  construction: the page was ranked within it. */
const FAN_OUT_START = "2026-08-18 10:00:00"
const FAN_OUT_END = "2026-08-18 12:00:00"

/** Stage 2's ENTIRE param set — the caller's window is not among them. */
const listParams = { orgId: params.orgId, fanOutStart: FAN_OUT_START, fanOutEnd: FAN_OUT_END }

/** A page of two sessions, one of each kind — the list never runs without one. */
const listOpts = {
	sessionIds: ["wrun_01M0CSAEW96BH2W9185XZPRPKH", `trace:${TRACE_ID}`],
}

const decodeRows = <T>(compiled: CompiledQuery<T>, rows: ReadonlyArray<Record<string, unknown>>) =>
	Effect.runSync(compiled.decodeRows(rows))

/** `OrgId = 'x'` on every level that reads a table — a subquery contributes
 *  nothing to the outer query's scope. */
const orgPredicateCount = (sql: string) => sql.split("OrgId = 'org_1'").length - 1

describe("aiSessionPageQuery", () => {
	it("ranks the page on ai_trace_index alone, never on trace_detail_spans", () => {
		const { sql } = compileUnsafe(aiSessionPageQuery(), params)

		// The whole point of the split: this is the only read that sees the
		// caller's window, so it must stay on the filtered projection. The moment
		// it touches the fan-out table it costs what the single-read shape cost —
		// 5–15s on a day, killed on a month (see the file header).
		expect(sql).toContain("FROM ai_trace_index")
		expect(sql).not.toContain("trace_detail_spans")
		expect(sql).not.toContain("FROM traces")
		expect(sql).not.toContain("SpanAttributes")
	})

	it("resolves the trace's session key, then groups the traces into sessions", () => {
		const { sql } = compileUnsafe(aiSessionPageQuery(), params)

		// Per trace first, because sessionless-ness is a property of the TRACE:
		// keyed per index row, every non-turn agent span would become its own
		// `trace:` session. Only then is the key grouped over.
		expect(sql).toContain("max(SessionId) AS rawSessionId")
		expect(sql).toContain(`${SESSION_KEY} AS sessionId`)
		expect(sql).toContain("GROUP BY traceId")
		expect(sql).toContain("GROUP BY sessionId")
	})

	it("returns the page's agent-span bounds and nothing else", () => {
		const { sql } = compileUnsafe(aiSessionPageQuery(), params)

		// These three columns ARE the contract with the fan-out: the ids it seeks
		// by, and the window it seeks in.
		expect(sql).toContain("toString(min(traceAgentStart)) AS agentStart")
		expect(sql).toContain("toString(max(traceAgentEnd)) AS agentEnd")
		expect(sql).not.toContain("spanCount")
		expect(sql).not.toContain("serviceNames")
	})

	it("orders by the first agent span, with the session id breaking ties", () => {
		const { sql } = compileUnsafe(aiSessionPageQuery(), params)

		// `agentStart` is a fixed-width literal, so the String order is the
		// instant order. The tiebreak is what stops a page boundary splitting two
		// sessions that share a start — one would be shown twice and one never.
		expect(sql).toContain("ORDER BY agentStart DESC, sessionId ASC")
		expect(sql).toContain("LIMIT 50")
	})

	it("skips past the previous pages on the ordered session rows", () => {
		const { sql } = compileUnsafe(aiSessionPageQuery({ limit: 25, offset: 100 }), params)

		// The per-trace derived table has no order to page over, so the offset
		// belongs to the level that ranked the sessions.
		expect(sql).toContain("LIMIT 25\n        OFFSET 100")
		expect(sql.split("OFFSET").length - 1).toBe(1)
	})

	it("emits no OFFSET clause for the first page", () => {
		expect(compileUnsafe(aiSessionPageQuery({ offset: 0 }), params).sql).not.toContain("OFFSET")
		expect(compileUnsafe(aiSessionPageQuery(), params).sql).not.toContain("OFFSET")
	})

	it("applies both filters as trace-level existence tests, after the grouping", () => {
		const { sql } = compileUnsafe(
			aiSessionPageQuery({ vendorIds: ["eve"], serviceNames: ["maple-slack-agent"] }),
			params,
		)

		// HAVING, not WHERE: a row predicate would also narrow the rows
		// `rawSessionId` is read from, so a vendor filter would file a trace under
		// `trace:` whenever its turn-owning span belongs to the other vendor it
		// calls through. It also has to match `aiSessionFacetsQuery`'s any-span
		// counting, or the sidebar's number and the page's length disagree.
		expect(sql).toContain("HAVING countIf(VendorId IN ('eve')) > 0")
		expect(sql).toContain("AND countIf(ServiceName IN ('maple-slack-agent')) > 0")
		expect(sql).not.toContain("WHERE VendorId IN")
	})

	it("tests each filter dimension separately, not one row against both", () => {
		const { sql } = compileUnsafe(
			aiSessionPageQuery({ vendorIds: ["eve"], serviceNames: ["maple-slack-agent"] }),
			params,
		)
		const [where] = sql.split("GROUP BY traceId")

		// Two `countIf`s, not one: the semantics are "SOME agent span of the trace
		// is eve" AND "SOME agent span of the trace is maple-slack-agent" — which
		// need not be the same span. A single row-level
		// `WHERE VendorId IN (…) AND ServiceName IN (…)` would demand one span
		// satisfying both, and would drop an eve session whose eve spans and whose
		// maple-slack-agent spans are different spans — the ordinary case, since a
		// trace's spans come from several services. Neither name may appear in the
		// index read's WHERE at all.
		expect(sql.split("countIf(").length - 1).toBe(2)
		expect(where).not.toContain("VendorId")
		expect(where).not.toContain("ServiceName")
		expect(sql).not.toContain("VendorId IN ('eve') AND ServiceName")
	})

	it("omits the optional filters when none are given", () => {
		const { sql } = compileUnsafe(aiSessionPageQuery(), params)

		expect(sql).not.toContain("HAVING")
		expect(sql).not.toContain("VendorId IN")
		expect(sql).not.toContain("ServiceName IN")
	})

	it("is org-scoped, and escapes an org id carrying a quote", () => {
		const compiled = compileUnsafe(aiSessionPageQuery(), params)
		expect(compiled.tenantScope).toBe("single-tenant")
		expect(orgPredicateCount(compiled.sql)).toBe(1)

		expect(compileUnsafe(aiSessionPageQuery(), { ...params, orgId: "org'evil" }).sql).toContain(
			"OrgId = 'org\\'evil'",
		)
	})

	it("bounds the read by the caller's window, unpadded", () => {
		const { sql } = compileUnsafe(aiSessionPageQuery(), params)

		// The pad belongs to the fan-out, which reads whole traces. The page reads
		// agent spans only, and widening it would change which sessions the range
		// reports.
		expect(sql).toContain(`Timestamp >= '${params.startTime}'`)
		expect(sql).toContain(`Timestamp <= '${params.endTime}'`)
		expect(sql).not.toContain("INTERVAL")
	})

	it("leaves no unresolved param placeholder", () => {
		expect(compileUnsafe(aiSessionPageQuery(), params).sql).not.toContain("__PARAM_")
	})

	it("decodes the bounds the fan-out takes back as params", () => {
		const compiled = compileUnsafe(aiSessionPageQuery(), params)

		expect(
			decodeRows(compiled, [
				{
					sessionId: "wrun_01M0CSAEW96BH2W9185XZPRPKH",
					agentStart: "2026-08-19 10:33:25.825000000",
					agentEnd: "2026-08-19 10:33:36.242000000",
					models: ["claude-sonnet-5"],
					agentNames: ["slack-agent"],
					llmCalls: "12",
					toolCalls: "7",
					errorAgentSpans: "1",
					totalTokens: 184_320,
					cost: 0.4125,
					agentDurationMs: "10417",
				},
			]),
		).toEqual([
			{
				sessionId: "wrun_01M0CSAEW96BH2W9185XZPRPKH",
				agentStart: "2026-08-19 10:33:25.825000000",
				agentEnd: "2026-08-19 10:33:36.242000000",
				models: ["claude-sonnet-5"],
				agentNames: ["slack-agent"],
				llmCalls: 12,
				toolCalls: 7,
				errorAgentSpans: 1,
				totalTokens: 184_320,
				cost: 0.4125,
				agentDurationMs: 10_417,
			},
		])
	})

	it("tests every counted filter per trace, one per index column", () => {
		const { sql } = compileUnsafe(
			aiSessionPageQuery({
				deploymentEnvs: ["production"],
				models: ["gpt-5.5", "claude-sonnet-5"],
				agentNames: ["billing-agent"],
				toolNames: ["send_email"],
				search: "  wrun01M0  ",
			}),
			params,
		)
		const [where, having] = sql.split("GROUP BY traceId")

		// Per trace, not per row: a model sits on the chat span and a tool on the
		// tool span, so a row predicate ANDing the two can never match. The
		// grouping is what lets one facet's value and another's combine.
		expect(having).toContain("countIf(DeploymentEnv IN ('production')) > 0")
		expect(having).toContain("countIf(Model IN ('gpt-5.5', 'claude-sonnet-5')) > 0")
		expect(having).toContain("countIf(AgentName IN ('billing-agent')) > 0")
		expect(having).toContain("countIf(ToolName IN ('send_email')) > 0")
		expect(having).toContain("countIf((SessionId LIKE 'wrun01M0%' OR TraceId LIKE 'wrun01M0%')) > 0")
		expect(where).not.toContain(" IN ('")
		expect(where).not.toContain("LIKE")
	})

	it("ignores a blank search", () => {
		expect(compileUnsafe(aiSessionPageQuery({ search: "   " }), params).sql).not.toContain("LIKE")
	})

	it("collects the measures per trace off the index, and sums them per session", () => {
		const { sql } = compileUnsafe(aiSessionPageQuery(), params)
		const [outer, inner] = sql.split("FROM (SELECT")

		expect(inner).toContain("groupUniqArrayIf(20)(Model, Model != '') AS models")
		expect(inner).toContain("groupUniqArrayIf(20)(AgentName, AgentName != '') AS agentNames")
		expect(inner).toContain("sum(IsLlmCall) AS llmCalls")
		expect(inner).toContain("sum(IsToolCall) AS toolCalls")
		expect(inner).toContain("sum(IsError) AS errorAgentSpans")
		expect(inner).toContain(
			"groupArrayIf(2000)(tuple(SpanId, ParentSpanId, Tokens, Cost), (Tokens > 0 OR Cost > 0)) AS usageReporters",
		)
		expect(inner).toContain(
			"max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) AS traceAgentEndNanos",
		)

		expect(outer).toContain("groupUniqArrayArray(models) AS models")
		expect(outer).toContain("sum(llmCalls) AS llmCalls")
		expect(outer).toContain("sum(errorAgentSpans) AS errorAgentSpans")
		// Deepest reporter: a parent keeps only its excess over its reporting children.
		expect(outer).toContain(
			"sum(arraySum(r -> greatest(0., r.3 - arraySum(c -> if(c.2 = r.1, c.3, 0.), usageReporters)), usageReporters)) AS totalTokens",
		)
		expect(outer).toContain(
			"sum(arraySum(r -> greatest(0., r.4 - arraySum(c -> if(c.2 = r.1, c.4, 0.), usageReporters)), usageReporters)) AS cost",
		)
		expect(outer).toContain(
			"intDiv(max(traceAgentEndNanos) - toUnixTimestamp64Nano(min(traceAgentStart)), 1000000) AS agentDurationMs",
		)
		// Still index-only: none of it reaches for the fan-out table.
		expect(sql).not.toContain("trace_detail_spans")
	})

	it("filters the ranked row with HAVING, after the session grouping", () => {
		const { sql } = compileUnsafe(
			aiSessionPageQuery({
				hasErrors: true,
				excludeTraceSessions: true,
				durationMinMs: 1_000,
				durationMaxMs: 60_000,
				costMin: 0.5,
				costMax: 2,
				tokensMin: 100,
				tokensMax: 200_000,
				llmCallsMin: 1,
				llmCallsMax: 40,
				toolCallsMin: 2,
				toolCallsMax: 9,
			}),
			params,
		)

		const having = sql.slice(sql.indexOf("GROUP BY sessionId"), sql.indexOf("ORDER BY"))
		expect(having).toContain("errorAgentSpans > 0")
		expect(having).toContain("NOT (sessionId LIKE 'trace:%')")
		expect(having).toContain("agentDurationMs >= 1000")
		expect(having).toContain("agentDurationMs <= 60000")
		expect(having).toContain("cost >= 0.5")
		expect(having).toContain("cost <= 2")
		expect(having).toContain("totalTokens >= 100")
		expect(having).toContain("totalTokens <= 200000")
		expect(having).toContain("llmCalls >= 1")
		expect(having).toContain("llmCalls <= 40")
		expect(having).toContain("toolCalls >= 2")
		expect(having).toContain("toolCalls <= 9")
	})

	it("treats an explicit false as no filter, and the default sort as the baseline order", () => {
		const { sql } = compileUnsafe(
			aiSessionPageQuery({ hasErrors: false, excludeTraceSessions: false }),
			params,
		)

		expect(sql.slice(sql.indexOf("GROUP BY sessionId"))).not.toContain("HAVING")
		expect(sql).toContain("ORDER BY agentStart DESC, sessionId ASC")
	})

	it("sorts by the requested measure with newest-first and the session id as tiebreaks", () => {
		expect(compileUnsafe(aiSessionPageQuery({ sortBy: "cost", sortDir: "asc" }), params).sql).toContain(
			"ORDER BY cost ASC, agentStart DESC, sessionId ASC",
		)
		expect(compileUnsafe(aiSessionPageQuery({ sortBy: "durationMs" }), params).sql).toContain(
			"ORDER BY agentDurationMs DESC, agentStart DESC, sessionId ASC",
		)
		expect(compileUnsafe(aiSessionPageQuery({ sortBy: "errorSpanCount" }), params).sql).toContain(
			"ORDER BY errorAgentSpans DESC, agentStart DESC, sessionId ASC",
		)
		expect(
			compileUnsafe(aiSessionPageQuery({ sortBy: "startTime", sortDir: "asc" }), params).sql,
		).toContain("ORDER BY agentStart ASC, sessionId ASC")
	})
})

describe("idSearchPattern", () => {
	it("turns a pasted id into a prefix pattern", () => {
		expect(idSearchPattern("wrun_01M0")).toBe("wrun\\_01M0%")
	})

	it("strips what the list row shows around a trace session id", () => {
		expect(idSearchPattern("trace:7f3a4b5c…")).toBe("7f3a4b5c%")
		expect(idSearchPattern("trace:7f3a4b5c6d7e8f901234567890abcdef")).toBe(
			"7f3a4b5c6d7e8f901234567890abcdef%",
		)
	})

	it("escapes LIKE syntax so a pasted id matches literally", () => {
		expect(idSearchPattern("50%_off\\")).toBe("50\\%\\_off\\\\%")
	})
})

describe("aiSessionListQuery", () => {
	it("aggregates one page of sessions, seeking trace_detail_spans by trace id", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(listOpts), listParams)

		// The fan-out reads the MV whose sort key starts (OrgId, TraceId), and the
		// id set is pushed into that read by `IN` rather than joined — the same
		// reason `errorDetailTracesQuery` uses it.
		expect(sql).toContain("FROM trace_detail_spans")
		expect(sql).toContain("TraceId IN (SELECT")
		expect(sql).toContain("FROM ai_trace_index")
		expect(sql).not.toContain("FROM traces")
		expect(sql).toContain("GROUP BY traceId")
		expect(sql).toContain("GROUP BY sessionId")
		expect(sql).toContain("ORDER BY startTime DESC")
	})

	it("pages nowhere itself — the page it was handed is the page", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(listOpts), listParams)

		// A LIMIT here would cut the page the caller already ranked, and the
		// missing sessions would silently vanish from a scroll that had room.
		expect(sql).not.toContain("LIMIT")
		expect(sql).not.toContain("OFFSET")
	})

	it("restricts both index reads to the page's sessions, escaping the ids", () => {
		const { sql } = compileUnsafe(
			aiSessionListQuery({ sessionIds: ["wrun_01M0CSAEW96BH2W9185XZPRPKH", "sess'evil"] }),
			listParams,
		)

		// The ids come back off the page's own rows, but they are session ids a
		// vendor chose, so the escaping is what stands between one and the query.
		expect(sql).toContain(`${SESSION_KEY} IN ('wrun_01M0CSAEW96BH2W9185XZPRPKH', 'sess\\'evil')`)
		expect(sql.split(`${SESSION_KEY} IN (`).length - 1).toBe(2)
	})

	it("takes the session key from the index, not from the spans", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(listOpts), listParams)

		// The one JOIN in the file, and it is here so the aggregation files a trace
		// under exactly the key the page ranked it by: two derivations over two
		// windows can disagree, and a disagreement drops the row from its own page.
		expect(sql).toContain("INNER JOIN")
		expect(sql).toContain("AS index_traces ON session_traces.traceId = index_traces.traceId")
		expect(sql).toContain(`${LIST_SESSION_KEY} AS sessionId`)
		expect(sql).not.toContain("max(SpanAttributes['maple_ai.session.id'])")
		// The index read nested inside each side is `agent_traces`, so the JOIN's
		// own `index_traces` alias is the only thing that name resolves to — the
		// two used to collide one level apart.
		expect(sql.split("AS agent_traces").length - 1).toBe(2)
		expect(sql.split("AS index_traces").length - 1).toBe(1)
	})

	it("repeats the org predicate on every level that reads a table", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(listOpts), listParams)

		// Three now, not two: the fan-out plus both reads of the index — one for
		// the id set, one for the key. A subquery contributes nothing to the outer
		// query's scope.
		expect(orgPredicateCount(sql)).toBe(3)
	})

	it("is org-scoped", () => {
		expect(compileUnsafe(aiSessionListQuery(listOpts), listParams).tenantScope).toBe("single-tenant")
	})

	it("selects the page's traces on index membership, with no attribute predicate", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(listOpts), listParams)
		const [, detection] = sql.split("TraceId IN (SELECT")

		// The vendor predicate lives in `ai_trace_index_mv`'s write filter: every
		// row of the index carries a non-empty vendor id, so being in the table IS
		// the guard and the read touches no Map column.
		expect(detection).toContain("FROM ai_trace_index")
		expect(detection).not.toContain("mapContains")
		expect(detection).not.toContain("SpanAttributes")
	})

	it("keys a trace with no session id on the trace itself", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(listOpts), listParams)

		// One session per sessionless trace, resolved on the per-trace level: a
		// span of a session-bearing trace carries no session id of its own either.
		expect(sql).toContain("max(SessionId) AS rawSessionId")
		expect(sql).toContain("GROUP BY sessionId")
		// The guard that used to drop them. The key is never empty now, and a
		// blank one would have swallowed every such trace into one session.
		expect(sql).not.toContain("WHERE sessionId != ''")
	})

	it("tests session-id presence with mapContains AND a non-empty value", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(listOpts), listParams)

		// ClickHouse yields '' for a missing Map key, so mapContains alone would
		// rank spans carrying an empty session id as session-bearing.
		expect(sql).toContain(
			"(mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != '')",
		)
	})

	it("resolves the vendor from the earliest session-bearing span, not max()", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(listOpts), listParams)

		// max(vendorId) picked `vercel_ai_sdk` alphabetically over the `eve` that
		// actually ran the turn — see the builder's doc comment.
		expect(sql).not.toContain("max(SpanAttributes['maple_ai.vendor.id'])")
		expect(sql).toContain("argMin(SpanAttributes['maple_ai.vendor.id'], tuple(multiIf(")
		expect(sql).toContain("argMin(SpanAttributes['maple_ai.vendor.version'], tuple(multiIf(")
		expect(sql).toContain("argMin(session_traces.vendorId, session_traces.sessionStart) AS vendorId")
		expect(sql).toContain(
			"argMin(session_traces.vendorVersion, session_traces.sessionStart) AS vendorVersion",
		)
		// The sentinel must stay inside DateTime's range or toDateTime won't parse.
		expect(sql).toContain("toDateTime('2106-01-01 00:00:00')")
	})

	it("ranks a sessionless trace's spans so a vendor-stamped one wins", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(listOpts), listParams)

		// Every span of a sessionless trace ties at the sentinel under the session
		// ordering alone, and argMin over ties is non-deterministic — it handed
		// back whichever span was read first, blank vendor included. Rank first,
		// then time, compared as a tuple.
		expect(sql).toContain(
			`tuple(multiIf((mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != ''), 0, SpanAttributes['maple_ai.vendor.id'] != '', 1, 2), Timestamp)`,
		)
	})

	it("counts an attribute-declared failure on an Ok span as an error", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(listOpts), listParams)

		// Frameworks record failed model and tool calls as values on `Ok` spans,
		// and the list badge has to count what the detail page's Failures panel
		// counts — `spanFailed` in `session-turns.ts` is the other half.
		expect(sql).toContain(
			"countIf((StatusCode = 'Error' OR (SpanAttributes['maple_ai.vendor.id'] != '' AND (SpanAttributes['error.type'] != '' OR SpanAttributes['gen_ai.response.status'] IN ('failed', 'error')))))",
		)
	})

	it("escapes an org id carrying a quote", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(listOpts), {
			...listParams,
			orgId: "org'evil",
		})

		expect(sql).toContain("OrgId = 'org\\'evil'")
	})

	it("omits the optional filters when none are given", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(listOpts), listParams)

		expect(sql).not.toContain("VendorId IN")
		expect(sql).not.toContain("ServiceName IN")
	})

	it("puts both optional filters on the index level only", () => {
		const { sql } = compileUnsafe(
			aiSessionListQuery({
				...listOpts,
				vendorIds: ["eve"],
				serviceNames: ["maple-slack-agent"],
			}),
			listParams,
		)

		// Filtering the fan-out instead would drop spans and under-count spanCount.
		// They must also be the SAME filters the page ran under, or the two stages
		// resolve traces differently and the join silently loses rows.
		const [fanOut, detection] = sql.split("TraceId IN (SELECT")
		expect(detection).toContain("HAVING countIf(VendorId IN ('eve')) > 0")
		expect(detection).toContain("AND countIf(ServiceName IN ('maple-slack-agent')) > 0")
		expect(fanOut).not.toContain("IN ('eve')")
	})

	it("reads every level over the page's bounds — padded for the fan-out only", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(listOpts), listParams)
		const [fanOut, detection] = sql.split("TraceId IN (SELECT")

		// `trace_detail_spans` is PARTITION BY toDate(Timestamp), so this predicate
		// is the only thing that prunes partitions there — and the bounds are the
		// page's own agent spans, which span hours, not the caller's 30 days.
		expect(fanOut).toContain(`Timestamp >= '${FAN_OUT_START}' - INTERVAL 3600 SECOND`)
		expect(fanOut).toContain(`Timestamp <= '${FAN_OUT_END}' + INTERVAL 3600 SECOND`)
		// The index levels take the same bounds unpadded: a page trace's index rows
		// lie between its own session's agentStart and agentEnd by construction, so
		// the key and the filters come out of hours of the index rather than the
		// caller's month, and the two index scans stop being the cost they were.
		expect(detection).toContain(`Timestamp >= '${FAN_OUT_START}'`)
		expect(detection).toContain(`Timestamp <= '${FAN_OUT_END}'`)
		expect(detection).not.toContain("INTERVAL")
	})

	it("takes no window param from the caller at all", () => {
		const { sql } = compileUnsafe(aiSessionListQuery(listOpts), listParams)

		// `orgId`, `fanOutStart`, `fanOutEnd` and nothing else: a `startTime` param
		// left in the query would compile against a value this call never passes,
		// and the whole point is that no level here sees the caller's range.
		expect(sql).not.toContain(params.startTime)
		expect(sql).not.toContain(params.endTime)
		expect(sql).not.toContain("__PARAM_")
	})

	it("refuses an empty page rather than compiling `IN ()`", () => {
		// Not a failure the caller recovers from: `IN ()` is not SQL, and a caller
		// holding an empty page already knows to answer it without this read.
		expect(() => aiSessionListQuery({ sessionIds: [] })).toThrow(QueryBuilderDefect)
		expect(() => aiSessionListQuery({ sessionIds: [] })).toThrow(/needs the page's session ids/)
	})

	it("leaves no unresolved param placeholder", () => {
		expect(compileUnsafe(aiSessionListQuery(listOpts), listParams).sql).not.toContain("__PARAM_")
	})

	it("decodes quoted 64-bit aggregates and the service-name array", () => {
		const compiled = compileUnsafe(aiSessionListQuery(listOpts), listParams)

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

	it("counts distinct sessions per value of each index dimension", () => {
		const { sql } = compileUnionUnsafe(aiSessionFacetsQuery(), params)

		const dimensions = [
			["vendor", "VendorId"],
			["service", "ServiceName"],
			["environment", "DeploymentEnv"],
			["model", "Model"],
			["agent", "AgentName"],
			["tool", "ToolName"],
		] as const
		for (const [facetType, column] of dimensions) {
			expect(sql).toContain(`groupUniqArray(${column}) AS names`)
			expect(sql).toContain(`'${facetType}' AS facetType`)
		}
		expect(sql.split("arrayJoin(names) AS name").length - 1).toBe(dimensions.length)
		expect(sql.split("GROUP BY name").length - 1).toBe(dimensions.length)
		expect(sql.split("ORDER BY count DESC").length - 1).toBe(dimensions.length)
	})

	it("counts the trace's session key, resolved one level below the count", () => {
		const { sql } = compileUnionUnsafe(aiSessionFacetsQuery(), params)

		// Keyed per span, a facet would count every agent span of a session-bearing
		// trace that lacks the id — most of them — as its own sessionless trace,
		// and roughly double every number in the sidebar. So the key is resolved
		// per trace and only then counted.
		expect(sql.split(`uniqExact(${SESSION_KEY}) AS count`).length - 1).toBe(6)
		expect(sql.split("GROUP BY traceId").length - 1).toBe(6)
		expect(sql).not.toContain("uniqExact(SpanAttributes['maple_ai.session.id'])")
	})

	it("repeats the org and window predicates on every union branch", () => {
		const { sql } = compileUnionUnsafe(aiSessionFacetsQuery(), params)

		expect(orgPredicateCount(sql)).toBe(6)
		expect(sql.split(`Timestamp >= '${params.startTime}'`).length - 1).toBe(6)
		expect(sql.split(`Timestamp <= '${params.endTime}'`).length - 1).toBe(6)
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
		expect(sql.split("FROM ai_trace_index").length - 1).toBe(6)
		expect(sql).not.toContain("mapContains")
		for (const column of ["VendorId", "ServiceName", "DeploymentEnv", "Model", "AgentName", "ToolName"]) {
			expect(sql).toContain(`${column} != ''`)
		}
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
		expect(sql).not.toContain("maple_ai.session.id")
	})

	it("keeps the projection and the order of the session form", () => {
		const { sql } = compileUnsafe(aiTraceSpansQuery(), traceParams)

		// One shape whichever kind of session the detail page opened.
		expect(sql).toContain("Duration / 1000000 AS durationMs")
		expect(sql).toContain("SpanAttributes AS spanAttributes")
		expect(sql).toContain("ResourceAttributes AS resourceAttributes")
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
				resourceAttributes: { "service.name": "rag-service" },
			},
		])

		expect(row?.durationMs).toBe(250)
		expect(row?.spanAttributes).toEqual({ "maple_ai.vendor.id": "llamaindex" })
	})
})
