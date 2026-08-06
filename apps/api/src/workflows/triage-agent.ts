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
 * The loop itself lives in `./tool-loop`, shared with the fan-out's lens passes — they need the
 * same turns with a different prompt, a narrower allowlist and a deadline. This module keeps what
 * is specific to a triage pass: its prompt, its step cap, and the schema it is forced to answer in.
 */
import type { AiTriageIncidentKind } from "@maple/domain/http"
import { AiTriageResult } from "@maple/domain/http"
import { LLM, Message, type Model } from "@maple/llm"
import { Effect } from "effect"
import { toLlmCallError } from "@/platform/Llm"
import type { TenantContext } from "@/services/auth/tenant-context"
import { addUsage, runToolLoop } from "./tool-loop"
import { buildTriageContextMessage, TRIAGE_SYSTEM_PROMPT, TRIAGE_TOOL_NAMES } from "./triage-prompt"

/**
 * Hard cap on assistant turns. The prompt asks the model for at most 16 tool calls; this is the
 * mechanical backstop, since a model that ignores the budget would otherwise bill an unbounded
 * number of turns against the org.
 */
const MAX_TOOL_STEPS = 12

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
 * Run the investigation and produce a validated `AiTriageResult`.
 *
 * `cache: "auto"` (the default `CachePolicy`) places prompt-cache breakpoints automatically. With
 * ~21 tool definitions plus a long system prompt riding in every turn of a multi-step loop, this is
 * the single largest cost lever in the path, and it did not exist under Flue at all — hence
 * `cacheRead` being tracked separately in the returned usage.
 */
export const runTriageAgent = Effect.fn("ai_triage.investigate")(function* (input: TriageAgentInput) {
	const loop = yield* runToolLoop({
		id: `triage_${input.orgId}`,
		system: TRIAGE_SYSTEM_PROMPT,
		prompt: buildTriageContextMessage(input.incidentKind, input.context),
		model: input.model,
		tenant: input.tenant,
		toolNames: TRIAGE_TOOL_NAMES,
		maxToolSteps: MAX_TOOL_STEPS,
		label: "ai-triage.investigate",
	})

	yield* Effect.annotateCurrentSpan({ "maple.triage.tool_steps": loop.toolSteps })

	// Final pass: the transcript so far, plus a forced structured answer. `generateObject` drives a
	// synthetic forced tool call under the hood, so it works on every protocol including Workers AI.
	const structured = yield* LLM.generateObject({
		id: `triage_${input.orgId}_result`,
		model: input.model,
		system: TRIAGE_SYSTEM_PROMPT,
		messages: [...loop.messages, Message.user(FINAL_INSTRUCTION)],
		schema: AiTriageResult,
	}).pipe(Effect.mapError((error) => toLlmCallError("ai-triage.report", error)))

	return {
		result: structured.object,
		model: { provider: String(input.model.provider), id: String(input.model.id) },
		usage: addUsage(loop.usage, structured.usage),
		toolSteps: loop.toolSteps,
	} satisfies TriageAgentOutput
})

const FINAL_INSTRUCTION =
	"Stop investigating. Using only the evidence you gathered above, produce your structured triage result now."
