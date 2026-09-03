// SAFETY-FILE: JSON in this test is emitted by the route under test before its fields are asserted.
import { describe, expect, it } from "@effect/vitest"
import {
	AiSessionsInternalApiGroup,
	AI_SESSION_SPANS_MAX_SPANS,
	CurrentTenant,
	V1SchemaErrors,
	V1UnexpectedErrors,
} from "@maple/domain/http"

import { WarehouseResponseLimitError } from "@maple/query-engine/execution"
import { Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import type { WarehouseQueryServiceApi } from "@/services/warehouse/WarehouseQueryService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "../v2/v2-test-support"
import { V1ErrorBoundaryLive } from "../v1/error-boundary"
import { HttpAiSessionsInternalLive } from "./ai-sessions.http"
import { compiledQueryOf } from "@maple/query-engine/execution"

/**
 * The truncation contract of `POST /internal/ai-sessions/spans`: what the row
 * cap does, and what the byte cap does instead. Both are one-off shapes the
 * other warehouse reads have no equivalent of.
 *
 * Plus that `mapAiSpans` actually puts values on the wire, and that the facets
 * split agrees with the literals the query emits — both sides of which are
 * bare strings.
 */

class AiSessionsOnlyApi extends HttpApi.make("MapleInternalApi")
	.add(AiSessionsInternalApiGroup)
	.middleware(V1SchemaErrors)
	.middleware(V1UnexpectedErrors) {}

const SESSION_ID = "wrun_01KZTEST"
const TRACE_ID = "7f3a4b5c6d7e8f901234567890abcdef"
const WINDOW = { startTime: "2026-08-19 09:00:00", endTime: "2026-08-19 11:00:00" }
const SPANS_BODY = { sessionId: SESSION_ID, ...WINDOW }

const TENANT = new CurrentTenant.TenantSchema({
	orgId: "org_ai_sessions" as CurrentTenant.TenantSchema["orgId"],
	userId: "user_ai_sessions" as CurrentTenant.TenantSchema["userId"],
	roles: [],
	authMode: "self_hosted",
})

const AuthorizationStubLayer = Layer.succeed(
	CurrentTenant.SessionAuthorization,
	CurrentTenant.SessionAuthorization.of({
		bearer: (httpEffect) => Effect.provideService(httpEffect, CurrentTenant.Context, TENANT),
	}),
)

/** One warehouse row, in the wire shape `aiSessionSpansRowSchema` decodes. */
const spanRow = (index: number) => ({
	traceId: TRACE_ID,
	spanId: index.toString(16).padStart(16, "0"),
	parentSpanId: "",
	spanName: "chat",
	spanKind: "SPAN_KIND_CLIENT",
	serviceName: "agent-runner",
	durationMs: 12,
	statusCode: "Unset",
	statusMessage: "",
	timestamp: "2026-08-19 10:00:00.000000000",
	spanAttributes: { "gen_ai.operation.name": "chat", "maple_ai.session.id": SESSION_ID },
	resourceAttributes: {},
})

const makeHarness = (overrides: Partial<WarehouseQueryServiceApi>) => {
	const routes = HttpApiBuilder.layer(AiSessionsOnlyApi).pipe(
		Layer.provide(HttpAiSessionsInternalLive),
		Layer.provide(V1ErrorBoundaryLive),
		Layer.provideMerge(AuthorizationStubLayer),
		Layer.provideMerge(Layer.succeed(WarehouseQueryService, makeWarehouseServiceStub(overrides))),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes as never, { disableLogger: true })

	const post = async (path: string, body: unknown) => {
		// SAFETY: the handler's second argument is the Worker environment context,
		// and these routes read nothing out of it.
		const response = await handler(
			new Request(`http://maple.test${path}`, {
				method: "POST",
				headers: { authorization: "Bearer test-token", "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: JSON.parse(text) as Record<string, unknown> }
	}

	return { post, dispose }
}

describe("POST /internal/ai-sessions/spans", () => {
	it("answers a response-limit failure with the 413 the client can act on", async () => {
		const harness = makeHarness({
			compiledQueryBounded: () =>
				Effect.fail(
					new WarehouseResponseLimitError({ kind: "bytes", message: "response too large" }),
				),
		})

		try {
			const response = await harness.post("/internal/ai-sessions/spans", SPANS_BODY)
			expect(response.status).toBe(413)
			expect(response.body._tag).toBe("@maple/http/ai-sessions/AiSessionTooLargeError")
			expect(response.body.sessionId).toBe(SESSION_ID)
		} finally {
			await harness.dispose()
		}
	})

	it("cuts the session at the row cap and says so", async () => {
		// The query asks for one row past the cap precisely so this case is
		// distinguishable from a session that exactly fills it.
		const rows = Array.from({ length: AI_SESSION_SPANS_MAX_SPANS + 1 }, (_, index) => spanRow(index))
		const harness = makeHarness({
			compiledQueryBounded: (_tenant, compiled) =>
				compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie),
		})

		try {
			const response = await harness.post("/internal/ai-sessions/spans", SPANS_BODY)
			expect(response.status).toBe(200)
			expect(response.body.truncated).toBe(true)
			expect(response.body.data).toHaveLength(AI_SESSION_SPANS_MAX_SPANS)
		} finally {
			await harness.dispose()
		}
	})

	it("reports a session that fits as complete", async () => {
		const harness = makeHarness({
			compiledQueryBounded: (_tenant, compiled) =>
				compiledQueryOf(compiled)
					.decodeRows([spanRow(0), spanRow(1)])
					.pipe(Effect.orDie),
		})

		try {
			const response = await harness.post("/internal/ai-sessions/spans", SPANS_BODY)
			expect(response.status).toBe(200)
			expect(response.body.truncated).toBe(false)
			expect(response.body.data).toHaveLength(2)
		} finally {
			await harness.dispose()
		}
	})

	// A link that arrives with no `t`/`end` — pasted, or written by an agent. The
	// endpoint must resolve the session's real bounds rather than invent a range
	// OR read unbounded, and the compiled SQL is where that is decidable: the
	// resolve step is the only one allowed to carry no `Timestamp` predicate.
	it("resolves bounds from the id, then reads the spans within them", async () => {
		const resolved = {
			startTime: "2026-08-18 09:00:00.000000000",
			endTime: "2026-08-20 11:00:00.000000000",
		}
		let windowSql: string | undefined
		let spansSql: string | undefined
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled) => {
				windowSql = compiledQueryOf(compiled).sql
				return compiledQueryOf(compiled)
					.decodeRows([{ ...resolved, spanCount: "9" }])
					.pipe(Effect.orDie)
			},
			compiledQueryBounded: (_tenant, compiled) => {
				spansSql = compiledQueryOf(compiled).sql
				return compiledQueryOf(compiled)
					.decodeRows([spanRow(0), spanRow(1)])
					.pipe(Effect.orDie)
			},
		})

		try {
			const response = await harness.post("/internal/ai-sessions/spans", { sessionId: SESSION_ID })
			expect(response.status).toBe(200)
			expect(response.body.data).toHaveLength(2)
			// The bloom-indexed detection scan, unbounded on purpose.
			expect(windowSql).toContain(`SpanAttributes['maple_ai.session.id'] = '${SESSION_ID}'`)
			expect(windowSql).not.toContain("Timestamp >=")
			// The fan-out, which never runs that way.
			expect(spansSql).toContain(`Timestamp >= '${resolved.startTime}'`)
			expect(spansSql).toContain(`Timestamp <= '${resolved.endTime}'`)
			// An unbound placeholder would reach ClickHouse verbatim.
			expect(spansSql).not.toContain("__PARAM_")
		} finally {
			await harness.dispose()
		}
	})

	// A `trace:` id is Maple's own: the vendor exposed no session key, so the
	// trace IS the session. Both reads must key on the trace id — the session
	// attribute would match nothing, and the page would report an empty session
	// for a trace that is right there.
	it("routes a trace-scoped id to the trace-keyed window and span reads", async () => {
		const resolved = {
			startTime: "2026-08-18 09:00:00.000000000",
			endTime: "2026-08-20 11:00:00.000000000",
		}
		let windowSql: string | undefined
		let spansSql: string | undefined
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled) => {
				windowSql = compiledQueryOf(compiled).sql
				return compiledQueryOf(compiled)
					.decodeRows([{ ...resolved, spanCount: "9" }])
					.pipe(Effect.orDie)
			},
			compiledQueryBounded: (_tenant, compiled) => {
				spansSql = compiledQueryOf(compiled).sql
				return compiledQueryOf(compiled)
					.decodeRows([spanRow(0), spanRow(1)])
					.pipe(Effect.orDie)
			},
		})

		try {
			const response = await harness.post("/internal/ai-sessions/spans", {
				sessionId: `trace:${TRACE_ID}`,
			})
			expect(response.status).toBe(200)
			expect(response.body.data).toHaveLength(2)
			expect(windowSql).toContain(`TraceId = '${TRACE_ID}'`)
			expect(windowSql).not.toContain("maple_ai.session.id")
			expect(spansSql).toContain(`TraceId = '${TRACE_ID}'`)
			expect(spansSql).not.toContain("maple_ai.session.id")
			// The bounds the window read handed back still prune the span read.
			expect(spansSql).toContain(`Timestamp >= '${resolved.startTime}'`)
			expect(spansSql).not.toContain("__PARAM_")
		} finally {
			await harness.dispose()
		}
	})

	// The prefix is not proof: the value behind it reaches a warehouse param, so
	// anything that is not a trace id must not get there. It falls through to the
	// session read, where nothing carries it — the empty answer any unknown id gets.
	it("does not hand a malformed trace-scoped id to the trace-keyed read", async () => {
		let windowSql: string | undefined
		let spansRead = false
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled) => {
				windowSql = compiledQueryOf(compiled).sql
				return compiledQueryOf(compiled)
					.decodeRows([
						{
							startTime: "1970-01-01 00:00:00.000000000",
							endTime: "1970-01-02 00:00:00.000000000",
							spanCount: "0",
						},
					])
					.pipe(Effect.orDie)
			},
			compiledQueryBounded: (_tenant, compiled) => {
				spansRead = true
				return compiledQueryOf(compiled)
					.decodeRows([spanRow(0)])
					.pipe(Effect.orDie)
			},
		})

		try {
			const response = await harness.post("/internal/ai-sessions/spans", {
				sessionId: "trace:not-a-trace-id' OR 1=1",
			})
			expect(response.status).toBe(200)
			expect(response.body).toMatchObject({ data: [], truncated: false })
			expect(windowSql).toContain("SpanAttributes['maple_ai.session.id'] =")
			expect(windowSql).not.toContain("TraceId =")
			expect(spansRead).toBe(false)
		} finally {
			await harness.dispose()
		}
	})

	it("answers an id nothing in retention carries without reading spans", async () => {
		let spansRead = false
		const harness = makeHarness({
			// `min`/`max` over no rows come back as the epoch, so the count is the
			// only thing that says the session does not exist.
			compiledQuery: (_tenant, compiled) =>
				compiledQueryOf(compiled)
					.decodeRows([
						{
							startTime: "1970-01-01 00:00:00.000000000",
							endTime: "1970-01-02 00:00:00.000000000",
							spanCount: "0",
						},
					])
					.pipe(Effect.orDie),
			compiledQueryBounded: (_tenant, compiled) => {
				spansRead = true
				return compiledQueryOf(compiled)
					.decodeRows([spanRow(0)])
					.pipe(Effect.orDie)
			},
		})

		try {
			const response = await harness.post("/internal/ai-sessions/spans", { sessionId: SESSION_ID })
			expect(response.status).toBe(200)
			expect(response.body).toMatchObject({ data: [], truncated: false })
			expect(spansRead).toBe(false)
		} finally {
			await harness.dispose()
		}
	})

	it("bounds the read by the window when the caller supplies one", async () => {
		let compiledSql: string | undefined
		const harness = makeHarness({
			compiledQueryBounded: (_tenant, compiled) => {
				compiledSql = compiledQueryOf(compiled).sql
				return compiledQueryOf(compiled)
					.decodeRows([spanRow(0)])
					.pipe(Effect.orDie)
			},
		})

		try {
			const response = await harness.post("/internal/ai-sessions/spans", SPANS_BODY)
			expect(response.status).toBe(200)
			expect(compiledSql).toContain(`Timestamp >= '${WINDOW.startTime}'`)
			expect(compiledSql).toContain(`Timestamp <= '${WINDOW.endTime}'`)
		} finally {
			await harness.dispose()
		}
	})

	it("puts the mapped attribute values on the wire, not just the keys", async () => {
		const harness = makeHarness({
			compiledQueryBounded: (_tenant, compiled) =>
				compiledQueryOf(compiled)
					.decodeRows([spanRow(0)])
					.pipe(Effect.orDie),
		})

		try {
			const response = await harness.post("/internal/ai-sessions/spans", SPANS_BODY)
			const [span] = response.body.data as ReadonlyArray<Record<string, unknown>>
			expect(span).toMatchObject({
				sessionId: SESSION_ID,
				spanName: "chat",
				serviceName: "agent-runner",
				isAiSpan: true,
				genAi: { operationName: "chat" },
			})
		} finally {
			await harness.dispose()
		}
	})
})

/**
 * The list is two reads, and the handler is what holds them together: it derives
 * the fan-out's window from the page, and it re-imposes the page's order on an
 * aggregation that cannot know it. Both are invisible in either query alone.
 */
describe("POST /internal/ai-sessions/list", () => {
	const LIST_BODY = { ...WINDOW, limit: 3 }

	/** A stage-one row: a session id, the extent of its agent spans, and the
	 *  measures the index answered — which the response carries through. */
	const pageRow = (sessionId: string, agentStart: string, agentEnd: string) => ({
		sessionId,
		agentStart,
		agentEnd,
		models: ["claude-sonnet-5"],
		agentNames: ["slack-agent"],
		llmCalls: "4",
		toolCalls: "2",
		errorAgentSpans: "0",
		totalTokens: 18_400,
		cost: 0.12,
		agentDurationMs: "600000",
	})

	/** A stage-two row, in the wire shape the aggregation's SELECT decodes. */
	const listRow = (sessionId: string, startTime: string) => ({
		sessionId,
		vendorId: "eve",
		vendorVersion: "1",
		traceCount: "1",
		spanCount: "12",
		errorSpanCount: "0",
		serviceNames: ["agent-runner"],
		startTime,
		endTime: "2026-08-19 10:45:00.000000000",
		durationMs: "1000",
	})

	// Deliberately not in start order: the page ranks on the first AGENT span and
	// the aggregation orders by the first span of any kind, so the handler must
	// not be able to reconstruct one from the other.
	const PAGE = [
		pageRow("wrun_beta", "2026-08-19 10:20:00.000000000", "2026-08-19 10:30:00.000000000"),
		pageRow("wrun_alpha", "2026-08-19 10:05:00.000000000", "2026-08-19 10:40:00.000000000"),
		pageRow(`trace:${TRACE_ID}`, "2026-08-19 09:50:00.000000000", "2026-08-19 10:00:00.000000000"),
	]

	it("bounds the aggregation by the page's own agent spans, not the caller's window", async () => {
		let pageSql: string | undefined
		let listSql: string | undefined
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled, options) => {
				if (options?.context === "aiSessionsPage") {
					pageSql = compiledQueryOf(compiled).sql
					return compiledQueryOf(compiled).decodeRows(PAGE).pipe(Effect.orDie)
				}
				listSql = compiledQueryOf(compiled).sql
				return compiledQueryOf(compiled)
					.decodeRows(PAGE.map((row) => listRow(row.sessionId, row.agentStart)))
					.pipe(Effect.orDie)
			},
		})

		try {
			const response = await harness.post("/internal/ai-sessions/list", LIST_BODY)
			expect(response.status).toBe(200)
			// Stage one is the only read that sees the caller's window.
			expect(pageSql).toContain("FROM ai_trace_index")
			expect(pageSql).not.toContain("trace_detail_spans")
			expect(pageSql).toContain(`Timestamp <= '${WINDOW.endTime}'`)
			expect(pageSql).toContain("LIMIT 3")
			// Stage two reads the fan-out table over the page's extent — the min
			// agentStart and the max agentEnd of the rows stage one returned, padded.
			// The caller's window would be 30 days of partitions on the page the UI
			// actually offers.
			expect(listSql).toContain("FROM trace_detail_spans")
			expect(listSql).toContain("Timestamp >= '2026-08-19 09:50:00.000000000' - INTERVAL 3600 SECOND")
			expect(listSql).toContain("Timestamp <= '2026-08-19 10:40:00.000000000' + INTERVAL 3600 SECOND")
			// The caller's range reaches NO level of stage two — not the fan-out and
			// not either of its two `ai_trace_index` reads. The handler hands it
			// `orgId` and the page's two bounds, and nothing else.
			expect(listSql).not.toContain(WINDOW.startTime)
			expect(listSql).not.toContain(WINDOW.endTime)
			// Three levels take that lower bound — the fan-out padded, and each of
			// the two `ai_trace_index` reads exactly.
			expect(listSql?.split("Timestamp >= '2026-08-19 09:50:00.000000000'").length).toBe(4)
			expect(listSql).not.toContain("__PARAM_")
		} finally {
			await harness.dispose()
		}
	})

	it("seeks stage two by exactly the session ids stage one ranked", async () => {
		let listSql: string | undefined
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled, options) => {
				if (options?.context === "aiSessionsPage") {
					return compiledQueryOf(compiled).decodeRows(PAGE).pipe(Effect.orDie)
				}
				listSql = compiledQueryOf(compiled).sql
				return compiledQueryOf(compiled)
					.decodeRows(PAGE.map((row) => listRow(row.sessionId, row.agentStart)))
					.pipe(Effect.orDie)
			},
		})

		try {
			await harness.post("/internal/ai-sessions/list", LIST_BODY)
			for (const row of PAGE) {
				expect(listSql).toContain(`'${row.sessionId}'`)
			}
		} finally {
			await harness.dispose()
		}
	})

	it("answers in the page's order, dropping a session the aggregation lost", async () => {
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled, options) =>
				options?.context === "aiSessionsPage"
					? compiledQueryOf(compiled).decodeRows(PAGE).pipe(Effect.orDie)
					: compiledQueryOf(compiled)
							// Reversed, and one short: the aggregation's own ORDER BY is
							// meaningless to the client, and a trace whose spans fell outside
							// the padded window returns nothing at all.
							.decodeRows([
								listRow(`trace:${TRACE_ID}`, "2026-08-19 09:49:00.000000000"),
								listRow("wrun_beta", "2026-08-19 10:19:00.000000000"),
							])
							.pipe(Effect.orDie),
		})

		try {
			const response = await harness.post("/internal/ai-sessions/list", LIST_BODY)
			expect(response.status).toBe(200)
			// The page's order is the order that was paged; re-sorting here would
			// let a row jump between pages on a scroll. A session with no row is
			// dropped rather than shown with blank counts.
			const data = response.body.data as ReadonlyArray<Record<string, unknown>>
			expect(data.map((r) => r.sessionId)).toEqual(["wrun_beta", `trace:${TRACE_ID}`])
			// The page's measures ride along on the aggregation's row.
			expect(data[0]).toMatchObject({
				spanCount: 12,
				models: ["claude-sonnet-5"],
				agentNames: ["slack-agent"],
				llmCalls: 4,
				toolCalls: 2,
				totalTokens: 18_400,
				cost: 0.12,
			})
			expect(data[0]).not.toHaveProperty("errorAgentSpans")
			// Three ranked, two returned. `ranked` is what the client pages on: on
			// `data.length` this short page reads as the end of the list, and the
			// next offset would be one too low and re-show a session. The gap is
			// real — the two MVs are written one after the other from the same
			// insert, so the newest session can be ranked before its spans land.
			expect(response.body.ranked).toBe(PAGE.length)
			expect(response.body.ranked).toBe(3)
		} finally {
			await harness.dispose()
		}
	})

	it("answers an empty page without touching trace_detail_spans", async () => {
		const contexts: Array<string | undefined> = []
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled, options) => {
				contexts.push(options?.context)
				return compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie)
			},
		})

		try {
			const response = await harness.post("/internal/ai-sessions/list", LIST_BODY)
			expect(response.status).toBe(200)
			// `ranked` is omitted entirely, not sent as 0: the handler short-circuits
			// with `new ListAiSessionsResponse({ data: [] })`, and the field is an
			// `optionalKey`. The client's `?? data.length` fallback reads it as 0
			// either way, which is what ends the scroll.
			expect(response.body).toEqual({ data: [] })
			expect("ranked" in response.body).toBe(false)
			// One read, not two. With no ids to seek by, the fan-out's `IN ()` is a
			// builder defect, and the shape it would have compiled to reads the whole
			// padded window for nothing.
			expect(contexts).toEqual(["aiSessionsPage"])
		} finally {
			await harness.dispose()
		}
	})
})

describe("POST /internal/ai-sessions/facets", () => {
	// `pick("vendor")` in the handler and `facet("vendor", …)` in the query are
	// two independent string literals in two packages. If either drifts both
	// arrays come back empty behind a 200 and the sidebar silently loses every
	// option — a failure that looks exactly like "no data in this window".
	it("splits one union result into the six dimensions the sidebar reads", async () => {
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled) =>
				compiledQueryOf(compiled)
					.decodeRows([
						{ facetType: "vendor", name: "eve", count: 7 },
						{ facetType: "service", name: "agent-runner", count: 4 },
						{ facetType: "vendor", name: "vercel_ai_sdk", count: 2 },
						{ facetType: "environment", name: "production", count: 9 },
						{ facetType: "model", name: "claude-sonnet-5", count: 6 },
						{ facetType: "agent", name: "slack-agent", count: 5 },
						{ facetType: "tool", name: "search_traces", count: 3 },
					])
					.pipe(Effect.orDie),
		})

		try {
			const response = await harness.post("/internal/ai-sessions/facets", WINDOW)
			expect(response.status).toBe(200)
			expect(response.body.vendors).toEqual([
				{ name: "eve", count: 7 },
				{ name: "vercel_ai_sdk", count: 2 },
			])
			expect(response.body.services).toEqual([{ name: "agent-runner", count: 4 }])
			expect(response.body.environments).toEqual([{ name: "production", count: 9 }])
			expect(response.body.models).toEqual([{ name: "claude-sonnet-5", count: 6 }])
			expect(response.body.agents).toEqual([{ name: "slack-agent", count: 5 }])
			expect(response.body.tools).toEqual([{ name: "search_traces", count: 3 }])
		} finally {
			await harness.dispose()
		}
	})
})

describe("POST /internal/ai-sessions/list", () => {
	// Every filter is a payload field the handler has to hand to the builder by
	// name; a field the schema accepts and the handler forgets is a 200 that
	// silently ignores the sidebar. So the compiled SQL is what gets asserted —
	// the page's, which the stub answers empty so the fan-out never runs.
	it("hands every filter and the sort to the page query", async () => {
		let sql = ""
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled) => {
				sql = compiledQueryOf(compiled).sql
				return Effect.succeed([])
			},
		})

		try {
			const response = await harness.post("/internal/ai-sessions/list", {
				...WINDOW,
				vendorIds: ["eve"],
				serviceNames: ["agent-runner"],
				deploymentEnvs: ["production"],
				models: ["claude-sonnet-5"],
				agentNames: ["slack-agent"],
				toolNames: ["search_traces"],
				search: "wrun01",
				hasErrors: true,
				excludeTraceSessions: true,
				durationMinMs: 1000,
				durationMaxMs: 90000,
				costMin: 0.25,
				costMax: 4,
				tokensMin: 10,
				tokensMax: 5000,
				llmCallsMin: 1,
				llmCallsMax: 20,
				toolCallsMin: 2,
				toolCallsMax: 30,
				sortBy: "cost",
				sortDir: "asc",
			})
			expect(response.status).toBe(200)
			expect(response.body).toEqual({ data: [] })
			for (const fragment of [
				"countIf(VendorId IN ('eve')) > 0",
				"countIf(ServiceName IN ('agent-runner')) > 0",
				"countIf(DeploymentEnv IN ('production')) > 0",
				"countIf(Model IN ('claude-sonnet-5')) > 0",
				"countIf(AgentName IN ('slack-agent')) > 0",
				"countIf(ToolName IN ('search_traces')) > 0",
				"SessionId LIKE 'wrun01%'",
				"errorAgentSpans > 0",
				"NOT (sessionId LIKE 'trace:%')",
				"agentDurationMs >= 1000",
				"agentDurationMs <= 90000",
				"cost >= 0.25",
				"cost <= 4",
				"totalTokens >= 10",
				"totalTokens <= 5000",
				"llmCalls >= 1",
				"llmCalls <= 20",
				"toolCalls >= 2",
				"toolCalls <= 30",
				"ORDER BY cost ASC, agentStart DESC, sessionId ASC",
			]) {
				expect(sql).toContain(fragment)
			}
		} finally {
			await harness.dispose()
		}
	})

	it("rejects a negative bound and an unknown sort key at the boundary", async () => {
		const harness = makeHarness({
			compiledQuery: () => Effect.succeed([]),
		})

		try {
			expect(
				(await harness.post("/internal/ai-sessions/list", { ...WINDOW, costMin: -1 })).status,
			).toBe(400)
			expect(
				(await harness.post("/internal/ai-sessions/list", { ...WINDOW, sortBy: "spanCount" })).status,
			).toBe(400)
			expect(
				(await harness.post("/internal/ai-sessions/list", { ...WINDOW, tokensMin: 1.5 })).status,
			).toBe(400)
		} finally {
			await harness.dispose()
		}
	})
})
