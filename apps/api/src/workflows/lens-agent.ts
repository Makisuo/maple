/**
 * One lens pass: gather evidence through a single framing, then answer in a
 * `LensCandidate`.
 *
 * Headless by design — no Durable Object, no transcript, no `submit_diagnosis`
 * tool. A lens produces a candidate to be *ranked*, and giving it the tool that
 * publishes a diagnosis would let any one of five rivals declare itself the
 * answer before the validator ever ran.
 */
import { LensCandidate } from "@maple/domain/http"
import type { InvestigationSubject, InvestigationSubjectSnapshot, LensId } from "@maple/domain/http"
import { LLM, Message, type Model } from "@maple/llm"
import { Effect } from "effect"
import { toLlmCallError } from "@/platform/Llm"
import type { TenantContext } from "@/services/auth/tenant-context"
import {
	LENS_FINAL_INSTRUCTION,
	LENS_MAX_TOOL_STEPS,
	buildLensContextMessage,
	buildLensSystemPrompt,
	lensById,
} from "./lens-prompt"
import { addUsage, runToolLoop, type TokenUsage } from "./tool-loop"

export interface LensAgentInput {
	readonly investigationId: string
	readonly lensId: LensId
	readonly subject: InvestigationSubject
	readonly snapshot: InvestigationSubjectSnapshot | null
	readonly model: Model
	readonly tenant: TenantContext
	/** Wall-clock budget; the loop stops gathering past it and answers on what it has. */
	readonly deadlineAtMs: number
}

export interface LensAgentOutput {
	readonly candidate: LensCandidate
	readonly model: string
	readonly usage: TokenUsage
	readonly toolSteps: number
	readonly deadlineHit: boolean
}

export const runLensAgent = Effect.fn("investigation.lens")(function* (input: LensAgentInput) {
	const lens = lensById(input.lensId)
	yield* Effect.annotateCurrentSpan({
		"maple.investigation.id": input.investigationId,
		"maple.lens.id": input.lensId,
	})

	const system = buildLensSystemPrompt(input.lensId)

	const loop = yield* runToolLoop({
		id: `inv_${input.investigationId}_${input.lensId}`,
		system,
		prompt: buildLensContextMessage(input.subject, input.snapshot),
		model: input.model,
		tenant: input.tenant,
		toolNames: lens.toolNames,
		maxToolSteps: LENS_MAX_TOOL_STEPS,
		deadlineAtMs: input.deadlineAtMs,
		label: `investigation.lens.${input.lensId}`,
	})

	const structured = yield* LLM.generateObject({
		id: `inv_${input.investigationId}_${input.lensId}_candidate`,
		model: input.model,
		system,
		messages: [...loop.messages, Message.user(LENS_FINAL_INSTRUCTION)],
		schema: LensCandidate,
	}).pipe(Effect.mapError((error) => toLlmCallError(`investigation.lens.${input.lensId}.candidate`, error)))

	return {
		candidate: structured.object,
		model: String(input.model.id),
		usage: addUsage(loop.usage, structured.usage),
		toolSteps: loop.toolSteps,
		deadlineHit: loop.deadlineHit,
	} satisfies LensAgentOutput
})
