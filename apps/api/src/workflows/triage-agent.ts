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
import { Tool, ToolFailure, ToolRuntime, toDefinitions, type Tools } from "@maple/llm"
import { Effect } from "effect"
import { toLlmCallError } from "@/lib/Llm"
import { callMcpTool } from "@/mcp/dispatcher"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { mapleToolDefinitions, toInputSchema } from "@/mcp/tools/registry"
import type { TenantContext } from "@/lib/tenant-context"
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

/**
 * Re-pin the service requirements of an MCP tool handler.
 *
 * `MapleToolDefinition.handler` types its requirements as `any` — a deliberate erasure at the
 * boundary between ~57 heterogeneous tool implementations and the single `McpServer.addTool`
 * signature (see the comment on the type in `mcp/tools/registry.ts`). `@maple/llm`'s `Tool.make`
 * insists on `never`, and `any` is not assignable to `never` in that position, so the erasure has
 * to be undone somewhere. Doing it here, once and by name, keeps it visible: the services really
 * are supplied, by the `ManagedRuntime` the workflow builds around this loop.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const withRuntimeServices = <A, E>(effect: Effect.Effect<A, E, any>): Effect.Effect<A, E> =>
	effect as Effect.Effect<A, E>

/**
 * Serialize an MCP tool result for the model. Maple's tools already return model-facing text
 * blocks, so this is a join rather than a re-encode; `isError` is surfaced as a `ToolFailure` so
 * the runtime emits a `tool-error` event and the model can self-correct.
 */
const toolResultText = (result: { content: ReadonlyArray<{ text: string }> }): string =>
	result.content.map((block) => block.text).join("\n")

/**
 * Wrap the Maple MCP registry as `@maple/llm` tools, restricted to the read-only allowlist.
 *
 * Dynamic (`jsonSchema`) mode is the right fit: `toInputSchema` already produces the exact JSON
 * Schema the MCP surface publishes, and `callMcpTool` does its own Effect Schema decode with the
 * tool's own error messages. Decoding twice would only give the model a second, worse phrasing of
 * the same validation failure.
 *
 * The tenant is provided per call rather than ambiently so the loop can never widen its own scope:
 * every tool executes under exactly the org the workflow was enqueued for.
 */
const buildTriageTools = (tenant: TenantContext): Tools =>
	Object.fromEntries(
		mapleToolDefinitions
			.filter((definition) => TRIAGE_TOOL_NAMES.has(definition.name))
			.map((definition) => [
				definition.name,
				Tool.make({
					description: definition.description,
					jsonSchema: toInputSchema(definition.schema),
					execute: (params): Effect.Effect<unknown, ToolFailure> =>
						withRuntimeServices(
							callMcpTool(definition.name, params).pipe(
								Effect.provideService(CurrentMcpTenant, tenant),
								Effect.flatMap((result) =>
									result.isError
										? Effect.fail(new ToolFailure({ message: toolResultText(result) }))
										: Effect.succeed(toolResultText(result)),
								),
								// A tool that fails outright (unknown tool, tenant error) must not kill
								// the investigation — hand the model the message and let it route around.
								Effect.catchCause((cause) =>
									Effect.fail(new ToolFailure({ message: `Tool failed: ${String(cause)}` })),
								),
							),
						),
				}),
			]),
	)

const addUsage = (
	total: { input: number; output: number; cacheRead: number },
	usage: Usage | undefined,
) => ({
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

