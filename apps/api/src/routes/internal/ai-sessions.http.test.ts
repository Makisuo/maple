// SAFETY-FILE: JSON in this test is emitted by the route under test before its fields are asserted.
import { describe, expect, it } from "@effect/vitest"
import {
	AiSessionsInternalApiGroup,
	AI_SESSION_SPANS_MAX_SPANS,
	AI_SESSION_SUMMARY_MAX_TURNS,
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

	it("cuts the page at the row cap and hands back where the next one starts", async () => {
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
			expect(response.body.data).toHaveLength(AI_SESSION_SPANS_MAX_SPANS)
			// The last row RETURNED, not the extra one: the next page starts after it.
			const last = spanRow(AI_SESSION_SPANS_MAX_SPANS - 1)
			expect(response.body.nextCursor).toEqual({ timestamp: last.timestamp, spanId: last.spanId })
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
			expect(response.body.nextCursor).toBeUndefined()
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
			// The projection names the key; the predicate is what must be absent.
			expect(spansSql).not.toContain("SpanAttributes['maple_ai.session.id']")
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
			expect(response.body).toEqual({ data: [] })
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
			expect(response.body).toEqual({ data: [] })
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

describe("POST /internal/ai-sessions/facets", () => {
	// `pick("vendor")` in the handler and `facet("vendor", …)` in the query are
	// two independent string literals in two packages. If either drifts both
	// arrays come back empty behind a 200 and the sidebar silently loses every
	// option — a failure that looks exactly like "no data in this window".
	it("splits one union result into the two dimensions the sidebar reads", async () => {
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled) =>
				compiledQueryOf(compiled)
					.decodeRows([
						{ facetType: "vendor", name: "eve", count: 7 },
						{ facetType: "service", name: "agent-runner", count: 4 },
						{ facetType: "vendor", name: "vercel_ai_sdk", count: 2 },
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
		} finally {
			await harness.dispose()
		}
	})
})

describe("POST /internal/ai-sessions/spans — pages and scopes", () => {
	const captureSpansSql = () => {
		let sql: string | undefined
		const harness = makeHarness({
			compiledQueryBounded: (_tenant, compiled) => {
				sql = compiledQueryOf(compiled).sql
				return compiledQueryOf(compiled)
					.decodeRows([spanRow(0)])
					.pipe(Effect.orDie)
			},
		})
		return { harness, sql: () => sql }
	}

	it("resumes after the cursor, on the agent spans alone", async () => {
		const { harness, sql } = captureSpansSql()
		try {
			const after = { timestamp: "2026-08-19 10:00:00.000000000", spanId: "00000000000007cf" }
			const response = await harness.post("/internal/ai-sessions/spans", {
				...SPANS_BODY,
				scope: "ai",
				after,
				limit: 500,
			})
			expect(response.status).toBe(200)
			expect(sql()).toContain("SpanAttributes['maple_ai.vendor.id'] != ''")
			expect(sql()).toContain(
				`(Timestamp > '${after.timestamp}' OR (Timestamp = '${after.timestamp}' AND SpanId > '${after.spanId}'))`,
			)
			expect(sql()).toContain("LIMIT 501")
		} finally {
			await harness.dispose()
		}
	})

	it("reads a turn's app spans by its traces, skipping session detection", async () => {
		const { harness, sql } = captureSpansSql()
		try {
			const other = "0123456789abcdef0123456789abcdef"
			const response = await harness.post("/internal/ai-sessions/spans", {
				...SPANS_BODY,
				scope: "app",
				traceIds: [TRACE_ID, other],
			})
			expect(response.status).toBe(200)
			expect(sql()).toContain(`TraceId IN ('${TRACE_ID}', '${other}')`)
			expect(sql()).toContain("SpanAttributes['maple_ai.vendor.id'] = ''")
			expect(sql()).not.toContain("FROM traces")
		} finally {
			await harness.dispose()
		}
	})

	it("refuses a trace-pinned read with no window to bound it", async () => {
		const { harness } = captureSpansSql()
		try {
			const response = await harness.post("/internal/ai-sessions/spans", {
				sessionId: SESSION_ID,
				traceIds: [TRACE_ID],
			})
			expect(response.status).toBe(400)
		} finally {
			await harness.dispose()
		}
	})

	it("refuses a trace id that is not one", async () => {
		const { harness } = captureSpansSql()
		try {
			const response = await harness.post("/internal/ai-sessions/spans", {
				...SPANS_BODY,
				traceIds: ["not-a-trace-id' OR 1=1"],
			})
			expect(response.status).toBe(400)
		} finally {
			await harness.dispose()
		}
	})
})

describe("POST /internal/ai-sessions/summary", () => {
	/** One turn row, in the wire shape `aiSessionSummaryRowSchema` decodes. */
	const turnRow = (overrides: Record<string, unknown>) => ({
		turnKey: "turn_0",
		conversationId: "turn_0",
		traceIds: [TRACE_ID],
		startTime: "2026-08-19 10:00:00.000000000",
		endTime: "2026-08-19 10:00:10.000000000",
		durationMs: "10000",
		spanCount: "40",
		aiSpanCount: "6",
		llmCalls: "3",
		toolCalls: "2",
		errorSpanCount: "0",
		inputTokens: "0",
		outputTokens: "0",
		cacheReadTokens: "0",
		llmInputTokens: "0",
		llmOutputTokens: "0",
		llmCacheReadTokens: "0",
		costReporters: "0",
		cost: "0",
		llmCost: "0",
		models: ["gpt-5"],
		agentNames: ["slack-agent"],
		...overrides,
	})

	/** The session's own row, in the wire shape `aiSessionTotalsRowSchema` decodes. */
	const totalsRow = (overrides: Record<string, unknown>) => {
		const { turnKey: _turnKey, conversationId: _conversationId, traceIds: _traceIds, ...measures } = turnRow({})
		return { traceCount: "1", ...measures, ...overrides }
	}

	/** Two reads: the turn rows under `GROUP BY`, the session's row without. */
	const summaryHarness = (
		rows: ReadonlyArray<Record<string, unknown>>,
		totals: ReadonlyArray<Record<string, unknown>>,
	) => {
		const sqls: string[] = []
		const harness = makeHarness({
			compiledQuery: (_tenant, compiled) => {
				const sql = compiledQueryOf(compiled).sql
				sqls.push(sql)
				return compiledQueryOf(compiled)
					.decodeRows(sql.includes("GROUP BY turnKey") ? rows : totals)
					.pipe(Effect.orDie)
			},
		})
		return { harness, sqls }
	}

	it("reports the session's own row as the totals, and the turn rows beside it", async () => {
		const { harness, sqls } = summaryHarness(
			[
				turnRow({ inputTokens: "300", llmInputTokens: "150", outputTokens: "60", llmOutputTokens: "30" }),
				turnRow({
					turnKey: "turn_1",
					conversationId: "turn_1",
					traceIds: [TRACE_ID, "0123456789abcdef0123456789abcdef"],
					startTime: "2026-08-19 10:00:20.000000000",
					endTime: "2026-08-19 10:00:35.500000000",
					errorSpanCount: "1",
					inputTokens: "100",
					llmInputTokens: "100",
					models: ["gpt-5", "claude-opus-5"],
					agentNames: [],
				}),
			],
			[
				// Usage reported per model call AND rolled up onto the agent span:
				// the per-call figures are the total, the roll-up is not added on top.
				totalsRow({
					traceCount: "2",
					spanCount: "80",
					aiSpanCount: "12",
					llmCalls: "6",
					toolCalls: "4",
					errorSpanCount: "1",
					endTime: "2026-08-19 10:00:35.500000000",
					durationMs: "35500",
					inputTokens: "400",
					llmInputTokens: "250",
					outputTokens: "60",
					llmOutputTokens: "30",
					costReporters: "4",
					cost: "0.02",
					llmCost: "0.01",
					models: ["gpt-5", "claude-opus-5"],
				}),
			],
		)
		try {
			const response = await harness.post("/internal/ai-sessions/summary", SPANS_BODY)
			expect(response.status).toBe(200)
			expect(response.body).toMatchObject({
				spanCount: 80,
				aiSpanCount: 12,
				traceCount: 2,
				startTime: "2026-08-19 10:00:00.000000000",
				endTime: "2026-08-19 10:00:35.500000000",
				durationMs: 35_500,
				llmCalls: 6,
				toolCalls: 4,
				errorSpanCount: 1,
				tokens: { input: 250, output: 30, cacheRead: 0 },
				tokenReporting: "per-call",
				cost: 0.01,
				models: ["gpt-5", "claude-opus-5"],
				agentNames: ["slack-agent"],
				turnsTruncated: false,
			})
			const turns = response.body.turns as Array<Record<string, unknown>>
			expect(turns).toHaveLength(2)
			expect(turns[1]).toMatchObject({ turnKey: "turn_1", tokens: { input: 100, output: 0, cacheRead: 0 } })
			expect(turns[1]).not.toHaveProperty("cost")
			expect(sqls).toHaveLength(2)
			for (const sql of sqls) expect(sql).toContain(`SpanAttributes['maple_ai.session.id'] = '${SESSION_ID}'`)
		} finally {
			await harness.dispose()
		}
	})

	// The rule is applied to the session's row, never to the turn rows summed:
	// a turn span's roll-up and its model calls can land in different rows.
	it("does not double usage split across a turn row and its trace's row", async () => {
		const { harness } = summaryHarness(
			[
				turnRow({ inputTokens: "300", llmCalls: "0" }),
				turnRow({ turnKey: TRACE_ID, conversationId: "", inputTokens: "300", llmInputTokens: "300" }),
			],
			[totalsRow({ inputTokens: "600", llmInputTokens: "300" })],
		)
		try {
			const response = await harness.post("/internal/ai-sessions/summary", SPANS_BODY)
			expect(response.body).toMatchObject({ tokens: { input: 300, output: 0, cacheRead: 0 }, tokenReporting: "per-call" })
		} finally {
			await harness.dispose()
		}
	})

	it("counts a roll-up when no model call reported usage", async () => {
		const { harness } = summaryHarness(
			[turnRow({ inputTokens: "300", outputTokens: "60" })],
			[totalsRow({ inputTokens: "300", outputTokens: "60" })],
		)
		try {
			const response = await harness.post("/internal/ai-sessions/summary", SPANS_BODY)
			expect(response.body).toMatchObject({
				tokens: { input: 300, output: 60, cacheRead: 0 },
				tokenReporting: "roll-up",
			})
			expect(response.body).not.toHaveProperty("cost")
		} finally {
			await harness.dispose()
		}
	})

	it("keeps exact totals when the turn list is cut", async () => {
		const rows = Array.from({ length: AI_SESSION_SUMMARY_MAX_TURNS + 1 }, (_, index) =>
			turnRow({ turnKey: `turn_${index}`, conversationId: `turn_${index}`, spanCount: "1" }),
		)
		const { harness } = summaryHarness(rows, [totalsRow({ spanCount: String(AI_SESSION_SUMMARY_MAX_TURNS + 1) })])
		try {
			const response = await harness.post("/internal/ai-sessions/summary", SPANS_BODY)
			expect(response.body).toMatchObject({ spanCount: AI_SESSION_SUMMARY_MAX_TURNS + 1, turnsTruncated: true })
			expect(response.body.turns).toHaveLength(AI_SESSION_SUMMARY_MAX_TURNS)
		} finally {
			await harness.dispose()
		}
	})

	it("answers an unknown session with empty totals and no bounds", async () => {
		// An aggregate over no rows is still one row, with a zero count.
		const { harness } = summaryHarness([], [totalsRow({ spanCount: "0", traceCount: "0" })])
		try {
			const response = await harness.post("/internal/ai-sessions/summary", SPANS_BODY)
			expect(response.status).toBe(200)
			expect(response.body).toMatchObject({ spanCount: 0, turns: [], tokenReporting: "none" })
			expect(response.body).not.toHaveProperty("startTime")
		} finally {
			await harness.dispose()
		}
	})
})
