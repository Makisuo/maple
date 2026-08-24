// A synthetic agent session for `/lab/agent-session`.
//
// Built to exercise the shapes the three views have to survive rather than to
// look tidy: fourteen turns so the Overview's digest elides its middle, idle
// gaps of wildly different lengths, two models, five tools, per-call usage and
// cost, a sub-agent handoff, and a final turn that dies on a context-window
// error reported at two levels — the roll-up the counting rules exist for.

import type { AiSessionGenAiValues, AiSessionSpan } from "@maple/domain/http"

import { spanStartMs } from "@/lib/agent-sessions/session-turns"
import { agentSpan, llmSpan, toolSpan, userMessages } from "@/lib/agent-sessions/span-test-support"

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

	return spans.sort((a, b) => spanStartMs(a) - spanStartMs(b))
}
