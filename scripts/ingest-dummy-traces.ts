#!/usr/bin/env bun
/**
 * Push dummy OTLP traces + logs to the local ingest gateway for UI development.
 *
 *   bun scripts/ingest-dummy.ts [options]
 *   bun run ingest:dummy -- [options]
 *
 * This is a dev-only convenience: it hand-rolls OTLP/JSON and POSTs it straight at
 * the Rust ingest gateway (https://ingest.localhost → http://localhost:3474), the
 * same path real telemetry takes. The gateway stamps every span/log with your org
 * (MAPLE_ORG_ID_OVERRIDE in single-tenant mode), so the data shows up for the
 * test user at https://web.localhost. No metrics / dashboards — traces + logs only.
 *
 * The headline use case is the commit-SHA UI: each generated trace carries a
 * `deployment.commit_sha` *resource* attribute, which the `service_overview_spans`
 * materialized view extracts into the `CommitSha` column (per service, per deploy).
 * Pass real 40-char SHAs (`--shas`) — or let it pull recent ones from `git log` —
 * so the hover card can resolve them to actual commit messages via the GitHub app.
 *
 * The second use case is the **agent traces** UI: a fixed set of synthetic
 * GenAI agent traces (`gen_ai.*` spans on `service.name=agent-service`) covering every
 * state the agent trace view has to render — cumulative multi-turn message arrays,
 * parallel tool calls with one failure, fully redacted content, a mid-conversation
 * model switch, agent/workflow handoffs, legacy attribute names, and a still-running
 * agent trace. `--agent traces <n>` emits the whole set n times (default 1, `--no-agent traces`
 * to skip); the run prints each fixture's agent trace id so you can open it by URL.
 *
 * Examples:
 *   # The "improve the commit-SHAs UI" scenario: 3 SHAs 10 min apart, each with a
 *   # varying number of traces, anchored at now.
 *   bun scripts/ingest-dummy.ts \
 *     --shas ea0466fa99642d7633860b2079debf30562a58a0,a24daf481e65f0c333073b5bf8a39583a972910d,d9f88a8518437a85ac88d4a36bf55e72962e7365 \
 *     --sha-interval 10m --traces-per-sha 3-9 --service checkout-api
 *
 *   # No SHAs given → use the 3 most recent commits from `git log`:
 *   bun scripts/ingest-dummy.ts --num-shas 3 --sha-interval 10m
 *
 *   # Inspect the payload without sending anything:
 *   bun scripts/ingest-dummy.ts --traces-per-sha 2 --dry-run
 *
 *   # Just the GenAI agent trace fixtures (no commit-SHA traces):
 *   bun scripts/ingest-dummy.ts --traces-per-sha 0 --agent traces 1
 *
 * Wire format (verified against opentelemetry-proto 0.31 `with-serde`, the crate
 * the gateway decodes JSON with): camelCase keys, trace/span ids are lowercase
 * hex strings, *UnixNano fields are decimal-nanosecond *strings*, structs carry
 * `#[serde(default)]` so omitted fields (e.g. a root span's parentSpanId) are fine.
 */
import { randomBytes } from "node:crypto"
import { execFileSync } from "node:child_process"
import { parseArgs } from "node:util"

const FAILURE = 1

// ── OTLP enums ──────────────────────────────────────────────────────────────
const SPAN_KIND_INTERNAL = 1
const SPAN_KIND_SERVER = 2
const SPAN_KIND_CLIENT = 3
// Successful spans are left UNSET (0), never OK: per the OTel spec, instrumentation
// only ever sets Error, and Ok is reserved for an explicit application override — so
// essentially no real Maple span arrives as Ok and fixture data must not either.
const STATUS_UNSET = 0
const STATUS_ERROR = 2
const SEVERITY_INFO = 9
const SEVERITY_WARN = 13
const SEVERITY_ERROR = 17

// ── defaults ────────────────────────────────────────────────────────────────
// Hit the raw gateway port over plain HTTP by default: portless terminates TLS at
// https://ingest.localhost and proxies to :3474, but Bun's fetch would reject the
// portless self-signed cert. :3474 sidesteps that. Override with --endpoint.
const DEFAULT_ENDPOINT = process.env.MAPLE_INGEST_URL?.trim() || "http://localhost:3474"
// Any maple_pk_*/maple_sk_* string resolves to MAPLE_ORG_ID_OVERRIDE in single-tenant dev.
const DEFAULT_KEY = process.env.MAPLE_INGEST_KEY?.trim() || "maple_pk_local"
const DEFAULT_SERVICE = "checkout-api"
const DEFAULT_ENV = "production"
const MAX_SPANS_PER_REQUEST = 3000 // keep bodies well under INGEST_MAX_REQUEST_BODY_BYTES (20 MB)

const HEX40 = /^[0-9a-f]{40}$/

interface Range {
	readonly min: number
	readonly max: number
}

const fail = (message: string): never => {
	console.error(`✗ ${message}`)
	process.exit(FAILURE)
}

// ── tiny seeded RNG (mulberry32) for reproducible *shape* (counts/latencies/etc).
// Span & trace ids always use crypto randomness so they stay globally unique. ──
let rngState = 0
const seedRng = (seed: number): void => {
	rngState = seed >>> 0
}
const rng = (): number => {
	rngState |= 0
	rngState = (rngState + 0x6d2b79f5) | 0
	let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState)
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const randInt = (min: number, max: number): number => min + Math.floor(rng() * (max - min + 1))
const randIn = (r: Range): number => randInt(r.min, r.max)
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T
const chance = (p: number): boolean => rng() < p

// ── parsing helpers ─────────────────────────────────────────────────────────
const parseRange = (raw: string, label: string): Range => {
	const m = raw.match(/^(\d+)(?:-(\d+))?$/)
	if (!m) fail(`${label}: expected N or MIN-MAX, got "${raw}"`)
	const min = Number(m![1])
	const max = m![2] === undefined ? min : Number(m![2])
	if (max < min) fail(`${label}: min (${min}) > max (${max})`)
	return { min, max }
}

const parseDurationMs = (raw: string, label: string): number => {
	const m = raw.match(/^(\d+)(ms|s|m|h)?$/)
	if (!m) fail(`${label}: expected a duration like 30s/10m/2h, got "${raw}"`)
	const n = Number(m![1])
	switch (m![2]) {
		case "h":
			return n * 3_600_000
		case "m":
			return n * 60_000
		case "s":
			return n * 1000
		default:
			return n // bare number = ms
	}
}

// ── encoding helpers ────────────────────────────────────────────────────────
const traceId = (): string => randomBytes(16).toString("hex")
const spanId = (): string => randomBytes(8).toString("hex")
const nano = (ms: number): string => (BigInt(Math.round(ms)) * 1_000_000n).toString()
const attr = (key: string, value: string | number): Record<string, unknown> =>
	typeof value === "number"
		? { key, value: { intValue: String(value) } }
		: { key, value: { stringValue: value } }

// ── realistic-ish content ───────────────────────────────────────────────────
const ROUTES: ReadonlyArray<{ method: string; route: string }> = [
	{ method: "GET", route: "/api/checkout" },
	{ method: "POST", route: "/api/orders" },
	{ method: "GET", route: "/api/products" },
	{ method: "POST", route: "/api/payments" },
	{ method: "GET", route: "/api/cart" },
	{ method: "GET", route: "/api/users/{id}" },
]
const DB_CALLS = ["SELECT orders", "INSERT payments", "UPDATE inventory", "SELECT users"]
const CLIENT_CALLS = ["GET payments-gateway", "POST email-service", "GET pricing-service"]
const CACHE_CALLS = ["redis GET session", "redis SET cart"]
const EXCEPTIONS: ReadonlyArray<{ type: string; message: string }> = [
	{ type: "TimeoutError", message: "upstream timed out after 5000ms" },
	{ type: "ConnectionResetError", message: "connection reset by peer" },
	{ type: "ValidationError", message: "missing required field: amount" },
	{ type: "PaymentDeclinedError", message: "card declined (insufficient_funds)" },
]

interface Options {
	endpoint: string
	key: string
	service: string
	env: string
	shas: string[]
	shaInterval: number
	tracesPerSha: Range
	children: Range
	logsPerTrace: Range
	errorRate: number
	spread: number
	anchor: number
	agentTraceSets: number
	dryRun: boolean
	quiet: boolean
}

interface GeneratedSha {
	sha: string
	at: number
	spans: Record<string, unknown>[]
	logs: Record<string, unknown>[]
	traceCount: number
	errorCount: number
}

const recentGitShas = (n: number): string[] => {
	try {
		const out = execFileSync("git", ["log", `-n${n}`, "--pretty=%H"], {
			cwd: new URL("..", import.meta.url).pathname,
			encoding: "utf8",
		})
		return out
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean)
	} catch {
		return []
	}
}

/** Build all spans + correlated logs for one commit SHA. */
const generateForSha = (sha: string, at: number, opts: Options): GeneratedSha => {
	const spans: Record<string, unknown>[] = []
	const logs: Record<string, unknown>[] = []
	const traceCount = randIn(opts.tracesPerSha)
	let errorCount = 0

	for (let i = 0; i < traceCount; i++) {
		const tid = traceId()
		const rootId = spanId()
		// Scatter this trace within [at - spread, at] so everything stays in the past.
		const startMs = at - Math.floor(rng() * opts.spread)
		const isError = chance(opts.errorRate)
		if (isError) errorCount++

		const { method, route } = pick(ROUTES)
		const baseLatency = randInt(20, 400) + (isError ? randInt(100, 1200) : 0)
		const status = isError ? 500 : 200

		const rootAttrs = [
			attr("http.request.method", method),
			attr("http.route", route),
			attr("url.path", route.replace("{id}", String(randInt(1000, 9999)))),
			attr("http.response.status_code", status),
			attr("server.address", `${opts.service}.internal`),
		]

		const root: Record<string, unknown> = {
			traceId: tid,
			spanId: rootId,
			name: `${method} ${route}`,
			kind: SPAN_KIND_SERVER,
			startTimeUnixNano: nano(startMs),
			endTimeUnixNano: nano(startMs + baseLatency),
			attributes: rootAttrs,
			status: isError
				? { code: STATUS_ERROR, message: "internal server error" }
				: { code: STATUS_UNSET },
		}

		// Child spans, all parented to the root (flat tree — plenty for the UI).
		const childCount = randIn(opts.children)
		const childSpans: Record<string, unknown>[] = []
		for (let c = 0; c < childCount; c++) {
			const childDur = Math.max(1, Math.floor(baseLatency * (0.1 + rng() * 0.6)))
			const childStart = startMs + randInt(0, Math.max(0, baseLatency - childDur))
			// The last child of a failing request is the thing that failed.
			const childErrored = isError && c === childCount - 1

			// Pick a child flavor (weighted), which decides kind + name + attributes.
			let kind: number
			let name: string
			let childAttrs: Record<string, unknown>[]
			switch (pick(["db", "db", "http", "http", "cache", "internal"] as const)) {
				case "db": {
					kind = SPAN_KIND_CLIENT
					name = pick(DB_CALLS)
					childAttrs = [
						attr("db.system", "postgresql"),
						attr("db.statement", `${name} WHERE org_id = $1`),
					]
					break
				}
				case "http": {
					kind = SPAN_KIND_CLIENT
					name = pick(CLIENT_CALLS)
					childAttrs = [
						attr("http.request.method", name.split(" ")[0]!),
						attr("url.full", `https://${name.split(" ")[1]}/v1`),
					]
					break
				}
				case "cache": {
					kind = SPAN_KIND_CLIENT
					name = pick(CACHE_CALLS)
					childAttrs = [attr("db.system", "redis")]
					break
				}
				default: {
					kind = SPAN_KIND_INTERNAL
					name = "validate request"
					childAttrs = [attr("code.function", "validateOrder")]
				}
			}

			childSpans.push({
				traceId: tid,
				spanId: spanId(),
				parentSpanId: rootId,
				name,
				kind,
				startTimeUnixNano: nano(childStart),
				endTimeUnixNano: nano(childStart + childDur),
				attributes: childAttrs,
				status: childErrored ? { code: STATUS_ERROR } : { code: STATUS_UNSET },
			})
		}

		if (isError) {
			const ex = pick(EXCEPTIONS)
			const failing = (childSpans[childSpans.length - 1] ?? root) as Record<string, unknown>
			failing.events = [
				{
					timeUnixNano: nano(startMs + baseLatency - 1),
					name: "exception",
					attributes: [
						attr("exception.type", ex.type),
						attr("exception.message", ex.message),
						attr(
							"exception.stacktrace",
							`${ex.type}: ${ex.message}\n    at handler (${opts.service}.ts:42)`,
						),
					],
				},
			]
		}

		spans.push(root, ...childSpans)

		// Correlated logs for this trace.
		const logCount = randIn(opts.logsPerTrace)
		for (let l = 0; l < logCount; l++) {
			const errLog = isError && l === 0
			logs.push({
				timeUnixNano: nano(startMs + randInt(0, baseLatency)),
				severityNumber: errLog ? SEVERITY_ERROR : chance(0.15) ? SEVERITY_WARN : SEVERITY_INFO,
				severityText: errLog ? "ERROR" : chance(0.15) ? "WARN" : "INFO",
				body: {
					stringValue: errLog
						? `${pick(EXCEPTIONS).type} handling ${method} ${route}`
						: `${method} ${route} -> ${status}`,
				},
				traceId: tid,
				spanId: rootId,
				attributes: [attr("http.route", route)],
			})
		}
	}

	return { sha, at, spans, logs, traceCount, errorCount }
}

// ── GenAI "agentic agent trace" fixtures ────────────────────────────────────────
// A *agent trace* is one end-to-end agent conversation. The warehouse query
// (`packages/query-engine/src/ch/queries/genai.ts`) reconstructs it from raw
// spans: it keeps every span whose `gen_ai.operation.name` is non-empty — so
// EVERY span below sets it — and groups them by a derived AgentTraceId that
// coalesces `gen_ai.conversation.id` → `session.id` → `TraceId`, resolved per
// trace. The fixtures below deliberately exercise all three rungs of that
// ladder, `session.id` in both the span and the resource map, and both
// generations of the churning attribute names.
//
// Attribute names are NOT invented here: they are exactly the keys that query
// reads. Token counts are ints (`intValue`); cost is a decimal *string*
// (`gen_ai.usage.cost`), which is what real emitters send and what
// `toFloat64OrZero` expects.

const AGENT_TRACE_SERVICE = "agent-service"
/** An agent trace whose last span is inside this window renders as "running". */
const AGENT_TRACE_RUNNING_GRACE_MS = 120_000

/** Which rung of the AgentTraceId ladder a fixture lands on. */
type AgentTraceIdKind = "conversation" | "session" | "trace"

interface GeneratedAgentTrace {
	fixture: string
	/** What a dev opens the agent trace by — the derived AgentTraceId. */
	id: string
	idKind: AgentTraceIdKind
	note: string
	/** Extra *resource* attributes for this agent trace (e.g. a resource `session.id`). */
	resourceExtra: Record<string, unknown>[]
	spans: Record<string, unknown>[]
	logs: Record<string, unknown>[]
	traceCount: number
	errorCount: number
	startedAt: number
}

// ── message-content helpers (the `gen_ai.{input,output}.messages` JSON shape) ─
interface TextPart {
	type: "text"
	content: string
}
interface ToolCallPart {
	type: "tool_call"
	id: string
	name: string
	arguments: Record<string, unknown>
}
interface ChatMessage {
	role: string
	parts: Array<TextPart | ToolCallPart>
}

const textMessage = (role: string, content: string): ChatMessage => ({
	role,
	parts: [{ type: "text", content }],
})
const messagesJson = (messages: readonly ChatMessage[]): string => JSON.stringify(messages)

// Per-span durations and the user "think time" between turns, so the timeline
// shows real gaps rather than a solid block of spans.
const spanDuration = (): number => randInt(300, 8000)
const thinkTime = (): number => randInt(3000, 40_000)

const conversationId = (): string => `conv_${randomBytes(8).toString("hex")}`
const sessionIdValue = (): string => `sess_${randomBytes(8).toString("hex")}`

interface AgentTraceSpanSpec {
	traceId: string
	spanId?: string
	parentSpanId?: string
	name: string
	kind?: number
	startMs: number
	durationMs: number
	attributes: Record<string, unknown>[]
	/** Non-empty ⇒ status ERROR with this message. Otherwise UNSET (never OK). */
	error?: string
	events?: Record<string, unknown>[]
}

const agentTraceSpan = (spec: AgentTraceSpanSpec): Record<string, unknown> => {
	const span: Record<string, unknown> = {
		traceId: spec.traceId,
		spanId: spec.spanId ?? spanId(),
		name: spec.name,
		kind: spec.kind ?? SPAN_KIND_CLIENT,
		startTimeUnixNano: nano(spec.startMs),
		endTimeUnixNano: nano(spec.startMs + spec.durationMs),
		attributes: spec.attributes,
		status: spec.error ? { code: STATUS_ERROR, message: spec.error } : { code: STATUS_UNSET },
	}
	if (spec.parentSpanId) span.parentSpanId = spec.parentSpanId
	if (spec.events) span.events = spec.events
	return span
}

const exceptionEvent = (at: number, type: string, message: string): Record<string, unknown> => ({
	timeUnixNano: nano(at),
	name: "exception",
	attributes: [
		attr("exception.type", type),
		attr("exception.message", message),
		attr("exception.stacktrace", `${type}: ${message}\n    at executeTool (agent-service.ts:87)`),
	],
})

/** Cost as the decimal string real emitters send (never a number). */
const costAttr = (inputTokens: number, outputTokens: number): Record<string, unknown> =>
	attr("gen_ai.usage.cost", (inputTokens * 0.0000025 + outputTokens * 0.00001).toFixed(5))

interface InferenceAttrOpts {
	provider?: string
	requestModel: string
	responseModel?: string
	inputTokens: number
	outputTokens: number
	cachedInputTokens?: number
	reasoningTokens?: number
	finishReason?: string
	input?: string
	output?: string
	systemInstructions?: string
	extra?: Record<string, unknown>[]
}

/** The attribute set of one `chat` span, minus identity (added per fixture). */
const inferenceAttrs = (o: InferenceAttrOpts): Record<string, unknown>[] => [
	attr("gen_ai.operation.name", "chat"),
	attr("gen_ai.provider.name", o.provider ?? "openai"),
	attr("gen_ai.request.model", o.requestModel),
	attr("gen_ai.response.model", o.responseModel ?? o.requestModel),
	attr("gen_ai.usage.input_tokens", o.inputTokens),
	attr("gen_ai.usage.output_tokens", o.outputTokens),
	attr("gen_ai.usage.cached_input_tokens", o.cachedInputTokens ?? 0),
	attr("gen_ai.usage.reasoning_tokens", o.reasoningTokens ?? 0),
	costAttr(o.inputTokens, o.outputTokens),
	...(o.finishReason ? [attr("gen_ai.response.finish_reasons", o.finishReason)] : []),
	...(o.input ? [attr("gen_ai.input.messages", o.input)] : []),
	...(o.output ? [attr("gen_ai.output.messages", o.output)] : []),
	...(o.systemInstructions ? [attr("gen_ai.system_instructions", o.systemInstructions)] : []),
	...(o.extra ?? []),
]

const SYSTEM_PROMPT =
	"You are Maple's observability copilot. Answer with concrete spans, services and metrics; " +
	"call tools before speculating."

/** Scatter an agent trace's start somewhere in the last ~2h (before the anchor). */
const agentTraceStart = (opts: Options): number => opts.anchor - randInt(10, 115) * 60_000

/** Earliest `startTimeUnixNano` across a fixture's spans, back in epoch ms. */
const agentTraceStartOf = (spans: Record<string, unknown>[]): number => {
	let min = Number.POSITIVE_INFINITY
	for (const s of spans) min = Math.min(min, Number(BigInt(s.startTimeUnixNano as string) / 1_000_000n))
	return Number.isFinite(min) ? min : Date.now()
}

// ── (a) multi-turn, cumulative input.messages — the N² dedupe trap ───────────
const CUMULATIVE_TURNS: ReadonlyArray<{ user: string; assistant: string }> = [
	{
		user: "Checkout p95 doubled after this morning's deploy. Where do I look?",
		assistant:
			"p95 on `POST /api/orders` went 410ms → 890ms at 09:12, right on deploy ea0466f. " +
			"The extra time is all in the `INSERT payments` child span.",
	},
	{
		user: "Is it every request or a subset?",
		assistant:
			"A subset: 18% of requests, all from org shards 3 and 7. The rest are unchanged at ~400ms.",
	},
	{
		user: "What changed in that deploy for those shards?",
		assistant:
			"ea0466f added a per-row `SELECT ... FOR UPDATE` in the payment writer. On shards 3 and 7 " +
			"it serializes behind the nightly reconciliation job.",
	},
	{
		user: "Give me the smallest fix that unblocks the release.",
		assistant:
			"Batch the lock acquisition per order instead of per line item — one statement, no schema " +
			"change. That drops the contention window from ~450ms to ~20ms.",
	},
]

const agentTraceMultiTurnCumulative = (opts: Options): GeneratedAgentTrace => {
	const convId = conversationId()
	const spans: Record<string, unknown>[] = []
	const logs: Record<string, unknown>[] = []
	// The conversation as the model sees it: every turn's input repeats ALL of it.
	const history: ChatMessage[] = []
	let at = agentTraceStart(opts)

	CUMULATIVE_TURNS.forEach((turn, i) => {
		history.push(textMessage("user", turn.user))
		const input = messagesJson(history) // snapshot: prior turns + the new user message
		const output = messagesJson([textMessage("assistant", turn.assistant)])
		history.push(textMessage("assistant", turn.assistant))

		// Each turn is its OWN trace; only the conversation id ties them together.
		const tid = traceId()
		const sid = spanId()
		const duration = spanDuration()
		// Input tokens grow with the (cumulative) history — that's the whole point.
		const inputTokens = 320 + i * 460 + randInt(0, 40)
		const outputTokens = randInt(90, 260)
		spans.push(
			agentTraceSpan({
				traceId: tid,
				spanId: sid,
				name: "chat gpt-4o",
				startMs: at,
				durationMs: duration,
				attributes: [
					...inferenceAttrs({
						requestModel: "gpt-4o",
						inputTokens,
						outputTokens,
						cachedInputTokens: i === 0 ? 0 : 256 * i,
						finishReason: "stop",
						input,
						output,
						systemInstructions: SYSTEM_PROMPT,
					}),
					attr("gen_ai.conversation.id", convId),
				],
			}),
		)
		logs.push({
			timeUnixNano: nano(at + duration),
			severityNumber: SEVERITY_INFO,
			severityText: "INFO",
			body: { stringValue: `turn ${i + 1}/${CUMULATIVE_TURNS.length} completed (${outputTokens} output tokens)` },
			traceId: tid,
			spanId: sid,
			attributes: [attr("gen_ai.conversation.id", convId)],
		})
		at += duration + thinkTime()
	})

	return {
		fixture: "multi-turn-cumulative",
		id: convId,
		idKind: "conversation",
		note: "4 turns, 4 traces, input.messages repeats every prior turn (N² dedupe trap)",
		resourceExtra: [],
		spans,
		logs,
		traceCount: CUMULATIVE_TURNS.length,
		errorCount: 0,
		startedAt: agentTraceStartOf(spans),
	}
}

// ── (b) parallel tool calls, one failing — session.id as a SPAN attribute ────
const agentTraceParallelTools = (opts: Options): GeneratedAgentTrace => {
	const sessId = sessionIdValue()
	const sessionAttr = attr("session.id", sessId)
	const spans: Record<string, unknown>[] = []
	const logs: Record<string, unknown>[] = []
	const tid = traceId()
	const inferenceId = spanId()
	const start = agentTraceStart(opts)

	const userText = "Compare our error budget burn to last week and pull the runbook for checkout."
	const assistantWithToolCalls: ChatMessage = {
		role: "assistant",
		parts: [
			{
				type: "tool_call",
				id: "call_a",
				name: "query_error_budget",
				arguments: { service: "checkout-api", window: "7d", compareTo: "previous_period" },
			},
			{
				type: "tool_call",
				id: "call_b",
				name: "search_docs",
				arguments: { query: "checkout runbook rollback", limit: 3 },
			},
			{ type: "text", content: "Pulling both now." },
		],
	}

	const inferenceDuration = randInt(900, 2600)
	spans.push(
		agentTraceSpan({
			traceId: tid,
			spanId: inferenceId,
			name: "chat claude-sonnet-4",
			startMs: start,
			durationMs: inferenceDuration,
			attributes: [
				...inferenceAttrs({
					provider: "anthropic",
					requestModel: "claude-sonnet-4",
					inputTokens: 780,
					outputTokens: 180,
					finishReason: "tool_calls",
					input: messagesJson([textMessage("user", userText)]),
					output: messagesJson([assistantWithToolCalls]),
					systemInstructions: SYSTEM_PROMPT,
				}),
				sessionAttr,
			],
		}),
	)

	// Two siblings of the SAME inference span, deliberately OVERLAPPING in time.
	const toolsStart = start + inferenceDuration
	const toolA = { start: toolsStart + 40, duration: randInt(1800, 4200) }
	const toolB = { start: toolsStart + 220, duration: randInt(2400, 6000) }

	spans.push(
		agentTraceSpan({
			traceId: tid,
			spanId: spanId(),
			parentSpanId: inferenceId,
			name: "execute_tool query_error_budget",
			kind: SPAN_KIND_INTERNAL,
			startMs: toolA.start,
			durationMs: toolA.duration,
			attributes: [
				attr("gen_ai.operation.name", "execute_tool"),
				attr("gen_ai.provider.name", "anthropic"),
				attr("gen_ai.request.tool.name", "query_error_budget"),
				attr("gen_ai.request.tool.type", "function"),
				attr("gen_ai.tool.call.id", "call_a"),
				attr(
					"gen_ai.tool.call.arguments",
					JSON.stringify({ service: "checkout-api", window: "7d", compareTo: "previous_period" }),
				),
				attr(
					"gen_ai.tool.call.result",
					JSON.stringify({ burnedPct: 62.4, previousPct: 28.1, budgetRemainingMinutes: 41 }),
				),
				sessionAttr,
			],
		}),
	)

	const failAt = toolB.start + toolB.duration - 5
	spans.push(
		agentTraceSpan({
			traceId: tid,
			spanId: spanId(),
			parentSpanId: inferenceId,
			name: "execute_tool search_docs",
			kind: SPAN_KIND_INTERNAL,
			startMs: toolB.start,
			durationMs: toolB.duration,
			error: "tool call failed: docs index unavailable",
			events: [exceptionEvent(failAt, "ToolExecutionError", "docs index unavailable (503 from search-svc)")],
			attributes: [
				attr("gen_ai.operation.name", "execute_tool"),
				attr("gen_ai.provider.name", "anthropic"),
				attr("gen_ai.request.tool.name", "search_docs"),
				attr("gen_ai.request.tool.type", "function"),
				attr("gen_ai.tool.call.id", "call_b"),
				attr(
					"gen_ai.tool.call.arguments",
					JSON.stringify({ query: "checkout runbook rollback", limit: 3 }),
				),
				sessionAttr,
			],
		}),
	)
	logs.push({
		timeUnixNano: nano(failAt),
		severityNumber: SEVERITY_ERROR,
		severityText: "ERROR",
		body: { stringValue: "tool call_b (search_docs) failed: docs index unavailable" },
		traceId: tid,
		spanId: inferenceId,
		attributes: [attr("session.id", sessId), attr("gen_ai.tool.call.id", "call_b")],
	})

	// The follow-up turn, in the same trace, that reasons about the half-failure.
	const followStart = Math.max(toolA.start + toolA.duration, toolB.start + toolB.duration) + 120
	spans.push(
		agentTraceSpan({
			traceId: tid,
			spanId: spanId(),
			parentSpanId: inferenceId,
			name: "chat claude-sonnet-4",
			startMs: followStart,
			durationMs: spanDuration(),
			attributes: [
				...inferenceAttrs({
					provider: "anthropic",
					requestModel: "claude-sonnet-4",
					inputTokens: 1120,
					outputTokens: 210,
					finishReason: "stop",
					input: messagesJson([
						textMessage("user", userText),
						assistantWithToolCalls,
						textMessage("tool", JSON.stringify({ burnedPct: 62.4, previousPct: 28.1 })),
					]),
					output: messagesJson([
						textMessage(
							"assistant",
							"Burn is 62% vs 28% last week — mostly the 09:12 deploy. The runbook lookup failed " +
								"(docs index 503), so here's the rollback from memory: revert ea0466f, then re-run the " +
								"payment reconciliation.",
						),
					]),
					systemInstructions: SYSTEM_PROMPT,
				}),
				sessionAttr,
			],
		}),
	)

	return {
		fixture: "parallel-tools-one-failing",
		id: sessId,
		idKind: "session",
		note: "2 overlapping execute_tool siblings under one turn, call_b ERROR (session.id on the SPAN)",
		resourceExtra: [],
		spans,
		logs,
		traceCount: 1,
		errorCount: 1,
		startedAt: start,
	}
}

// ── (c) fully content-redacted (privacy mode) ───────────────────────────────
const agentTraceRedacted = (opts: Options): GeneratedAgentTrace => {
	const convId = conversationId()
	const spans: Record<string, unknown>[] = []
	let at = agentTraceStart(opts)

	for (let i = 0; i < 3; i++) {
		const duration = spanDuration()
		spans.push(
			agentTraceSpan({
				traceId: traceId(),
				name: "chat gpt-4o-mini",
				startMs: at,
				durationMs: duration,
				// Timing, model, tokens and cost survive; every content attribute is
				// stripped — no input.messages / output.messages / system_instructions.
				attributes: [
					...inferenceAttrs({
						requestModel: "gpt-4o-mini",
						inputTokens: 410 + i * 380,
						outputTokens: randInt(80, 220),
						cachedInputTokens: i * 128,
						finishReason: "stop",
					}),
					attr("gen_ai.conversation.id", convId),
				],
			}),
		)
		at += duration + thinkTime()
	}

	return {
		fixture: "content-redacted",
		id: convId,
		idKind: "conversation",
		note: "3 turns with tokens/cost/timing but NO message content at all",
		resourceExtra: [],
		spans,
		logs: [],
		traceCount: 3,
		errorCount: 0,
		startedAt: agentTraceStartOf(spans),
	}
}

// ── (d) multi-model, mid-conversation switch + router divergence ─────────────
const agentTraceMultiModel = (opts: Options): GeneratedAgentTrace => {
	const convId = conversationId()
	const spans: Record<string, unknown>[] = []
	const history: ChatMessage[] = []
	let at = agentTraceStart(opts)

	const turns: ReadonlyArray<{
		user: string
		assistant: string
		requestModel: string
		responseModel: string
	}> = [
		{
			user: "Summarize the last 24h of alerts for checkout-api.",
			assistant: "17 alerts, 3 distinct rules; 11 of them are the latency rule flapping between 09:00 and 11:00.",
			requestModel: "gpt-4o-mini",
			responseModel: "gpt-4o-mini",
		},
		{
			user: "Which rule is noisiest and why?",
			assistant: "`checkout p95 > 800ms` — a 1-minute window with no for-duration, so every spike pages.",
			// Router divergence: asked for the cheap tier, served an -0718 build.
			requestModel: "gpt-4o-mini",
			responseModel: "gpt-4o-mini-2024-07-18",
		},
		{
			user: "Escalate: draft the rule change and explain the trade-off properly.",
			assistant:
				"Move to a 5-minute window with `for: 10m`. You lose ~4 minutes of detection latency and drop " +
				"11 pages/day to about 1.",
			requestModel: "o3",
			responseModel: "o3",
		},
		{
			user: "What breaks if traffic triples on Black Friday?",
			assistant:
				"The 5-minute window still holds, but the static 800ms threshold won't — switch it to a burn-rate " +
				"alert on the 99.5% SLO before the event.",
			// Second divergence, on the escalated model.
			requestModel: "o3",
			responseModel: "o3-2025-04-16",
		},
	]

	turns.forEach((turn, i) => {
		history.push(textMessage("user", turn.user))
		const input = messagesJson(history)
		const output = messagesJson([textMessage("assistant", turn.assistant)])
		history.push(textMessage("assistant", turn.assistant))
		const duration = i >= 2 ? randInt(3000, 8000) : spanDuration()
		spans.push(
			agentTraceSpan({
				traceId: traceId(),
				name: `chat ${turn.requestModel}`,
				startMs: at,
				durationMs: duration,
				attributes: [
					...inferenceAttrs({
						provider: "openrouter",
						requestModel: turn.requestModel,
						responseModel: turn.responseModel,
						inputTokens: 300 + i * 420,
						outputTokens: randInt(120, 340),
						reasoningTokens: i >= 2 ? randInt(400, 1800) : 0,
						finishReason: "stop",
						input,
						output,
						systemInstructions: SYSTEM_PROMPT,
					}),
					attr("gen_ai.conversation.id", convId),
				],
			}),
		)
		at += duration + thinkTime()
	})

	return {
		fixture: "multi-model-switch",
		id: convId,
		idKind: "conversation",
		note: "4 turns: gpt-4o-mini → o3 mid-conversation, requested ≠ served on 2 spans",
		resourceExtra: [],
		spans,
		logs: [],
		traceCount: turns.length,
		errorCount: 0,
		startedAt: agentTraceStartOf(spans),
	}
}

// ── (e) agent / workflow agent trace with non-message operations + a handoff ─────
const agentTraceAgentWorkflow = (opts: Options): GeneratedAgentTrace => {
	const convId = conversationId()
	const workflow = "incident-triage"
	const triageAgent = [attr("gen_ai.agent.name", "triage-agent"), attr("gen_ai.agent.id", "agent_triage_01")]
	const remediationAgent = [
		attr("gen_ai.agent.name", "remediation-agent"),
		attr("gen_ai.agent.id", "agent_remediation_02"),
	]
	const shared = [attr("gen_ai.workflow.name", workflow), attr("gen_ai.conversation.id", convId)]
	const spans: Record<string, unknown>[] = []
	const logs: Record<string, unknown>[] = []

	// Trace 1 — triage agent: a turn, a retrieval, then a turn using what it found.
	const t1 = traceId()
	let at = agentTraceStart(opts)
	const openingUser = "Incident INC-4821: checkout error rate 12%. Triage it."
	const turn1Duration = spanDuration()
	const turn1Span = spanId()
	spans.push(
		agentTraceSpan({
			traceId: t1,
			spanId: turn1Span,
			name: "chat gpt-4o",
			startMs: at,
			durationMs: turn1Duration,
			attributes: [
				...inferenceAttrs({
					requestModel: "gpt-4o",
					inputTokens: 640,
					outputTokens: 190,
					finishReason: "stop",
					input: messagesJson([textMessage("user", openingUser)]),
					output: messagesJson([
						textMessage("assistant", "Pulling similar past incidents before I conclude anything."),
					]),
					systemInstructions: SYSTEM_PROMPT,
				}),
				...triageAgent,
				...shared,
			],
		}),
	)
	at += turn1Duration + 150

	const retrievalDuration = randInt(300, 1400)
	spans.push(
		agentTraceSpan({
			traceId: t1,
			parentSpanId: turn1Span,
			name: "retrieval incident_history",
			kind: SPAN_KIND_INTERNAL,
			startMs: at,
			durationMs: retrievalDuration,
			// A non-message operation: no messages, but still a first-class GenAI span.
			attributes: [
				attr("gen_ai.operation.name", "retrieval"),
				attr("gen_ai.provider.name", "openai"),
				attr("gen_ai.request.model", "text-embedding-3-large"),
				attr("gen_ai.response.model", "text-embedding-3-large"),
				attr("gen_ai.usage.input_tokens", 96),
				attr("gen_ai.usage.output_tokens", 0),
				attr("retrieval.documents.count", 5),
				...triageAgent,
				...shared,
			],
		}),
	)
	at += retrievalDuration + 200

	const turn2Duration = spanDuration()
	spans.push(
		agentTraceSpan({
			traceId: t1,
			name: "chat gpt-4o",
			startMs: at,
			durationMs: turn2Duration,
			attributes: [
				...inferenceAttrs({
					requestModel: "gpt-4o",
					inputTokens: 1480,
					outputTokens: 300,
					cachedInputTokens: 512,
					finishReason: "stop",
					input: messagesJson([
						textMessage("user", openingUser),
						textMessage("assistant", "Pulling similar past incidents before I conclude anything."),
						textMessage("tool", "5 similar incidents; 4 resolved by rolling back a payment-writer change."),
					]),
					output: messagesJson([
						textMessage(
							"assistant",
							"Same signature as INC-4102 and INC-4390: payment-writer lock contention. Handing off to " +
								"remediation-agent to prepare the rollback.",
						),
					]),
					systemInstructions: SYSTEM_PROMPT,
				}),
				...triageAgent,
				...shared,
			],
		}),
	)
	at += turn2Duration + thinkTime()

	// Trace 2 — the handoff itself, then the second agent's turn.
	const t2 = traceId()
	const invokeSpan = spanId()
	const invokeDuration = randInt(1200, 5000)
	spans.push(
		agentTraceSpan({
			traceId: t2,
			spanId: invokeSpan,
			name: "invoke_agent remediation-agent",
			startMs: at,
			durationMs: invokeDuration,
			attributes: [
				attr("gen_ai.operation.name", "invoke_agent"),
				attr("gen_ai.provider.name", "openai"),
				// The handoff target: a SECOND agent name inside the same agent trace.
				...remediationAgent,
				...shared,
				attr("gen_ai.request.model", "gpt-4o"),
			],
		}),
	)
	logs.push({
		timeUnixNano: nano(at),
		severityNumber: SEVERITY_WARN,
		severityText: "WARN",
		body: { stringValue: `${workflow}: handing off triage-agent → remediation-agent (INC-4821)` },
		traceId: t2,
		spanId: invokeSpan,
		attributes: [attr("gen_ai.workflow.name", workflow), attr("gen_ai.conversation.id", convId)],
	})
	at += 200

	spans.push(
		agentTraceSpan({
			traceId: t2,
			parentSpanId: invokeSpan,
			name: "chat gpt-4o",
			startMs: at,
			durationMs: Math.max(300, invokeDuration - 400),
			attributes: [
				...inferenceAttrs({
					requestModel: "gpt-4o",
					inputTokens: 890,
					outputTokens: 260,
					finishReason: "stop",
					input: messagesJson([
						textMessage("user", "Prepare a rollback plan for ea0466f on checkout-api."),
					]),
					output: messagesJson([
						textMessage(
							"assistant",
							"Rollback drafted: revert ea0466f, redeploy 3 shards at a time, re-run reconciliation. " +
								"Estimated 6 minutes to full recovery.",
						),
					]),
					systemInstructions: SYSTEM_PROMPT,
				}),
				...remediationAgent,
				...shared,
			],
		}),
	)

	return {
		fixture: "agent-workflow-handoff",
		id: convId,
		idKind: "conversation",
		note: "workflow incident-triage: retrieval + invoke_agent handoff triage-agent → remediation-agent",
		resourceExtra: [],
		spans,
		logs,
		traceCount: 2,
		errorCount: 0,
		startedAt: agentTraceStartOf(spans),
	}
}

// ── (f) legacy attribute names — no conversation/session id ⇒ TraceId is the id ─
const agentTraceLegacyAttributes = (opts: Options): GeneratedAgentTrace => {
	// This fixture MUST stay inside one trace: with neither `gen_ai.conversation.id`
	// nor `session.id`, the AgentTraceId falls all the way back to `TraceId`, and a
	// second trace would be a second agent trace.
	const tid = traceId()
	const spans: Record<string, unknown>[] = []
	const rootId = spanId()
	let at = agentTraceStart(opts)

	const turns: ReadonlyArray<{ prompt: string; completion: string }> = [
		{
			prompt: "Which service owns the `orders.created` topic?",
			completion: "`checkout-api` publishes it; `fulfilment-worker` and `analytics-ingest` consume it.",
		},
		{
			prompt: "Show me the consumer lag for fulfilment-worker.",
			completion: "Peak lag today was 4,120 messages at 09:14, back to <50 by 09:31.",
		},
	]

	turns.forEach((turn, i) => {
		const duration = spanDuration()
		spans.push(
			agentTraceSpan({
				traceId: tid,
				spanId: i === 0 ? rootId : undefined,
				parentSpanId: i === 0 ? undefined : rootId,
				name: "openai.chat",
				startMs: at,
				durationMs: duration,
				// Every name here is the OLD generation — the query coalesces each of
				// them onto its modern counterpart, and this is what proves it.
				attributes: [
					attr("gen_ai.operation.name", "chat"),
					attr("gen_ai.system", "openai"),
					attr("gen_ai.request.model", "gpt-4-turbo"),
					attr("gen_ai.response.model", "gpt-4-turbo"),
					attr("gen_ai.usage.prompt_tokens", 260 + i * 310),
					attr("gen_ai.usage.completion_tokens", randInt(70, 190)),
					attr("gen_ai.prompt", messagesJson([textMessage("user", turn.prompt)])),
					attr("gen_ai.completion", messagesJson([textMessage("assistant", turn.completion)])),
					attr("gen_ai.response.finish_reasons", "stop"),
				],
			}),
		)
		at += duration + thinkTime()
	})

	// A legacy tool span too: `gen_ai.tool.name` instead of `gen_ai.request.tool.name`.
	const toolDuration = randInt(400, 2500)
	spans.push(
		agentTraceSpan({
			traceId: tid,
			parentSpanId: rootId,
			name: "openai.tool",
			kind: SPAN_KIND_INTERNAL,
			startMs: at,
			durationMs: toolDuration,
			attributes: [
				attr("gen_ai.operation.name", "execute_tool"),
				attr("gen_ai.system", "openai"),
				attr("gen_ai.tool.name", "consumer_lag"),
				attr("gen_ai.tool.call.id", "call_legacy_1"),
				attr("gen_ai.tool.call.arguments", JSON.stringify({ topic: "orders.created" })),
				attr("gen_ai.tool.call.result", JSON.stringify({ peakLag: 4120, at: "09:14" })),
			],
		}),
	)

	return {
		fixture: "legacy-attribute-names",
		id: tid,
		idKind: "trace",
		note: "gen_ai.system / prompt_tokens / prompt / completion / tool.name — single trace, id = TraceId",
		resourceExtra: [],
		spans,
		logs: [],
		traceCount: 1,
		errorCount: 0,
		startedAt: agentTraceStartOf(spans),
	}
}

// ── (g) in-progress — session.id as a RESOURCE attribute, ends ~now ──────────
const agentTraceRunning = (opts: Options): GeneratedAgentTrace => {
	const sessId = sessionIdValue()
	const spans: Record<string, unknown>[] = []
	const history: ChatMessage[] = []

	const turns: ReadonlyArray<{ user: string; assistant?: string }> = [
		{
			user: "Start a cost review of last month's LLM spend.",
			assistant: "Pulling per-model spend for the last 30 days.",
		},
		{
			user: "Break it down by workflow, not by model.",
			assistant: "incident-triage is 61% of spend, chat 27%, batch summarization 12%.",
		},
		// The last turn is still streaming: no assistant reply, no finish_reasons.
		{ user: "Where's the cheapest 20% to cut without hurting triage quality?" },
	]

	// Anchor the tail at ~15s ago so the agent trace lands inside the running grace
	// window (the backend has no in-progress marker — recency is the signal).
	const lastDuration = randInt(4000, 8000)
	const lastStart = opts.anchor - 15_000 - lastDuration
	let at = lastStart
	for (let i = turns.length - 2; i >= 0; i--) at -= spanDuration() + thinkTime()

	turns.forEach((turn, i) => {
		history.push(textMessage("user", turn.user))
		const input = messagesJson(history)
		const isLast = i === turns.length - 1
		const duration = isLast ? lastDuration : spanDuration()
		const startMs = isLast ? lastStart : at
		if (turn.assistant) history.push(textMessage("assistant", turn.assistant))
		spans.push(
			agentTraceSpan({
				traceId: traceId(),
				name: "chat claude-sonnet-4",
				startMs,
				durationMs: duration,
				attributes: inferenceAttrs({
					provider: "anthropic",
					requestModel: "claude-sonnet-4",
					inputTokens: 380 + i * 430,
					outputTokens: turn.assistant ? randInt(110, 260) : 0,
					// No finish_reasons on the in-flight turn, and no output messages.
					finishReason: turn.assistant ? "stop" : undefined,
					input,
					output: turn.assistant ? messagesJson([textMessage("assistant", turn.assistant)]) : undefined,
					systemInstructions: SYSTEM_PROMPT,
				}),
			}),
		)
		if (!isLast) at += duration + thinkTime()
	})

	return {
		fixture: "in-progress",
		id: sessId,
		idKind: "session",
		// The resource map is the other place `session.id` legitimately lives.
		resourceExtra: [attr("session.id", sessId)],
		note: `3 turns, last span ends ~15s ago (< ${AGENT_TRACE_RUNNING_GRACE_MS / 1000}s grace), session.id on the RESOURCE`,
		spans,
		logs: [],
		traceCount: turns.length,
		errorCount: 0,
		startedAt: agentTraceStartOf(spans),
	}
}

const AGENT_TRACE_FIXTURES: ReadonlyArray<(opts: Options) => GeneratedAgentTrace> = [
	agentTraceMultiTurnCumulative,
	agentTraceParallelTools,
	agentTraceRedacted,
	agentTraceMultiModel,
	agentTraceAgentWorkflow,
	agentTraceLegacyAttributes,
	agentTraceRunning,
]

/** The whole fixture set, `sets` times over (fresh ids and timings each round). */
const generateAgentTraces = (opts: Options): GeneratedAgentTrace[] => {
	const out: GeneratedAgentTrace[] = []
	for (let i = 0; i < opts.agentTraceSets; i++) for (const make of AGENT_TRACE_FIXTURES) out.push(make(opts))
	return out.sort((a, b) => a.startedAt - b.startedAt)
}

const resourceAttrs = (opts: Options, sha: string): Record<string, unknown>[] => [
	attr("service.name", opts.service),
	// Dual-emitted like every real Maple producer: `deployment.environment.name` is
	// the canonical OTel key, `deployment.environment` the legacy one the Tinybird
	// MVs still pre-extract. Emitting only one would hide UI bugs against the other.
	attr("deployment.environment.name", opts.env),
	attr("deployment.environment", opts.env),
	attr("deployment.commit_sha", sha),
]

/**
 * Same shape as `resourceAttrs`, minus the commit SHA (agent traces aren't a deploy
 * story) and on the agent service. `resourceExtra` is where a fixture puts a
 * RESOURCE-level `session.id` — the other map the AgentTraceId coalesce reads.
 */
const agentTraceResourceAttrs = (opts: Options, j: GeneratedAgentTrace): Record<string, unknown>[] => [
	attr("service.name", AGENT_TRACE_SERVICE),
	attr("deployment.environment.name", opts.env),
	attr("deployment.environment", opts.env),
	...j.resourceExtra,
]

const chunk = <T>(xs: T[], size: number): T[][] => {
	const out: T[][] = []
	for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
	return out
}

const postOtlp = async (opts: Options, path: string, body: unknown): Promise<void> => {
	let res: Response
	try {
		res = await fetch(`${opts.endpoint}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${opts.key}` },
			body: JSON.stringify(body),
		})
	} catch (err) {
		fail(
			`could not reach the ingest gateway at ${opts.endpoint}${path}: ${(err as Error).message}\n` +
				`  Is it running? Start the dev stack (\`bun dev\`) and make sure the otel-collector\n` +
				`  is up (it's the gateway's forward target on :4318). Or override with --endpoint.`,
		)
	}
	if (!res!.ok) {
		const text = await res!.text().catch(() => "")
		fail(`ingest gateway returned ${res!.status} ${res!.statusText} for ${path}: ${text.slice(0, 500)}`)
	}
}

const shortSha = (sha: string): string => (HEX40.test(sha) ? sha.slice(0, 7) : sha.slice(0, 10))

const summarize = (generated: GeneratedSha[], opts: Options): void => {
	const totalSpans = generated.reduce((n, g) => n + g.spans.length, 0)
	const totalLogs = generated.reduce((n, g) => n + g.logs.length, 0)
	const totalTraces = generated.reduce((n, g) => n + g.traceCount, 0)
	const totalErrors = generated.reduce((n, g) => n + g.errorCount, 0)

	console.log(`\n  service: ${opts.service}   env: ${opts.env}   endpoint: ${opts.endpoint}`)
	console.log(
		`  ${"commit".padEnd(12)} ${"when".padEnd(20)} ${"traces".padStart(6)} ${"spans".padStart(6)} ${"logs".padStart(5)} ${"err".padStart(4)}`,
	)
	for (const g of generated) {
		console.log(
			`  ${shortSha(g.sha).padEnd(12)} ${new Date(g.at).toISOString().slice(0, 19).replace("T", " ").padEnd(20)} ` +
				`${String(g.traceCount).padStart(6)} ${String(g.spans.length).padStart(6)} ${String(g.logs.length).padStart(5)} ${String(g.errorCount).padStart(4)}`,
		)
	}
	console.log(`  ${"─".repeat(58)}`)
	console.log(
		`  ${"total".padEnd(12)} ${"".padEnd(20)} ${String(totalTraces).padStart(6)} ${String(totalSpans).padStart(6)} ${String(totalLogs).padStart(5)} ${String(totalErrors).padStart(4)}`,
	)
}

const summarizeAgentTraces = (agentTraces: GeneratedAgentTrace[], opts: Options): void => {
	if (agentTraces.length === 0) return
	const totalSpans = agentTraces.reduce((n, j) => n + j.spans.length, 0)
	const totalLogs = agentTraces.reduce((n, j) => n + j.logs.length, 0)
	const totalTraces = agentTraces.reduce((n, j) => n + j.traceCount, 0)
	const totalErrors = agentTraces.reduce((n, j) => n + j.errorCount, 0)

	console.log(`\n  GenAI agent traces — service: ${AGENT_TRACE_SERVICE}   env: ${opts.env}`)
	console.log(
		`  ${"fixture".padEnd(26)} ${"when".padEnd(20)} ${"traces".padStart(6)} ${"spans".padStart(6)} ${"logs".padStart(5)} ${"err".padStart(4)}`,
	)
	for (const j of agentTraces) {
		console.log(
			`  ${j.fixture.padEnd(26)} ${new Date(j.startedAt).toISOString().slice(0, 19).replace("T", " ").padEnd(20)} ` +
				`${String(j.traceCount).padStart(6)} ${String(j.spans.length).padStart(6)} ${String(j.logs.length).padStart(5)} ${String(j.errorCount).padStart(4)}`,
		)
		console.log(`  ${"".padEnd(26)} ${j.note}`)
	}
	console.log(`  ${"─".repeat(72)}`)
	console.log(
		`  ${"total".padEnd(26)} ${"".padEnd(20)} ${String(totalTraces).padStart(6)} ${String(totalSpans).padStart(6)} ${String(totalLogs).padStart(5)} ${String(totalErrors).padStart(4)}`,
	)
}

/**
 * The bit a dev actually needs: the derived AgentTraceId per fixture, and the URL
 * to open it. Nothing links to the agent trace route yet — hand-built URLs are the
 * entry point.
 */
const printAgentTraceIds = (agentTraces: GeneratedAgentTrace[]): void => {
	if (agentTraces.length === 0) return
	// Nothing links to the agent trace route yet — these hand-built URLs are the entry point.
	console.log("\n  ── agent trace ids (open each at /agent-traces/<id>) ──")
	console.log(`  ${"fixture".padEnd(26)} ${"id from".padEnd(16)} id`)
	for (const j of agentTraces) {
		console.log(`  ${j.fixture.padEnd(26)} ${`${j.idKind} id`.padEnd(16)} ${j.id}`)
	}
	console.log("")
	for (const j of agentTraces) {
		console.log(`  https://web.localhost/agent-traces/${encodeURIComponent(j.id)}   # ${j.fixture}`)
	}
}

const HELP = `
ingest-dummy — push dummy OTLP traces + logs to the local ingest gateway

Usage: bun scripts/ingest-dummy.ts [options]

Target:
  --endpoint <url>        Ingest base URL          (default ${DEFAULT_ENDPOINT})
  --key <ingest-key>      Bearer ingest key        (default ${DEFAULT_KEY})

Shape:
  --service <name>        service.name             (default ${DEFAULT_SERVICE})
  --env <name>            deployment.environment   (default ${DEFAULT_ENV})
  --shas <a,b,c>          commit SHAs (40-hex resolve in the UI). Omit → recent git log.
  --num-shas <n>          how many recent commits to pull when --shas is omitted (default 3)
  --sha-interval <dur>    spacing between consecutive SHAs, s/m/h (default 10m)
  --traces-per-sha <N|A-B>  traces per SHA, fixed or range (default 3-9)
  --children <N|A-B>      child spans per trace    (default 1-3)
  --logs-per-trace <N|A-B>  correlated logs per trace (default 1-2)
  --error-rate <0..1>     fraction of traces that error (default 0.08)
  --spread <dur>          scatter window per SHA, s/m/h (default 90s)
  --anchor <when>         time of the newest SHA: "now" or ISO-8601 (default now)

GenAI agent traces (service "${AGENT_TRACE_SERVICE}"):
  --agent-traces <n>        emit the whole agent-trace fixture set n times (default 1;
                          0 or --no-agentTraces to skip). Fixtures: multi-turn-cumulative,
                          parallel-tools-one-failing, content-redacted, multi-model-switch,
                          agent-workflow-handoff, legacy-attribute-names, in-progress.
                          AgentTraces are scattered over the ~2h before --anchor (except
                          in-progress, which is anchored at it) and their ids are printed
                          at the end of the run.
  --no-agent-traces         skip the agent-trace fixtures entirely

Control:
  --seed <n>              seed the shape RNG for reproducible counts/latencies
  --dry-run               print the plan + a sample span, send nothing
  --quiet                 only print errors
  -h, --help
`

const main = async (): Promise<void> => {
	const { values } = parseArgs({
		options: {
			endpoint: { type: "string" },
			key: { type: "string" },
			service: { type: "string" },
			env: { type: "string" },
			shas: { type: "string" },
			"num-shas": { type: "string" },
			"sha-interval": { type: "string" },
			"traces-per-sha": { type: "string" },
			children: { type: "string" },
			"logs-per-trace": { type: "string" },
			"error-rate": { type: "string" },
			spread: { type: "string" },
			anchor: { type: "string" },
			"agent-traces": { type: "string" },
			"no-agent-traces": { type: "boolean" },
			seed: { type: "string" },
			"dry-run": { type: "boolean" },
			quiet: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: false,
	})

	if (values.help) {
		console.log(HELP)
		return
	}

	seedRng(values.seed ? Number(values.seed) : randomBytes(4).readUInt32LE() >>> 0)

	const numShas = values["num-shas"] ? Number(values["num-shas"]) : 3
	let shas: string[]
	if (values.shas) {
		shas = values.shas
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean)
	} else {
		shas = recentGitShas(numShas)
		if (shas.length === 0) {
			// No git history reachable — fabricate SHAs (won't resolve to commit messages).
			shas = Array.from({ length: numShas }, () => randomBytes(20).toString("hex"))
			console.warn("⚠ no git log available; using random SHAs (they won't resolve in the hover card)")
		}
	}
	if (shas.length === 0) fail("no commit SHAs to ingest")
	for (const s of shas) {
		if (!HEX40.test(s))
			console.warn(
				`⚠ "${shortSha(s)}" is not a 40-char hex SHA — it'll render as plain text, not a resolvable commit`,
			)
	}

	// Agent traces are on by default (one full fixture set); --agent traces 0 / --no-agent traces opt out.
	const agentTraceSets = values["no-agent-traces"] ? 0 : values["agent-traces"] ? Number(values["agent-traces"]) : 1
	if (!Number.isInteger(agentTraceSets) || agentTraceSets < 0)
		fail(`--agent-traces: expected a non-negative integer, got "${values["agent-traces"]}"`)

	const anchorRaw = values.anchor?.trim()
	const anchor = !anchorRaw || anchorRaw === "now" ? Date.now() : Date.parse(anchorRaw)
	if (Number.isNaN(anchor))
		fail(`--anchor: could not parse "${anchorRaw}" (use "now" or an ISO-8601 timestamp)`)

	const opts: Options = {
		endpoint: (values.endpoint?.trim() || DEFAULT_ENDPOINT).replace(/\/$/, ""),
		key: values.key?.trim() || DEFAULT_KEY,
		service: values.service?.trim() || DEFAULT_SERVICE,
		env: values.env?.trim() || DEFAULT_ENV,
		shas,
		shaInterval: parseDurationMs(values["sha-interval"] ?? "10m", "--sha-interval"),
		tracesPerSha: parseRange(values["traces-per-sha"] ?? "3-9", "--traces-per-sha"),
		children: parseRange(values.children ?? "1-3", "--children"),
		logsPerTrace: parseRange(values["logs-per-trace"] ?? "1-2", "--logs-per-trace"),
		errorRate: values["error-rate"] ? Number(values["error-rate"]) : 0.08,
		spread: parseDurationMs(values.spread ?? "90s", "--spread"),
		anchor,
		agentTraceSets,
		dryRun: Boolean(values["dry-run"]),
		quiet: Boolean(values.quiet),
	}

	// SHA i sits at anchor - (N-1-i)*interval, so the newest SHA lands on the anchor
	// and earlier ones march back in time.
	const generated = opts.shas.map((sha, i) =>
		generateForSha(sha, opts.anchor - (opts.shas.length - 1 - i) * opts.shaInterval, opts),
	)

	const agentTraces = generateAgentTraces(opts)

	if (!opts.quiet) {
		summarize(generated, opts)
		summarizeAgentTraces(agentTraces, opts)
	}

	if (opts.dryRun) {
		const sample = generated.find((g) => g.spans.length > 0)
		if (sample) {
			console.log("\n  ── sample resourceSpans (dry-run, nothing sent) ──")
			console.log(
				JSON.stringify(
					{
						resource: { attributes: resourceAttrs(opts, sample.sha) },
						scopeSpans: [{ scope: { name: "ingest-dummy" }, spans: sample.spans.slice(0, 4) }],
					},
					null,
					2,
				)
					.split("\n")
					.map((l) => `  ${l}`)
					.join("\n"),
			)
		}
		const agentTraceSample = agentTraces[0]
		if (agentTraceSample) {
			console.log(`\n  ── sample agent trace resourceSpans (${agentTraceSample.fixture}, dry-run) ──`)
			console.log(
				JSON.stringify(
					{
						resource: { attributes: agentTraceResourceAttrs(opts, agentTraceSample) },
						scopeSpans: [
							{
								scope: { name: "ingest-dummy-genai" },
								spans: agentTraceSample.spans.slice(0, 2),
							},
						],
					},
					null,
					2,
				)
					.split("\n")
					.map((l) => `  ${l}`)
					.join("\n"),
			)
		}
		if (!opts.quiet) printAgentTraceIds(agentTraces)
		console.log("\n  (dry run — re-run without --dry-run to send)\n")
		return
	}

	// Build + send trace requests, chunked by span count to stay under the body cap.
	let traceReqs = 0
	for (const g of generated) {
		if (g.spans.length === 0) continue
		for (const batch of chunk(g.spans, MAX_SPANS_PER_REQUEST)) {
			await postOtlp(opts, "/v1/traces", {
				resourceSpans: [
					{
						resource: { attributes: resourceAttrs(opts, g.sha) },
						scopeSpans: [{ scope: { name: "ingest-dummy" }, spans: batch }],
					},
				],
			})
			traceReqs++
		}
	}

	// Agent traces: one resourceSpans per agent trace — each carries its own resource map
	// (a fixture may put `session.id` there), so they can't share one.
	for (const j of agentTraces) {
		if (j.spans.length === 0) continue
		for (const batch of chunk(j.spans, MAX_SPANS_PER_REQUEST)) {
			await postOtlp(opts, "/v1/traces", {
				resourceSpans: [
					{
						resource: { attributes: agentTraceResourceAttrs(opts, j) },
						scopeSpans: [{ scope: { name: "ingest-dummy-genai" }, spans: batch }],
					},
				],
			})
			traceReqs++
		}
	}

	// Logs: one request carrying all SHAs' resourceLogs (logs are small).
	const resourceLogs = generated
		.filter((g) => g.logs.length > 0)
		.map((g) => ({
			resource: { attributes: resourceAttrs(opts, g.sha) },
			scopeLogs: [{ scope: { name: "ingest-dummy" }, logRecords: g.logs }],
		}))
		.concat(
			agentTraces
				.filter((j) => j.logs.length > 0)
				.map((j) => ({
					resource: { attributes: agentTraceResourceAttrs(opts, j) },
					scopeLogs: [{ scope: { name: "ingest-dummy-genai" }, logRecords: j.logs }],
				})),
		)
	if (resourceLogs.length > 0) await postOtlp(opts, "/v1/logs", { resourceLogs })

	if (!opts.quiet) {
		const totalSpans =
			generated.reduce((n, g) => n + g.spans.length, 0) + agentTraces.reduce((n, j) => n + j.spans.length, 0)
		const totalLogs =
			generated.reduce((n, g) => n + g.logs.length, 0) + agentTraces.reduce((n, j) => n + j.logs.length, 0)
		console.log(
			`\n✓ sent ${totalSpans} spans (${traceReqs} request(s)) + ${totalLogs} logs to ${opts.endpoint}`,
		)
		console.log(
			`  View at https://web.localhost → service "${opts.service}" (last ~${Math.ceil((opts.shaInterval * (opts.shas.length - 1) + opts.spread) / 60000)}m).`,
		)
		console.log("  Data lands async via the collector → Tinybird; give it a few seconds to appear.\n")
		printAgentTraceIds(agentTraces)
		if (agentTraces.length > 0) console.log("")
	}
}

main().catch((err) => fail((err as Error).stack ?? String(err)))
