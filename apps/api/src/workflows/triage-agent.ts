/**
 * The AI-triage investigation loop, in process.
 *
 * This replaces the Flue `triage` workflow (`apps/chat-flue/src/workflows/triage.ts`) and, with it,
 * the whole `apps/api -> CHAT_FLUE -> MCP-over-HTTP -> apps/api` round trip: Maple's MCP tools and
 * `@maple/llm`'s `Tool` abstraction are both Effect Schema, so the tools are a direct wrap of
 * `mapleToolDefinitions` and `callMcpTool` with no JSON-Schema-to-Valibot bridge in between.
 *
 * Shape of a run:
 *
 *   1. `LLM.generate` with the read-only tool allowlist bound.
 *   2. For each `tool-call` event, `ToolRuntime.dispatch` -> append the assistant turn and the
 *      `ToolResultPart`s -> repeat. Capped by `MAX_TOOL_STEPS`.
 *   3. Once the model stops calling tools (or the cap is hit), `LLM.generateObject` against
 *      `AiTriageResult` from `@maple/domain/http` — the canonical schema, so the hand-maintained
 *      Valibot mirror in `apps/chat-flue/src/lib/triage-result.ts` is gone.
 *
 * `ToolRuntime` deliberately exports only `dispatch` for a single call; the multi-turn loop that
 * Flue's `session.prompt` used to hide is owned here, where the step cap and the allowlist are
 * visible.
 */
import type { AiTriageIncidentKind } from "@maple/domain/http"
import { AiTriageResult } from "@maple/domain/http"
import { LLM, LLMEvent, Message, ToolResultPart, type LLMRequest, type Model, type Usage } from "@maple/llm"
import { ToolRuntime, toDefinitions } from "@maple/llm"
import { Effect } from "effect"
import { contextLimitOf, outputLimitOf, toLlmCallError } from "@/platform/Llm"
import { buildMapleTools } from "@/mcp/tools/llm-tools"
import { isNearContextLimit, pruneToolResults } from "@/chat/context-budget"
import type { TenantContext } from "@/services/auth/tenant-context"
import { buildTriageContextMessage, TRIAGE_SYSTEM_PROMPT, TRIAGE_TOOL_NAMES } from "./triage-prompt"

/**
 * Hard cap on assistant turns. The prompt asks the model for at most 16 tool calls; this is the
 * mechanical backstop, since a model that ignores the budget would otherwise bill an unbounded
 * number of turns against the org.
 */
const MAX_TOOL_STEPS = 12

/** Fan-out cap for tool calls issued in the same assistant turn. */
const TOOL_CONCURRENCY = 4

export interface TriageAgentInput {
	readonly orgId: string
	readonly incidentKind: AiTriageIncidentKind
	readonly context: Record<string, unknown>
	readonly model: Model
	readonly tenant: TenantContext
}

export interface TriageAgentOutput {
	readonly result: AiTriageResult
	readonly model: { readonly provider: string; readonly id: string }
	readonly usage: { readonly input: number; readonly output: number; readonly cacheRead: number }
	readonly toolSteps: number
}

/** The read-only allowlist, as `@maple/llm` tools. Nothing here is approval-gated: the triage loop
 * is autonomous and mutating tools are simply not in `TRIAGE_TOOL_NAMES`. */
const buildTriageTools = (tenant: TenantContext) =>
	buildMapleTools(tenant, { include: (name) => TRIAGE_TOOL_NAMES.has(name) })

const addUsage = (total: { input: number; output: number; cacheRead: number }, usage: Usage | undefined) => ({
	input: total.input + (usage?.inputTokens ?? 0),
	output: total.output + (usage?.outputTokens ?? 0),
	cacheRead: total.cacheRead + (usage?.cacheReadInputTokens ?? 0),
})

/**
 * Run the investigation and produce a validated `AiTriageResult`.
 *
 * `cache: "auto"` (the default `CachePolicy`) places prompt-cache breakpoints automatically. With
 * ~21 tool definitions plus a long system prompt riding in every turn of a multi-step loop, this is
 * the single largest cost lever in the path, and it did not exist under Flue at all — hence
 * `cacheRead` being tracked separately in the returned usage.
 */
export const runTriageAgent = Effect.fn("ai_triage.investigate")(function* (input: TriageAgentInput) {
	const tools = buildTriageTools(input.tenant)
	const toolDefinitions = toDefinitions(tools)

	let request: LLMRequest = LLM.request({
		id: `triage_${input.orgId}`,
		model: input.model,
		system: TRIAGE_SYSTEM_PROMPT,
		prompt: buildTriageContextMessage(input.incidentKind, input.context),
		tools: toolDefinitions,
	})

	let usage = { input: 0, output: 0, cacheRead: 0 }
	let toolSteps = 0

	for (let step = 0; step < MAX_TOOL_STEPS; step++) {
		const response = yield* LLM.generate(request).pipe(
			Effect.mapError((error) => toLlmCallError("ai-triage.investigate", error)),
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
					Message.tool(
						ToolResultPart.make({ id: call.id, name: call.name, result: settled.result }),
					),
				),
			],
		})

		// Same exposure as the chat turn, and worse: twelve steps of warehouse-sized tool payloads
		// with no user in the loop to notice it stalling. Acts on the provider's reported count.
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
		"maple.triage.tool_steps": toolSteps,
		"gen_ai.request.model": input.model.id,
	})

	// Final pass: the transcript so far, plus a forced structured answer. `generateObject` drives a
	// synthetic forced tool call under the hood, so it works on every protocol including Workers AI.
	const structured = yield* LLM.generateObject({
		id: `triage_${input.orgId}_result`,
		model: input.model,
		system: TRIAGE_SYSTEM_PROMPT,
		messages: [...request.messages, Message.user(FINAL_INSTRUCTION)],
		schema: AiTriageResult,
	}).pipe(Effect.mapError((error) => toLlmCallError("ai-triage.report", error)))

	usage = addUsage(usage, structured.usage)

	return {
		result: structured.object,
		model: { provider: String(input.model.provider), id: String(input.model.id) },
		usage,
		toolSteps,
	} satisfies TriageAgentOutput
})

const FINAL_INSTRUCTION =
	"Stop investigating. Using only the evidence you gathered above, produce your structured triage result now."
