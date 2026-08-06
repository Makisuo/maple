/**
 * The multi-turn tool loop, shared by every headless agent pass.
 *
 * `ToolRuntime` deliberately exports only `dispatch` for a single call, so the
 * loop around it has to live somewhere. It lived inside `runTriageAgent` until
 * the fan-out needed the same turns with a different prompt, a narrower tool
 * allowlist and a deadline — three parameters, not three copies.
 *
 * This is the *headless* loop: no transcript, no approvals, no sub-agents. The
 * attended chat turn is `chat/loop/turn.ts` and is a different problem — it has a
 * user in it. What the two share is the context-window policy, imported from
 * there rather than reimplemented, because a lens pass runs twelve steps of
 * warehouse-sized tool payloads with nobody watching it stall.
 *
 * What stays out of here: the final structured answer. Each caller forces its
 * own `generateObject` against its own schema (a triage pass produces an
 * `AiTriageResult`, a lens produces a `LensCandidate`), and folding that in
 * would mean this module knew about both.
 */
import { LLM, LLMEvent, Message, ToolResultPart, type LLMRequest, type Model, type Usage } from "@maple/llm"
import { ToolRuntime, toDefinitions } from "@maple/llm"
import { Effect } from "effect"
import { contextLimitOf, outputLimitOf, toLlmCallError } from "@/platform/Llm"
import { buildMapleTools } from "@/mcp/tools/llm-tools"
import { isNearContextLimit, pruneToolResults } from "@/chat/loop"
import type { TenantContext } from "@/services/auth/tenant-context"

/** Fan-out cap for tool calls issued in the same assistant turn. */
const TOOL_CONCURRENCY = 4

export interface TokenUsage {
	readonly input: number
	readonly output: number
	readonly cacheRead: number
}

export const emptyUsage: TokenUsage = { input: 0, output: 0, cacheRead: 0 }

export const addUsage = (total: TokenUsage, usage: Usage | undefined): TokenUsage => ({
	input: total.input + (usage?.inputTokens ?? 0),
	output: total.output + (usage?.outputTokens ?? 0),
	cacheRead: total.cacheRead + (usage?.cacheReadInputTokens ?? 0),
})

export interface ToolLoopInput {
	/** Correlation id for the LLM call, surfaced to the provider for tracing. */
	readonly id: string
	readonly system: string
	readonly prompt: string
	readonly model: Model
	readonly tenant: TenantContext
	/** Read-only allowlist. Nothing here is approval-gated: these loops are autonomous. */
	readonly toolNames: ReadonlySet<string>
	readonly maxToolSteps: number
	/**
	 * Wall-clock budget, checked between turns. Past it the loop stops gathering
	 * and hands back what it has, so the caller can still force a structured
	 * answer from partial evidence rather than returning nothing.
	 *
	 * Omit for no deadline. Never derive this inside a Cloudflare Workflow body —
	 * a `Date.now()` there differs on every replay and invalidates cached steps.
	 */
	readonly deadlineAtMs?: number
	/** Span/error label, e.g. `"ai-triage.investigate"`. */
	readonly label: string
}

export interface ToolLoopOutput {
	/** The full transcript, ready to feed a forced `generateObject`. */
	readonly messages: LLMRequest["messages"]
	readonly usage: TokenUsage
	readonly toolSteps: number
	/** True when the loop stopped on the deadline rather than on the model. */
	readonly deadlineHit: boolean
}

/**
 * Gather evidence until the model stops calling tools, the step cap is reached,
 * or the deadline passes.
 *
 * `cache: "auto"` (the default `CachePolicy`) places prompt-cache breakpoints
 * automatically. With a long system prompt riding in every turn of a multi-step
 * loop this is the single largest cost lever in the path — and under a fan-out it
 * is why the shared preamble must come *first* in every lens prompt, so five
 * concurrent passes share a breakpoint instead of each paying full input.
 */
export const runToolLoop = Effect.fn("agent.tool_loop")(function* (input: ToolLoopInput) {
	const tools = buildMapleTools(input.tenant, { include: (name) => input.toolNames.has(name) })

	let request: LLMRequest = LLM.request({
		id: input.id,
		model: input.model,
		system: input.system,
		prompt: input.prompt,
		tools: toDefinitions(tools),
	})

	let usage = emptyUsage
	let toolSteps = 0
	let deadlineHit = false

	for (let step = 0; step < input.maxToolSteps; step++) {
		if (input.deadlineAtMs !== undefined && Date.now() >= input.deadlineAtMs) {
			deadlineHit = true
			break
		}

		const response = yield* LLM.generate(request).pipe(
			Effect.mapError((error) => toLlmCallError(input.label, error)),
		)
		usage = addUsage(usage, response.usage)

		const calls = response.toolCalls.filter(
			(event) => LLMEvent.is.toolCall(event) && !event.providerExecuted,
		)
		if (calls.length === 0) break

		const dispatched = yield* Effect.forEach(
			calls,
			(call) =>
				LLMEvent.is.toolCall(call)
					? ToolRuntime.dispatch(tools, call).pipe(Effect.map((result) => [call, result] as const))
					: Effect.die(new Error("tool-call event narrowing failed")),
			{ concurrency: TOOL_CONCURRENCY },
		)
		toolSteps += dispatched.length

		// `response.message` is the assistant turn the response reducer already assembled —
		// text, reasoning and tool calls in order — so the next request carries the model's own
		// reasoning rather than just its tool calls.
		request = LLM.updateRequest(request, {
			messages: [
				...request.messages,
				response.message,
				...dispatched.map(([call, settled]) =>
					Message.tool(ToolResultPart.make({ id: call.id, name: call.name, result: settled.result })),
				),
			],
		})

		// Same exposure as the attended chat turn, and worse: many steps of
		// warehouse-sized tool payloads with no user in the loop to notice it
		// stalling. Acts on the provider's reported count.
		if (
			isNearContextLimit(response.usage?.inputTokens ?? 0, {
				context: contextLimitOf(input.model),
				output: outputLimitOf(input.model),
			})
		) {
			request = pruneToolResults(request)
		}
	}

	yield* Effect.annotateCurrentSpan({
		"maple.agent.tool_steps": toolSteps,
		"maple.agent.deadline_hit": deadlineHit,
		"gen_ai.request.model": input.model.id,
	})

	return { messages: request.messages, usage, toolSteps, deadlineHit } satisfies ToolLoopOutput
})
