// A synthetic agent session for `/lab/agent-session`.
//
// Built to exercise the shapes the views have to survive rather than to look
// tidy: fourteen turns so the Overview's digest elides its middle, idle gaps of
// wildly different lengths, two models, five tools, per-call usage and cost, a
// sub-agent handoff, and a final turn that dies on a context-window error
// reported at two levels — the roll-up the counting rules exist for. Three more
// turns after those carry what the Transcript view needs and the fourteen do
// not produce (see `buildTranscriptTurns`).

import type { AiSessionGenAiValues, AiSessionSpan } from "@maple/domain/http"

import { spanStartMs } from "@/lib/agent-sessions/session-turns"
import { agentSpan, llmSpan, T0, toolSpan, userMessages } from "@/lib/agent-sessions/span-test-support"

const SECOND = 1000
const MINUTE = 60 * SECOND

interface TurnPlan {
	readonly prompt: string
	/** Milliseconds of nothing before this turn — the human reading the answer. */
	readonly idleBeforeMs: number
	readonly model: string
	readonly llmCalls: number
	readonly tools: readonly string[]
	readonly agent?: string
}

const TURNS: readonly TurnPlan[] = [
	{
		prompt: "fix the webhook retry backoff — duplicate charges on Stripe retries",
		idleBeforeMs: 0,
		model: "claude-opus-5",
		llmCalls: 2,
		tools: ["read_file", "grep_repo", "run_tests"],
	},
	{
		prompt: "the jitter looks wrong, check the spec again",
		idleBeforeMs: 90 * SECOND,
		model: "claude-opus-5",
		llmCalls: 2,
		tools: ["read_file"],
	},
	{
		prompt: "run the integration suite against the staging webhook",
		idleBeforeMs: 3 * MINUTE,
		model: "claude-haiku-4-5",
		llmCalls: 1,
		tools: ["run_tests", "run_tests", "read_file", "grep_repo"],
	},
	{
		prompt: "why is the backoff still 30s? read the config",
		idleBeforeMs: 40 * SECOND,
		model: "claude-opus-5",
		llmCalls: 1,
		tools: ["read_file", "read_file"],
	},
	{
		prompt: "add a regression test for the duplicate-charge case",
		idleBeforeMs: 25 * SECOND,
		model: "claude-opus-5",
		llmCalls: 3,
		tools: ["write_file", "run_tests", "run_tests"],
	},
	{
		prompt: "now do the same for the refund path",
		idleBeforeMs: 2 * MINUTE,
		model: "claude-opus-5",
		llmCalls: 2,
		tools: ["write_file", "git_diff"],
	},
	{
		prompt: "the diff has a stray console.log",
		idleBeforeMs: 35 * SECOND,
		model: "claude-haiku-4-5",
		llmCalls: 1,
		tools: ["read_file", "write_file"],
	},
	{
		prompt: "rebase onto main and re-run",
		idleBeforeMs: 70 * SECOND,
		model: "claude-opus-5",
		llmCalls: 2,
		tools: ["git_diff", "run_tests"],
	},
	{
		prompt: "still failing on the idempotency key test",
		idleBeforeMs: 45 * SECOND,
		model: "claude-opus-5",
		llmCalls: 2,
		tools: ["read_file", "grep_repo", "run_tests"],
	},
	{
		prompt: "print the key we generate for a retried charge",
		idleBeforeMs: 30 * SECOND,
		model: "claude-opus-5",
		llmCalls: 1,
		tools: ["read_file"],
	},
	{
		prompt: "that key is derived from the attempt number — it shouldn't be",
		idleBeforeMs: 55 * SECOND,
		model: "claude-opus-5",
		llmCalls: 2,
		tools: ["write_file", "run_tests"],
	},
	{
		prompt: "good. now check nothing else derives keys that way",
		idleBeforeMs: 80 * SECOND,
		model: "claude-opus-5",
		llmCalls: 1,
		tools: ["grep_repo", "grep_repo"],
	},
	{
		prompt: "write it up in the PR description",
		idleBeforeMs: 50 * SECOND,
		model: "claude-haiku-4-5",
		llmCalls: 1,
		tools: ["git_diff"],
	},
	{
		prompt: "just run the whole suite",
		idleBeforeMs: 4 * MINUTE + 8 * SECOND,
		model: "claude-opus-5",
		llmCalls: 3,
		tools: ["run_tests", "run_tests"],
		agent: "test-runner",
	},
]

const CONTEXT_ERROR = "prompt is too long: 214832 tokens > 200000 maximum"

/**
 * One model call's attributes: usage that grows with the conversation the way a
 * real context window does, plus the things only some calls carry — the
 * failure, the prompt (captured once per turn, on its opening call), and the
 * response the call produced, with a `tool_call` part when a tool follows it.
 */
function callAttributes(input: {
	turnIndex: number
	callIndex: number
	failed: boolean
	prompt: string | undefined
	/** Tool this call dispatches, as a `tool_call` part of its output message. */
	tool: string | undefined
}) {
	const history = 6_000 + input.turnIndex * 14_000 + input.callIndex * 2_500
	return {
		usageInputTokens: history,
		usageCacheReadInputTokens: Math.round(history * 0.86),
		usageCacheCreationInputTokens: input.callIndex === 0 ? 7_000 : 0,
		usageOutputTokens: 900 + input.callIndex * 220,
		usageReasoningOutputTokens: input.turnIndex % 3 === 0 ? 480 : 0,
		usageCost: 0.11 + input.turnIndex * 0.02 + input.callIndex * 0.04,
		errorType: input.failed ? "context_length_exceeded" : undefined,
		inputMessages: input.prompt === undefined ? undefined : userMessages(input.prompt),
		outputMessages: input.failed
			? undefined
			: [
					{
						role: "assistant",
						parts: [
							{
								type: "text",
								content:
									"I'll read the retry handler before changing anything — the fixed delay is only half the story, the idempotency key is what decides whether a duplicate delivery is charged twice.",
							},
							...(input.tool === undefined
								? []
								: [
										{
											type: "tool_call",
											id: `toolu_${input.turnIndex}_${input.callIndex}`,
											name: input.tool,
											arguments: toolArguments(input.tool),
										},
									]),
						],
					},
				],
		responseFinishReasons: input.failed ? undefined : input.tool === undefined ? ["stop"] : ["tool_use"],
	} satisfies AiSessionGenAiValues
}

/** Arguments shaped like the tool would really take, so the expansion's
 *  payload cards render something worth eyeballing. */
function toolArguments(tool: string): Record<string, unknown> {
	switch (tool) {
		case "read_file":
			return { path: "src/webhooks/retry.ts", start_line: 1, end_line: 120 }
		case "grep_repo":
			return { pattern: "backoff", glob: "src/**/*.ts" }
		case "write_file":
			return { path: "src/webhooks/retry.ts", content: "…" }
		case "run_tests":
			return { suite: "webhooks", watch: false }
		case "git_diff":
			return { base: "main" }
		default:
			return { tool }
	}
}

function toolResult(tool: string): string | undefined {
	switch (tool) {
		case "read_file":
			return "export const RETRY_DELAY_MS = 30_000 // fixed, no jitter\n…120 lines…"
		case "grep_repo":
			return "41 matches in 12 files"
		case "write_file":
			return "wrote 132 lines"
		case "run_tests":
			return "412 passed · 0 failed"
		case "git_diff":
			return "2 files changed, +31 −14"
		default:
			return undefined
	}
}

export function buildAgentSessionFixture(): readonly AiSessionSpan[] {
	const base = buildBaseTurns()
	const baseEndMs = Math.max(...base.map((span) => spanStartMs(span) + span.durationMs)) - T0
	return [...base, ...buildTranscriptTurns(baseEndMs + 2 * MINUTE)].sort(
		(a, b) => spanStartMs(a) - spanStartMs(b),
	)
}

/**
 * The same session with every captured-content attribute stripped — the COMMON
 * case in production, where message capture is opt-in and off. The transcript
 * has to stay readable as pure structure, so the lab can switch to it.
 */
export function buildCaptureOffFixture(): readonly AiSessionSpan[] {
	return buildAgentSessionFixture().map((span) => ({
		...span,
		genAi: {
			...span.genAi,
			systemInstructions: undefined,
			inputMessages: undefined,
			outputMessages: undefined,
			toolCallArguments: undefined,
			toolCallResult: undefined,
		},
	}))
}

function buildBaseTurns(): readonly AiSessionSpan[] {
	const spans: AiSessionSpan[] = []
	let cursor = 0

	TURNS.forEach((plan, index) => {
		cursor += plan.idleBeforeMs
		const failing = index === TURNS.length - 1
		const turnStart = cursor
		const agentId = `agent-${index}`
		let offset = 0

		for (let call = 0; call < plan.llmCalls; call++) {
			const failedCall = failing && call === plan.llmCalls - 1
			spans.push(
				llmSpan({
					spanId: `${agentId}-llm-${call}`,
					parentSpanId: agentId,
					traceId: `trace-${index}`,
					startMs: turnStart + offset,
					durationMs: 4 * SECOND + call * SECOND,
					spanName: `chat ${plan.model}`,
					model: plan.model,
					ttftSeconds: 0.9 + call * 0.2,
					statusCode: failedCall ? "Error" : undefined,
					statusMessage: failedCall ? CONTEXT_ERROR : undefined,
					genAi: callAttributes({
						turnIndex: index,
						callIndex: call,
						failed: failedCall,
						// Only the opening call of a turn carries it, exactly as a
						// framework that captures messages once per turn emits them.
						prompt: call === 0 ? plan.prompt : undefined,
						tool: plan.tools[call],
					}),
				}),
			)
			offset += 5 * SECOND + call * SECOND

			const tool = plan.tools[call]
			if (tool !== undefined) {
				const failedTool = failing && tool === "run_tests" && call === 0
				spans.push(
					toolSpan({
						spanId: `${agentId}-tool-${call}`,
						parentSpanId: agentId,
						traceId: `trace-${index}`,
						startMs: turnStart + offset,
						durationMs: tool === "run_tests" ? 9 * SECOND : 2 * SECOND,
						toolName: tool,
						statusCode: failedTool ? "Error" : undefined,
						statusMessage: failedTool ? "exit 1" : undefined,
						genAi: {
							toolCallId: `toolu_${index}_${call}`,
							toolCallArguments: toolArguments(tool),
							toolCallResult: failedTool ? "exit 1 · 2 failing" : toolResult(tool),
							errorType: failedTool ? "tool_error" : undefined,
						},
					}),
				)
				offset += (tool === "run_tests" ? 9 : 2) * SECOND + SECOND
			}
		}

		// Tools past the calls that triggered them, so a turn can run more tools
		// than model calls.
		plan.tools.slice(plan.llmCalls).forEach((tool, extra) => {
			spans.push(
				toolSpan({
					spanId: `${agentId}-tool-extra-${extra}`,
					parentSpanId: agentId,
					traceId: `trace-${index}`,
					startMs: turnStart + offset,
					durationMs: tool === "run_tests" ? 7 * SECOND : 2 * SECOND,
					toolName: tool,
				}),
			)
			offset += (tool === "run_tests" ? 7 : 2) * SECOND + SECOND
		})

		// The agent span last so it can span everything under it; the list is
		// re-sorted by start time on the way out.
		spans.push(
			agentSpan({
				spanId: agentId,
				traceId: `trace-${index}`,
				startMs: turnStart,
				durationMs: offset,
				agentName: plan.agent ?? "billing-agent",
				statusCode: failing ? "Error" : undefined,
				statusMessage: failing ? CONTEXT_ERROR : undefined,
				genAi: failing ? { errorType: "context_length_exceeded" } : undefined,
			}),
		)

		// One rate-limited retry in the failing turn, so the verdict has earlier
		// failures to count in the same turn.
		if (failing) {
			for (const retry of [0, 1]) {
				spans.push(
					llmSpan({
						spanId: `${agentId}-retry-${retry}`,
						parentSpanId: agentId,
						traceId: `trace-${index}`,
						startMs: turnStart + 2 * SECOND + retry * SECOND,
						durationMs: 400,
						spanName: `chat ${plan.model}`,
						model: plan.model,
						statusCode: "Error",
						statusMessage: "429 Too Many Requests",
						genAi: { errorType: "rate_limit" },
					}),
				)
			}
		}

		cursor = turnStart + offset
	})

	return spans
}

/* -------------------------------------------------------------------------- */
/* Transcript turns                                                           */
/* -------------------------------------------------------------------------- */

// Three turns the Transcript view exists for, and which the fourteen above do
// not produce: a fan-out into two lanes that genuinely overlap, a sub-agent
// invoked through a `task` tool, reasoning parts in all their spellings, a
// result the emitter truncated, a result nothing ever captured, one echoed back
// through a later call's history, a turn with no captured content at all, a
// turn whose capture changes emitter mid-way, and a compaction.

const INVESTIGATION_SYSTEM =
	"You are the Maple investigation planner. You have read-only access to this org's traces, logs and metrics. Prefer evidence from spans over inference from code. Never state a cause you cannot point at a query for."

const INVESTIGATION_PROMPT =
	"p95 checkout latency tripled after the 14:20 deploy — find what changed. Don't guess from the deploy diff, read the traces."

/** A wide result: the transcript has to clamp it and offer the whole thing. */
function p95Rows(): string {
	const header = "t                     p95_ms    calls"
	const rows = Array.from({ length: 62 }, (_, index) => {
		const minute = String(index % 60).padStart(2, "0")
		const p95 = index < 20 ? 410 + index * 2 : 1180 + index * 3
		return `2026-08-25 14:${minute}:00${String(p95.toFixed(1)).padStart(11)}${String(18_000 + index * 7).padStart(9)}`
	})
	return [header, ...rows].join("\n")
}

/** `{ truncated, prefix }` — the emitter cut this off at 8 KB, not Maple. */
const TRUNCATED_STATEMENT_RESULT = {
	truncated: true,
	prefix: [
		"stmt                                              calls    p95_ms",
		"SELECT … FROM carts WHERE session_id = ?          18420     903.4",
		"SELECT … FROM inventory_holds WHERE sku IN (?)     9330     441.1",
		"UPDATE carts SET updated_at = ? WHERE id = ?      18402      12.7",
	].join("\n"),
}

function usage(input: number, output: number, cost: number, reasoning = 0) {
	return {
		usageInputTokens: input,
		usageCacheReadInputTokens: Math.round(input * 0.8),
		usageOutputTokens: output,
		usageReasoningOutputTokens: reasoning,
		usageCost: cost,
	} satisfies AiSessionGenAiValues
}

function assistantText(content: string) {
	return [{ role: "assistant", parts: [{ type: "text", content }] }]
}

function buildTranscriptTurns(startMs: number): readonly AiSessionSpan[] {
	return [
		...richTurn(startMs),
		...captureOffTurn(startMs + 3 * MINUTE),
		...mixedCaptureTurn(startMs + 5 * MINUTE),
	]
}

/**
 * The rich turn: planner-agent fans out into two lanes that overlap in time,
 * one of which delegates to a sub-agent through a `task` tool.
 *
 * The lanes carry their own trace ids while keeping the planner's span as their
 * parent — the shape a fan-out takes when the dispatch crosses a queue and the
 * runtime starts a new trace but propagates the parent span id.
 */
function richTurn(t: number): readonly AiSessionSpan[] {
	const history = [
		{ role: "system", parts: [{ type: "text", content: INVESTIGATION_SYSTEM }] },
		{ role: "user", parts: [{ type: "text", content: "which services are in the checkout path?" }] },
		{ role: "assistant", parts: [{ type: "text", content: "checkout-api, carts, inventory-holds." }] },
		{ role: "user", parts: [{ type: "text", content: INVESTIGATION_PROMPT }] },
	]

	return [
		agentSpan({
			spanId: "inv-agent",
			traceId: "trace-inv",
			startMs: t,
			durationMs: 64 * SECOND,
			agentName: "planner-agent",
		}),
		llmSpan({
			spanId: "inv-l1",
			parentSpanId: "inv-agent",
			traceId: "trace-inv",
			startMs: t,
			durationMs: 3 * SECOND,
			spanName: "chat claude-opus-5",
			model: "claude-opus-5",
			ttftSeconds: 0.78,
			genAi: {
				...usage(6_400, 512, 0.11),
				systemInstructions: INVESTIGATION_SYSTEM,
				inputMessages: history,
				outputMessages: assistantText(
					"I'll take the service level first: compare p95 for checkout-api either side of the deploy boundary, then fan out to whichever dependency actually moved. If the step is a clean edge at 14:20 it's the release; if it ramps, it's load.",
				),
				responseFinishReasons: ["tool_use"],
			},
		}),
		toolSpan({
			spanId: "inv-t1",
			parentSpanId: "inv-agent",
			traceId: "trace-inv",
			startMs: t + 3 * SECOND,
			durationMs: 1_420,
			serviceName: "warehouse-mcp",
			toolName: "run_sql",
			genAi: {
				toolCallId: "toolu_01H7qP",
				toolCallArguments: {
					sql: "SELECT toStartOfMinute(Timestamp) AS t, quantile(0.95)(Duration)/1e6 AS p95_ms\n  FROM traces\n WHERE ServiceName = 'checkout-api' AND SpanKind = 'Server'\n   AND Timestamp BETWEEN '2026-08-25 13:50:00' AND '2026-08-25 14:50:00'\n GROUP BY t ORDER BY t",
					max_rows: 120,
				},
				toolCallResult: p95Rows(),
			},
		}),
		llmSpan({
			spanId: "inv-l2",
			parentSpanId: "inv-agent",
			traceId: "trace-inv",
			startMs: t + 5 * SECOND,
			durationMs: 4 * SECOND,
			spanName: "chat claude-opus-5",
			model: "claude-opus-5",
			ttftSeconds: 0.91,
			genAi: {
				...usage(21_800, 340, 0.24, 612),
				// The same instructions the first call sent: the transcript shows
				// them once and says how many calls re-sent them.
				systemInstructions: INVESTIGATION_SYSTEM,
				outputMessages: [
					{
						role: "assistant",
						parts: [
							{
								type: "thinking",
								thinking:
									"A clean step at exactly 14:20 with flat call volume rules out load. Two independent questions follow and neither blocks the other, so they can run side by side.",
							},
							{
								type: "text",
								content:
									"Clean edge at 14:20 and it holds — that's the release, not load. Two independent questions from here, so I'll run them side by side: what the release changed in the database path, and whether the extra 800ms sits inside one span or is spread across retries.",
							},
						],
					},
				],
				responseFinishReasons: ["tool_use"],
			},
		}),

		// Lane 1 — db-lane, its own trace, overlapping lane 2.
		agentSpan({
			spanId: "db-agent",
			parentSpanId: "inv-agent",
			traceId: "trace-db",
			startMs: t + 10 * SECOND,
			durationMs: 41 * SECOND,
			agentName: "db-lane",
		}),
		llmSpan({
			spanId: "db-l1",
			parentSpanId: "db-agent",
			traceId: "trace-db",
			startMs: t + 11 * SECOND,
			durationMs: 2 * SECOND,
			spanName: "chat claude-haiku-4-5",
			model: "claude-haiku-4-5",
			ttftSeconds: 0.34,
			genAi: {
				...usage(3_100, 288, 0.01),
				outputMessages: assistantText(
					"Pulling the DB child spans under checkout-api for the same window, grouped by statement, so a new or newly-slow query shows up as its own row rather than as aggregate latency.",
				),
				responseFinishReasons: ["tool_use"],
			},
		}),
		toolSpan({
			spanId: "db-t1",
			parentSpanId: "db-agent",
			traceId: "trace-db",
			startMs: t + 14 * SECOND,
			durationMs: 6_800,
			serviceName: "warehouse-mcp",
			toolName: "run_sql",
			genAi: {
				toolCallId: "toolu_01Kd3W",
				toolCallArguments: {
					sql: "SELECT SpanAttributes['db.query.summary'] AS stmt, count() AS calls,\n       quantile(0.95)(Duration)/1e6 AS p95_ms\n  FROM trace_detail_spans WHERE ParentServiceName = 'checkout-api'\n   AND SpanKind = 'Client' GROUP BY stmt ORDER BY p95_ms DESC",
				},
				toolCallResult: TRUNCATED_STATEMENT_RESULT,
			},
		}),
		// The delegation pair Maple emits: one `task` tool call, one invocation.
		toolSpan({
			spanId: "db-task",
			parentSpanId: "db-agent",
			traceId: "trace-db",
			startMs: t + 22 * SECOND,
			durationMs: 12 * SECOND,
			toolName: "task",
			genAi: { toolCallId: "toolu_01Task", toolCallArguments: { agent: "sql-verifier" } },
		}),
		agentSpan({
			spanId: "sub-agent",
			parentSpanId: "db-task",
			traceId: "trace-db",
			startMs: t + 22 * SECOND,
			durationMs: 11_900,
			agentName: "sql-verifier",
		}),
		llmSpan({
			spanId: "sub-l1",
			parentSpanId: "sub-agent",
			traceId: "trace-db",
			startMs: t + 23 * SECOND,
			durationMs: 1_500,
			spanName: "chat claude-haiku-4-5",
			model: "claude-haiku-4-5",
			ttftSeconds: 0.26,
			genAi: {
				...usage(1_000, 176, 0.01),
				outputMessages: assistantText(
					"The carts lookup is the outlier. Checking whether it was already this slow before the deploy, so we don't blame a query that was always the top row.",
				),
				responseFinishReasons: ["tool_use"],
			},
		}),
		// No result on the tool span itself — it is echoed back into the next
		// call's input history instead, which is where the transcript finds it.
		toolSpan({
			spanId: "sub-t1",
			parentSpanId: "sub-agent",
			traceId: "trace-db",
			startMs: t + 25 * SECOND,
			durationMs: 2_710,
			serviceName: "warehouse-mcp",
			toolName: "run_sql",
			genAi: {
				toolCallId: "toolu_01Sub1",
				toolCallArguments: { sql: "SELECT … WHERE Timestamp < '2026-08-25 14:20:00'", max_rows: 20 },
			},
		}),
		llmSpan({
			spanId: "sub-l2",
			parentSpanId: "sub-agent",
			traceId: "trace-db",
			startMs: t + 29 * SECOND,
			durationMs: 1_200,
			spanName: "chat claude-haiku-4-5",
			model: "claude-haiku-4-5",
			genAi: {
				...usage(2_400, 96, 0.01),
				inputMessages: [
					{
						role: "tool",
						parts: [
							{
								type: "tool_call_response",
								id: "toolu_01Sub1",
								result: "stmt                                    p95_ms\nSELECT … FROM carts WHERE session_id = ?   41.2",
							},
						],
					},
				],
				outputMessages: assistantText(
					"41ms p95 before 14:20 against 903ms after, at unchanged call volume. Same statement, same traffic — that is a plan change, not load.",
				),
				responseFinishReasons: ["end_turn"],
			},
		}),

		// Lane 2 — trace-lane, its own trace, running at the same time as lane 1.
		agentSpan({
			spanId: "tr-agent",
			parentSpanId: "inv-agent",
			traceId: "trace-tr",
			startMs: t + 10_500,
			durationMs: 40 * SECOND,
			agentName: "trace-lane",
		}),
		llmSpan({
			spanId: "tr-l1",
			parentSpanId: "tr-agent",
			traceId: "trace-tr",
			startMs: t + 11_500,
			durationMs: 2 * SECOND,
			spanName: "chat claude-haiku-4-5",
			model: "claude-haiku-4-5",
			ttftSeconds: 0.3,
			genAi: {
				...usage(2_800, 204, 0.01),
				outputMessages: assistantText(
					"Taking the single worst trace after the deploy and reading its span tree end to end — if the time is one span it's a slow call, if it's several short ones it's retries.",
				),
				responseFinishReasons: ["tool_use"],
			},
		}),
		// Nothing in the session ever reports this call's result.
		toolSpan({
			spanId: "tr-t1",
			parentSpanId: "tr-agent",
			traceId: "trace-tr",
			startMs: t + 14 * SECOND,
			durationMs: 3_060,
			serviceName: "maple-mcp",
			toolName: "inspect_trace",
			genAi: {
				toolCallId: "toolu_01Rm9F",
				toolCallArguments: {
					trace_id: "3f0c9d61a48b7e2255ad",
					include_attributes: true,
					max_depth: 6,
				},
			},
		}),

		llmSpan({
			spanId: "inv-l3",
			parentSpanId: "inv-agent",
			traceId: "trace-inv",
			startMs: t + 55 * SECOND,
			durationMs: 6 * SECOND,
			spanName: "chat claude-opus-5",
			model: "claude-opus-5",
			ttftSeconds: 1.02,
			genAi: {
				...usage(34_600, 486, 0.39, 1_204),
				outputMessages: [
					{
						role: "assistant",
						parts: [
							{
								type: "reasoning",
								content:
									"Both lanes point at the carts read, but they disagree about the shape. db-lane has p95 903ms on one statement; trace-lane's single trace never returned a result so I only have its argument list, not its findings. I should not treat the trace-side branch as corroboration.",
							},
							{ type: "redacted_thinking", data: "EroBCkYIBRgCKkBq…" },
							{
								type: "text",
								content:
									"The regression is the cart lookup: SELECT … FROM carts WHERE session_id = ? went from 41ms p95 before 14:20 to 903ms after, at unchanged call volume (18,420 calls). Same statement, same traffic, 22× the latency — that's a plan change, not load. The trace-side branch didn't return anything usable, so this rests on the warehouse numbers alone.",
							},
						],
					},
				],
				responseFinishReasons: ["end_turn"],
			},
		}),
	]
}

/** A turn whose emitter captures no message content at all — the common case. */
function captureOffTurn(t: number): readonly AiSessionSpan[] {
	return [
		agentSpan({
			spanId: "cap-agent",
			traceId: "trace-cap",
			startMs: t,
			durationMs: 28 * SECOND,
			agentName: "reindex-agent",
			serviceName: "search-index",
		}),
		llmSpan({
			spanId: "cap-l1",
			parentSpanId: "cap-agent",
			traceId: "trace-cap",
			startMs: t + SECOND,
			durationMs: 2_140,
			spanName: "chat gpt-5",
			model: "gpt-5",
			ttftSeconds: 0.41,
			serviceName: "search-index",
			genAi: { ...usage(1_200, 300, 0.02), responseFinishReasons: ["tool_use"] },
		}),
		toolSpan({
			spanId: "cap-t1",
			parentSpanId: "cap-agent",
			traceId: "trace-cap",
			startMs: t + 4 * SECOND,
			durationMs: 420,
			serviceName: "search-index-mcp",
			toolName: "list_shards",
		}),
		toolSpan({
			spanId: "cap-t2",
			parentSpanId: "cap-agent",
			traceId: "trace-cap",
			startMs: t + 6 * SECOND,
			durationMs: 9_020,
			serviceName: "search-index-mcp",
			toolName: "reindex_shard",
			statusCode: "Error",
			statusMessage: "shard 3 is locked by a running merge",
			genAi: { errorType: "SHARD_LOCKED" },
		}),
		llmSpan({
			spanId: "cap-l2",
			parentSpanId: "cap-agent",
			traceId: "trace-cap",
			startMs: t + 18 * SECOND,
			durationMs: 3_100,
			spanName: "chat gpt-5",
			model: "gpt-5",
			ttftSeconds: 0.52,
			serviceName: "search-index",
			genAi: { ...usage(4_400, 420, 0.06), responseFinishReasons: ["end_turn"] },
		}),
	]
}

/** A turn that starts captured, hands off to an emitter that records prompts
 *  but not replies, and compacts its history on the way out. */
function mixedCaptureTurn(t: number): readonly AiSessionSpan[] {
	return [
		agentSpan({
			spanId: "mix-agent",
			traceId: "trace-mix",
			startMs: t,
			durationMs: 20 * SECOND,
			agentName: "reindex-agent",
			serviceName: "search-index",
		}),
		llmSpan({
			spanId: "mix-l1",
			parentSpanId: "mix-agent",
			traceId: "trace-mix",
			startMs: t,
			durationMs: 2_600,
			spanName: "chat claude-sonnet-5",
			model: "claude-sonnet-5",
			ttftSeconds: 0.47,
			serviceName: "search-index",
			genAi: {
				...usage(5_200, 264, 0.04),
				inputMessages: userMessages(
					"retry shard 3 with the lock timeout raised, and tell me what the search-service side is doing while it runs",
				),
				outputMessages: assistantText(
					"Raising lock_timeout to 120s and re-running shard 3. I'll hand the progress question to search-service so its own summariser answers from the index side rather than me guessing from the tool output.",
				),
				responseFinishReasons: ["tool_use"],
			},
		}),
		// A different emitter: it records `gen_ai.input.messages` and nothing else.
		llmSpan({
			spanId: "mix-l2",
			parentSpanId: "mix-agent",
			traceId: "trace-mix",
			startMs: t + 8 * SECOND,
			durationMs: 1_620,
			spanName: "chat gpt-5-mini",
			model: "gpt-5-mini",
			ttftSeconds: 0.29,
			serviceName: "search-service",
			genAi: {
				...usage(3_400, 148, 0.01),
				inputMessages: [
					{
						role: "user",
						parts: [
							{
								type: "text",
								content:
									"Summarise reindex progress for shard 3 in one sentence. Use only the counters given; do not estimate a completion time.",
							},
						],
					},
				],
				responseFinishReasons: ["stop"],
			},
		}),
		toolSpan({
			spanId: "mix-t1",
			parentSpanId: "mix-agent",
			traceId: "trace-mix",
			startMs: t + 11 * SECOND,
			durationMs: 280,
			serviceName: "search-service",
			toolName: "fetch_shard_progress",
		}),
		llmSpan({
			spanId: "mix-l3",
			parentSpanId: "mix-agent",
			traceId: "trace-mix",
			startMs: t + 14 * SECOND,
			durationMs: 3_100,
			spanName: "chat claude-sonnet-5",
			model: "claude-sonnet-5",
			ttftSeconds: 0.51,
			serviceName: "search-index",
			genAi: {
				...usage(12_700, 512, 0.19),
				conversationCompacted: true,
				outputMessages: assistantText(
					"Shard 3 is at 61% with the raised timeout and no lock contention since the retry. I've replaced the earlier tool dumps with this summary to keep the window open.",
				),
				responseFinishReasons: ["end_turn"],
			},
		}),
	]
}
