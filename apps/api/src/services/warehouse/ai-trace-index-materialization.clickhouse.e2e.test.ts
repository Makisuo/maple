// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// Write-filter/read-guard sync for `ai_trace_index`.
//
// The rollups doc records the failure mode this exists for: a materialized
// view whose write filter and read fast-path agree with each other and
// disagree with reality sits at 0 rows forever, and every SQL-text test still
// passes (`span_metrics_calls_hourly` did exactly that). Agent Sessions
// detection reads `ai_trace_index` exclusively, so an MV that never fires
// renders the page permanently empty while looking healthy.
//
// So this suite proves rows, not text: it inserts vendor-stamped spans into
// `traces` on a database built by replaying the real migration chain, then
// asserts the MV materialized them — per column, because a `TO`-table view
// maps by NAME, so what the write filter admits and what each alias resolves
// to are facts only a real insert settles — and finally runs the real compiled
// list query end to end over the same data.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { compileUnionUnsafe, compileUnsafe } from "@maple-dev/clickhouse-builder"
import {
	MAPLE_AI_SESSION_ID_ATTR,
	MAPLE_AI_TRACE_SESSION_PREFIX,
	MAPLE_AI_VENDOR_ID_ATTR,
} from "@maple/domain/gen-ai"
import * as Integrations from "@maple/query-engine-integrations"
import type { AiSessionPageOpts } from "@maple/query-engine-integrations"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_ai_trace_index_e2e")
const ORG_ID = "org_ai_trace_index_e2e"

// Anchored to now, not a calendar date: `traces` and `ai_trace_index` both
// carry a 30-day TTL enforced at insert, and a hardcoded date would one day
// silently drop every seed and let the suite compare nothing to nothing.
const HOUR_MS = 3_600_000
// Floored to a whole second so the ONE seed that carries a fraction carries it
// on purpose — see `SESSIONLESS_SPAN`. `Date.now()` has millisecond precision,
// and letting it through would make every bound fractional and prove nothing.
const BASE_MS = Math.floor((Date.now() - 2 * HOUR_MS) / 1000) * 1000

// Milliseconds kept, not truncated to the second: `agentEnd` comes back off a
// DateTime64(9) column and the fan-out is bounded by that literal, so a seed at
// a fractional instant is the only thing that proves `Timestamp <= '{fanOutEnd}'`
// still admits the very row that produced it.
const chDateTime = (epochMs: number): string => new Date(epochMs).toISOString().replace("T", " ").slice(0, 23)

/** The same instant as `ai_trace_index` renders it: DateTime64(9), so the
 *  millisecond literal above padded out to nanoseconds. */
const chTimestamp = (epochMs: number): string => `${chDateTime(epochMs)}000000`

const quote = (value: string): string => `'${value.replaceAll("'", "\\'")}'`

const FOREIGN_ORG_ID = "org_ai_trace_index_e2e_other"

const SESSION_ID = `${ORG_ID}:inv-e2e-1`
const AGENT_TRACE = "aitraceindexe2e000000000000000001"
const SESSIONLESS_TRACE = "aitraceindexe2e000000000000000002"
const PLAIN_TRACE = "aitraceindexe2e000000000000000003"
/** A second trace of the SAME session — the reason the list groups traces. */
const AGENT_TRACE_2 = "aitraceindexe2e000000000000000005"
/** A third, hours past the caller's `endTime`: same session id, out of range. */
const AGENT_TRACE_3 = "aitraceindexe2e000000000000000006"

interface SeedSpan {
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId?: string
	readonly name?: string
	readonly ms: number
	readonly service: string
	readonly status: string
	readonly attrs: Readonly<Record<string, string>>
	readonly resource?: Readonly<Record<string, string>>
}

const PRODUCTION = { "deployment.environment.name": "production" }

// The turn-owning span of the eve session: the only one of its trace that
// carries the session key, which is why resolution is per-TRACE. It names the
// agent, and it ROLLS UP the usage of the chat call beneath it — the shape
// several frameworks emit, and the reason a naive sum reads 300 tokens where
// 150 were billed.
const AGENT_TURN_SPAN: SeedSpan = {
	traceId: AGENT_TRACE,
	spanId: "span-agent-1",
	name: "invoke_agent slack-agent",
	ms: BASE_MS,
	service: "agent-service",
	status: "Ok",
	attrs: {
		[MAPLE_AI_VENDOR_ID_ATTR]: "eve",
		[MAPLE_AI_SESSION_ID_ATTR]: SESSION_ID,
		"gen_ai.operation.name": "invoke_agent",
		"gen_ai.agent.name": "slack-agent",
		"gen_ai.usage.input_tokens": "100",
		"gen_ai.usage.output_tokens": "50",
		"gen_ai.usage.cost": "0.02",
	},
	resource: PRODUCTION,
}

// The model call under the turn span: the index row that carries the model,
// and the deepest reporter of the 150 tokens the turn span repeats. Served
// through OpenRouter, whose prompt figure already contains the cached tokens
// and whose completion figure contains the reasoning — so the 40 and the 10
// reported beside them are NOT added again, and the row still reads 150.
const AGENT_CHAT_SPAN: SeedSpan = {
	traceId: AGENT_TRACE,
	spanId: "span-chat-1",
	parentSpanId: "span-agent-1",
	name: "chat claude-sonnet-5",
	ms: BASE_MS + 1_000,
	service: "agent-service",
	status: "Ok",
	attrs: {
		[MAPLE_AI_VENDOR_ID_ATTR]: "eve",
		"gen_ai.operation.name": "chat",
		"gen_ai.provider.name": "openrouter",
		"gen_ai.request.model": "claude-sonnet-5",
		"gen_ai.response.model": "claude-sonnet-5-20260101",
		"gen_ai.response.id": "gen-e2e-1",
		"gen_ai.usage.input_tokens": "100",
		"gen_ai.usage.cache_read.input_tokens": "40",
		"gen_ai.usage.output_tokens": "50",
		"gen_ai.usage.reasoning.output_tokens": "10",
		"gen_ai.usage.cost": "0.02",
	},
	resource: PRODUCTION,
}

// The gateway's own trace of that same call, forwarded into the session
// (OpenRouter Broadcast): a separate trace, the same response id, the usage
// repeated, and a higher price than the app's SDK saw. One call, not two —
// and the session takes the larger claim for its cost.
const MIRROR_TRACE = "aitraceindexe2e000000000000000007"
const MIRROR_CALL_SPAN: SeedSpan = {
	traceId: MIRROR_TRACE,
	spanId: "span-mirror-1",
	name: "LLM Generation",
	ms: BASE_MS + 1_100,
	service: "openrouter",
	status: "Ok",
	attrs: {
		[MAPLE_AI_VENDOR_ID_ATTR]: "openrouter",
		[MAPLE_AI_SESSION_ID_ATTR]: SESSION_ID,
		"gen_ai.operation.name": "chat",
		"gen_ai.provider.name": "openrouter",
		"gen_ai.request.model": "claude-sonnet-5",
		"gen_ai.response.model": "claude-sonnet-5-20260101",
		"gen_ai.response.id": "gen-e2e-1",
		"gen_ai.usage.input_tokens": "100",
		"gen_ai.usage.input_tokens.cached": "40",
		"gen_ai.usage.output_tokens": "50",
		"gen_ai.usage.total_cost": "0.03",
	},
}

// The gateway's provider attempt under its call: a model span that reports no
// usage while its parent does — the same call seen again, never a call of its
// own.
const MIRROR_ATTEMPT_SPAN: SeedSpan = {
	traceId: MIRROR_TRACE,
	spanId: "span-mirror-2",
	parentSpanId: "span-mirror-1",
	name: "provider attempt 1: Anthropic",
	ms: BASE_MS + 1_150,
	service: "openrouter",
	status: "Ok",
	attrs: {
		[MAPLE_AI_VENDOR_ID_ATTR]: "openrouter",
		"gen_ai.operation.name": "chat",
		"gen_ai.response.id": "gen-e2e-1:attempt-0",
	},
}

// A tool call under the turn span that failed by status: the index row that
// carries the tool, and the session's one failed agent span.
const AGENT_TOOL_SPAN: SeedSpan = {
	traceId: AGENT_TRACE,
	spanId: "span-tool-1",
	parentSpanId: "span-agent-1",
	name: "execute_tool search_traces",
	ms: BASE_MS + 2_000,
	service: "agent-service",
	status: "Error",
	attrs: {
		[MAPLE_AI_VENDOR_ID_ATTR]: "eve",
		"gen_ai.operation.name": "execute_tool",
		"gen_ai.tool.name": "search_traces",
	},
	resource: PRODUCTION,
}

// A second agent span on the SAME trace, stamped by the SDK the agent calls
// through and carrying no session id — an index row whose `SessionId` is ''.
// `max(SessionId)` per trace is what keeps the trace under the eve session, and
// the vendor `argMin` is what keeps the row's vendor `eve` rather than the
// alphabetically-later `vercel_ai_sdk`.
const AGENT_SDK_SPAN: SeedSpan = {
	traceId: AGENT_TRACE,
	spanId: "span-agent-1b",
	ms: BASE_MS + 5_000,
	service: "agent-service",
	status: "Ok",
	attrs: { [MAPLE_AI_VENDOR_ID_ATTR]: "vercel_ai_sdk" },
}

// A plain child of the agent trace, BEFORE its first agent span: no `maple_ai.*`
// at all, so it is in `trace_detail_spans` and NOT in the index. It is what the
// fan-out's pad exists for, and what makes `spanCount` bigger than the number of
// agent spans — the full agent context the page promises.
const AGENT_CHILD_SPAN: SeedSpan = {
	traceId: AGENT_TRACE,
	spanId: "span-agent-1c",
	ms: BASE_MS - 50,
	service: "web-service",
	status: "Ok",
	attrs: { "http.request.method": "GET" },
}

// A second TRACE of the same session — the join that makes `traceCount` 2.
const AGENT_TURN_2_SPAN: SeedSpan = {
	traceId: AGENT_TRACE_2,
	spanId: "span-agent-3",
	ms: BASE_MS + 30_000,
	service: "agent-service",
	status: "Ok",
	attrs: {
		[MAPLE_AI_VENDOR_ID_ATTR]: "eve",
		[MAPLE_AI_SESSION_ID_ATTR]: SESSION_ID,
	},
}

// The sessionless agent trace, at a FRACTIONAL instant: it is the page's latest
// agent span, so its timestamp is `fanOutEnd`, and stage two's
// `Timestamp <= '{fanOutEnd}'` has to admit the row it was measured from. A
// millisecond dropped anywhere in that round trip erases this session.
//
// Vercel AI SDK dialect with no operation name: classified by the span-name
// rules, identified by `ai.model.id`, measured by `ai.usage.*`, and in the
// environment under the DEPRECATED semconv spelling.
const SESSIONLESS_SPAN: SeedSpan = {
	traceId: SESSIONLESS_TRACE,
	spanId: "span-agent-2",
	name: "ai.generateText.doGenerate",
	ms: BASE_MS + 60_123,
	service: "agent-service",
	status: "Error",
	attrs: {
		[MAPLE_AI_VENDOR_ID_ATTR]: "vercel_ai_sdk",
		"ai.model.id": "gpt-5",
		"ai.usage.promptTokens": "10",
		// The SDK re-sums the prompt, so the 4 cached are inside the 10.
		"ai.usage.cachedInputTokens": "4",
		"ai.usage.completionTokens": "5",
	},
	resource: { "deployment.environment": "staging" },
}

// No `maple_ai.*`: must NOT materialize, and must not be detected as a session.
const PLAIN_SPAN: SeedSpan = {
	traceId: PLAIN_TRACE,
	spanId: "span-plain-1",
	ms: BASE_MS + 120_000,
	service: "web-service",
	status: "Ok",
	attrs: { "http.request.method": "GET" },
}

// The same session id, hours before the caller's `startTime`. The page cannot rank
// it, so its trace must not reach the aggregation either — stage two's index
// levels are bounded by the PAGE, and a trace merged in there would inflate a
// count for a window the user did not ask about.
const EARLY_TURN_SPAN: SeedSpan = {
	traceId: AGENT_TRACE_3,
	spanId: "span-agent-4",
	ms: BASE_MS - 3 * HOUR_MS,
	service: "agent-service",
	status: "Ok",
	attrs: {
		[MAPLE_AI_VENDOR_ID_ATTR]: "eve",
		[MAPLE_AI_SESSION_ID_ATTR]: SESSION_ID,
	},
}

const SEED_SPANS: ReadonlyArray<SeedSpan> = [
	AGENT_TURN_SPAN,
	AGENT_CHAT_SPAN,
	MIRROR_CALL_SPAN,
	MIRROR_ATTEMPT_SPAN,
	AGENT_TOOL_SPAN,
	AGENT_SDK_SPAN,
	AGENT_CHILD_SPAN,
	AGENT_TURN_2_SPAN,
	SESSIONLESS_SPAN,
	PLAIN_SPAN,
	EARLY_TURN_SPAN,
]

// A vendor span under ANOTHER org: it must materialize under its own OrgId —
// the one by-name mapping mistake with cross-tenant consequences — and the
// org-scoped list query below must never surface it.
const FOREIGN_SPAN: SeedSpan = {
	traceId: "aitraceindexe2e000000000000000004",
	spanId: "span-foreign-1",
	ms: BASE_MS + 180_000,
	service: "agent-service",
	status: "Ok",
	attrs: { [MAPLE_AI_VENDOR_ID_ATTR]: "eve" },
}

const chMap = (attrs: Readonly<Record<string, string>>): string =>
	`map(${Object.entries(attrs)
		.flatMap(([key, value]) => [quote(key), quote(value)])
		.join(", ")})`

const seed = async (): Promise<void> => {
	const rows = [
		...SEED_SPANS.map((span) => [ORG_ID, span] as const),
		[FOREIGN_ORG_ID, FOREIGN_SPAN] as const,
	]
		.map(
			([orgId, span]) =>
				`(${quote(orgId)}, ${quote(chDateTime(span.ms))}, ${quote(span.traceId)}, ${quote(span.spanId)}, ${quote(span.parentSpanId ?? "")}, ${quote(span.name ?? "agent turn")}, 'Internal', ${quote(span.service)}, 1000000, ${quote(span.status)}, 1, ${chMap(span.attrs)}, ${chMap(span.resource ?? {})})`,
		)
		.join("\n,")

	await clickhouseExec(
		`INSERT INTO traces
		 (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, SampleRate, SpanAttributes, ResourceAttributes)
		 VALUES\n${rows}`,
		database,
	)
}

const runJson = async (sql: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
	const body = await clickhouseExec(normalizeSqlForClickHouseClient(sql), database, {
		default_format: "JSON",
		output_format_json_quote_64bit_integers: "0",
	})
	const parsed = JSON.parse(body) as { readonly data?: ReadonlyArray<Record<string, unknown>> }
	return parsed.data ?? []
}

describe.skipIf(!clickhouseE2eEnabled)("ai_trace_index materialization", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await seed()
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it("materializes exactly the vendor-stamped spans, column by column", async () => {
		const rows = await runJson(
			`SELECT OrgId, toString(Timestamp) AS Timestamp, TraceId, SessionId, VendorId, ServiceName,
			        DeploymentEnv, Model, AgentName, ToolName, SpanId, ParentSpanId, Duration,
			        IsError, IsLlmCall, IsToolCall, Tokens, Cost, ResponseId
			 FROM ai_trace_index ORDER BY Timestamp ASC`,
		)

		/** The index row a seed span is expected to produce, by name — the
		 *  identity as stamped, and every 0025 column as the seed implies it. */
		const indexRow = (
			orgId: string,
			span: SeedSpan,
			expect: Partial<{
				DeploymentEnv: string
				Model: string
				AgentName: string
				ToolName: string
				IsError: number
				IsLlmCall: number
				IsToolCall: number
				Tokens: number
				Cost: number
				ResponseId: string
			}> = {},
		) => ({
			OrgId: orgId,
			Timestamp: chTimestamp(span.ms),
			TraceId: span.traceId,
			SessionId: span.attrs[MAPLE_AI_SESSION_ID_ATTR] ?? "",
			VendorId: span.attrs[MAPLE_AI_VENDOR_ID_ATTR] ?? "",
			ServiceName: span.service,
			DeploymentEnv: "",
			Model: "",
			AgentName: "",
			ToolName: "",
			SpanId: span.spanId,
			ParentSpanId: span.parentSpanId ?? "",
			Duration: 1_000_000,
			IsError: span.status === "Error" ? 1 : 0,
			IsLlmCall: 0,
			IsToolCall: 0,
			Tokens: 0,
			Cost: 0,
			ResponseId: "",
			...expect,
		})

		// Every vendor-stamped span and nothing else: `AGENT_CHILD_SPAN` and
		// `PLAIN_SPAN` carry no `maple_ai.*` and must be absent, and the two rows
		// whose `SessionId` is '' are the reason the read side resolves a session
		// per TRACE rather than per span.
		assert.deepStrictEqual(rows, [
			indexRow(ORG_ID, EARLY_TURN_SPAN),
			indexRow(ORG_ID, AGENT_TURN_SPAN, {
				DeploymentEnv: "production",
				AgentName: "slack-agent",
				Tokens: 150,
				Cost: 0.02,
			}),
			// Response model over request model; the one model call.
			indexRow(ORG_ID, AGENT_CHAT_SPAN, {
				DeploymentEnv: "production",
				Model: "claude-sonnet-5-20260101",
				IsLlmCall: 1,
				Tokens: 150,
				Cost: 0.02,
				ResponseId: "gen-e2e-1",
			}),
			// The gateway's observation of the same call: its own row, keyed by
			// the same response id, priced under its own cost key.
			indexRow(ORG_ID, MIRROR_CALL_SPAN, {
				Model: "claude-sonnet-5-20260101",
				IsLlmCall: 1,
				Tokens: 150,
				Cost: 0.03,
				ResponseId: "gen-e2e-1",
			}),
			indexRow(ORG_ID, MIRROR_ATTEMPT_SPAN, {
				IsLlmCall: 1,
				ResponseId: "gen-e2e-1:attempt-0",
			}),
			indexRow(ORG_ID, AGENT_TOOL_SPAN, {
				DeploymentEnv: "production",
				ToolName: "search_traces",
				IsToolCall: 1,
				IsError: 1,
			}),
			// "agent turn" by name, no model, no usage: an agent span, not a call.
			indexRow(ORG_ID, AGENT_SDK_SPAN),
			indexRow(ORG_ID, AGENT_TURN_2_SPAN),
			// The Vercel AI SDK dialect resolves to the same columns, the deprecated
			// environment spelling still resolves, and the name rules classify a
			// span with no operation name as the model call it is.
			indexRow(ORG_ID, SESSIONLESS_SPAN, {
				DeploymentEnv: "staging",
				Model: "gpt-5",
				IsLlmCall: 1,
				Tokens: 15,
			}),
			indexRow(FOREIGN_ORG_ID, FOREIGN_SPAN),
		])
	})

	// Both stages, wired the way the route wires them: the page is ranked on the
	// index over the caller's window, and its own agent-span bounds are what the
	// fan-out is then run over. Running the second with the first's real output
	// is the only thing that proves the bounds it reports are a window
	// ClickHouse accepts back as a param — the compiled SQL cannot say that.
	it("feeds the real compiled page and list queries end to end", async () => {
		const window = {
			orgId: ORG_ID,
			startTime: chDateTime(BASE_MS - HOUR_MS),
			endTime: chDateTime(BASE_MS + HOUR_MS),
		}
		const compiledPage = compileUnsafe(Integrations.aiSessionPageQuery(), window)
		// Decoded through the query's own row schema, exactly as `compiledQuery`
		// does in production — the raw JSON alone would not catch a wire shape
		// the schema refuses.
		const page = Effect.runSync(compiledPage.decodeRows(await runJson(compiledPage.sql)))

		// Newest session first: the sessionless agent trace files under its own
		// `trace:` key, the session-bearing one under the vendor's id, and the
		// plain trace and the foreign org's trace must not appear at all.
		assert.deepStrictEqual(
			page.map((row) => row.sessionId),
			[`${MAPLE_AI_TRACE_SESSION_PREFIX}${SESSIONLESS_TRACE}`, SESSION_ID],
		)

		// The eve session's bounds span BOTH its traces: it starts on the first
		// trace's turn span and ends on the second trace's, which is what makes the
		// fan-out window a property of the session rather than of one trace.
		// `agentEnd` is the SECOND trace's turn span, not the first trace's — and
		// not `EARLY_TURN_SPAN`, which carries the same session id three hours out
		// and which the page never saw, so it did not stretch the bounds.
		const eve = page.find((row) => row.sessionId === SESSION_ID)
		assert.deepStrictEqual(
			[eve?.agentStart, eve?.agentEnd],
			[chTimestamp(BASE_MS), chTimestamp(BASE_MS + 30_000)],
		)

		// The route's own derivation, character for character — string bounds that
		// sort as the instants do.
		const fanOutStart = page.map((row) => row.agentStart).reduce((a, b) => (a < b ? a : b))
		const fanOutEnd = page.map((row) => row.agentEnd).reduce((a, b) => (a < b ? b : a))
		// The upper bound lands on a fractional instant, and stage two compares
		// `Timestamp <= '{fanOutEnd}'` against the DateTime64(9) column it came
		// from. Truncate the literal anywhere and the row that SET the bound falls
		// outside it — the sessionless session below is the canary.
		assert.strictEqual(fanOutStart, chTimestamp(BASE_MS))
		assert.strictEqual(fanOutEnd, chTimestamp(BASE_MS + 60_123))
		assert.ok(fanOutEnd.endsWith(".123000000"))
		// `orgId` and the page's two bounds — stage two takes no window param from
		// the caller, so there is nothing else to pass.
		const compiled = compileUnsafe(
			Integrations.aiSessionListQuery({ sessionIds: page.map((row) => row.sessionId) }),
			{ orgId: ORG_ID, fanOutStart, fanOutEnd },
		)
		const rows = Effect.runSync(compiled.decodeRows(await runJson(compiled.sql)))

		// Reordered into the page's order and dropped where the aggregation has no
		// row, as the handler does — same two sessions, now with the facts the
		// index cannot answer.
		const byId = new Map(rows.map((row) => [row.sessionId, row]))
		assert.deepStrictEqual(
			page
				.flatMap((row) => byId.get(row.sessionId) ?? [])
				.map((row) => [row.sessionId, row.vendorId, row.traceCount, row.spanCount]),
			[
				// Survived the `<= fanOutEnd` boundary it defined.
				[`${MAPLE_AI_TRACE_SESSION_PREFIX}${SESSIONLESS_TRACE}`, "vercel_ai_sdk", 1, 1],
				// Three traces merged, eight spans: the turn span, its chat and tool
				// children, the SDK span that carries no session id, the plain child
				// that is not in the index at all, the second trace's turn span, and
				// the gateway's mirror trace with its attempt. `eve` and not the
				// alphabetically-later `openrouter`/`vercel_ai_sdk`, because the
				// vendor is the earliest SESSION-BEARING span's. `EARLY_TURN_SPAN` is
				// not among them.
				[SESSION_ID, "eve", 3, 8],
			],
		)
	})

	const WINDOW = {
		orgId: ORG_ID,
		startTime: chDateTime(BASE_MS - HOUR_MS),
		endTime: chDateTime(BASE_MS + HOUR_MS),
	}
	const TRACE_SESSION_ID = `${MAPLE_AI_TRACE_SESSION_PREFIX}${SESSIONLESS_TRACE}`

	/** The real compiled page query, decoded through its own row schema. */
	const rankPage = async (opts: AiSessionPageOpts = {}) => {
		const compiled = compileUnsafe(Integrations.aiSessionPageQuery(opts), WINDOW)
		return Effect.runSync(compiled.decodeRows(await runJson(compiled.sql)))
	}

	it("measures each session off the index the way the detail page does", async () => {
		const [sessionless, session] = await rankPage()

		// Name-classified inference: no operation name, but a model and no
		// tool/agent words in the span name.
		assert.deepStrictEqual(
			[sessionless!.models, sessionless!.agentNames, sessionless!.llmCalls, sessionless!.toolCalls],
			[["gpt-5"], [], 1, 0],
		)
		assert.strictEqual(sessionless!.totalTokens, 15)
		assert.strictEqual(sessionless!.cost, 0)
		assert.strictEqual(sessionless!.errorAgentSpans, 1)
		// One span of 1ms: the extent is its own duration.
		assert.strictEqual(sessionless!.agentDurationMs, 1)

		// The roll-up: the turn span reported the chat call's 150 tokens and
		// $0.02 again; the deepest reporter is counted once. The gateway's mirror
		// trace observed the same call under the same response id, so it is the
		// same call — one, not two, its 150 tokens once, and its $0.03 as the
		// larger claim over the app's $0.02; its provider attempt, a model span
		// under a reporting parent, is not a call. The lambdas are raw SQL the
		// builder cannot type-check, so this is where they are proven.
		assert.deepStrictEqual(
			[session!.models, session!.agentNames, session!.llmCalls, session!.toolCalls],
			[["claude-sonnet-5-20260101"], ["slack-agent"], 1, 1],
		)
		assert.strictEqual(session!.totalTokens, 150)
		assert.strictEqual(session!.cost, 0.03)
		assert.strictEqual(session!.errorAgentSpans, 1)
		// From the first turn span to the end of the second trace's turn span.
		assert.strictEqual(session!.agentDurationMs, 30_001)
	})

	it("applies each counted filter per trace, and each session filter on the ranked row", async () => {
		const ids = async (opts: AiSessionPageOpts) => (await rankPage(opts)).map((row) => row.sessionId)

		assert.deepStrictEqual(await ids({ models: ["gpt-5"] }), [TRACE_SESSION_ID])
		assert.deepStrictEqual(await ids({ toolNames: ["search_traces"] }), [SESSION_ID])
		assert.deepStrictEqual(await ids({ agentNames: ["slack-agent"] }), [SESSION_ID])
		assert.deepStrictEqual(await ids({ deploymentEnvs: ["production"] }), [SESSION_ID])
		assert.deepStrictEqual(await ids({ deploymentEnvs: ["staging"] }), [TRACE_SESSION_ID])
		// Dimensions that live on DIFFERENT spans of one trace combine: the model
		// is on the chat span, the tool on the tool span, the session id on the
		// turn span. A row-level AND would return nothing for any of these.
		assert.deepStrictEqual(
			await ids({
				models: ["claude-sonnet-5-20260101"],
				toolNames: ["search_traces"],
				agentNames: ["slack-agent"],
			}),
			[SESSION_ID],
		)
		assert.deepStrictEqual(await ids({ search: SESSION_ID, toolNames: ["search_traces"] }), [SESSION_ID])
		assert.deepStrictEqual(await ids({ models: ["gpt-5"], toolNames: ["search_traces"] }), [])
		// A pasted trace id, with the prefix and ellipsis the list row shows. The
		// seeds share all but their last character, so a prefix that stops short
		// of it matches every trace — which is the prefix rule working.
		assert.deepStrictEqual(await ids({ search: `trace:${SESSIONLESS_TRACE}…` }), [TRACE_SESSION_ID])
		assert.deepStrictEqual(await ids({ search: SESSIONLESS_TRACE.slice(0, 30) }), [
			TRACE_SESSION_ID,
			SESSION_ID,
		])
		assert.deepStrictEqual(await ids({ excludeTraceSessions: true }), [SESSION_ID])
		assert.deepStrictEqual(await ids({ hasErrors: true }), [TRACE_SESSION_ID, SESSION_ID])
		assert.deepStrictEqual(await ids({ tokensMin: 100 }), [SESSION_ID])
		assert.deepStrictEqual(await ids({ tokensMax: 100 }), [TRACE_SESSION_ID])
		assert.deepStrictEqual(await ids({ costMin: 0.01 }), [SESSION_ID])
		assert.deepStrictEqual(await ids({ toolCallsMin: 1 }), [SESSION_ID])
		assert.deepStrictEqual(await ids({ llmCallsMin: 1 }), [TRACE_SESSION_ID, SESSION_ID])
		assert.deepStrictEqual(await ids({ durationMinMs: 10_000 }), [SESSION_ID])
		assert.deepStrictEqual(await ids({ sortBy: "totalTokens", sortDir: "asc" }), [
			TRACE_SESSION_ID,
			SESSION_ID,
		])
		assert.deepStrictEqual(await ids({ sortBy: "cost", sortDir: "desc" }), [SESSION_ID, TRACE_SESSION_ID])
		assert.deepStrictEqual(await ids({ sortBy: "startTime", sortDir: "asc" }), [
			SESSION_ID,
			TRACE_SESSION_ID,
		])
	})

	it("counts the facets the filters select", async () => {
		const compiled = compileUnionUnsafe(Integrations.aiSessionFacetsQuery(), WINDOW)
		const rows = Effect.runSync(compiled.decodeRows(await runJson(compiled.sql)))
		const facet = (facetType: string) =>
			rows
				.filter((row) => row.facetType === facetType)
				.map((row) => [row.name, row.count])
				.sort()

		assert.deepStrictEqual(facet("environment"), [
			["production", 1],
			["staging", 1],
		])
		assert.deepStrictEqual(facet("model"), [
			["claude-sonnet-5-20260101", 1],
			["gpt-5", 1],
		])
		assert.deepStrictEqual(facet("agent"), [["slack-agent", 1]])
		assert.deepStrictEqual(facet("tool"), [["search_traces", 1]])
	})
})
