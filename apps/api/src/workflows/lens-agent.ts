/**
 * One lens pass: gather evidence through a single framing, then answer in a
 * `LensCandidate`.
 *
 * Runs as a registered sub-agent (`lens-<lensId>` in `chat/agents.ts`) on the
 * shared turn loop, so it inherits its retry policy, context pruning, step budget
 * and permission ruleset. It has no `task` tool — a lens cannot spawn anything —
 * and no `submit_diagnosis`: a lens produces a candidate to be *ranked*, and
 * handing it the tool that publishes a diagnosis would let any one of five rivals
 * declare itself the answer before the validator ran.
 */
import { LensCandidate } from "@maple/domain/http"
import type { InvestigationSubject, InvestigationSubjectSnapshot, LensId } from "@maple/domain/http"
import type { Model } from "@maple/llm"
import { Effect, Option } from "effect"
import { AGENTS } from "@/chat/agents"
import type { TenantContext } from "@/services/auth/tenant-context"
import { runAgentPass } from "./agent-pass"
import { buildLensContextMessage } from "./lens-prompt"

export interface LensAgentInput {
	readonly investigationId: string
	readonly lensId: LensId
	readonly subject: InvestigationSubject
	readonly snapshot: InvestigationSubjectSnapshot | null
	readonly model: Model
	readonly tenant: TenantContext
	/** Wall-clock budget; the turn stops at its next step boundary past it. */
	readonly deadlineAtMs: number
}

export interface LensAgentOutput {
	/** `None` when the lens reached no candidate — a valid result, not a failure. */
	readonly candidate: Option.Option<LensCandidate>
	readonly model: string
	readonly usage: { readonly input: number; readonly output: number; readonly cacheRead: number }
	readonly toolSteps: number
	readonly deadlineHit: boolean
}

const SUBMIT_DESCRIPTION =
	"Record your candidate for this lens. Call it exactly once, after you have gathered evidence. " +
	"If your lens found nothing, still call it — say so in `claim` with low confidence. A lens that " +
	"reports honestly that it found nothing is doing its job."

export const runLensAgent = Effect.fn("investigation.lens")(function* (input: LensAgentInput) {
	const agent = AGENTS[`lens-${input.lensId}`]
	if (!agent) return yield* Effect.die(new Error(`no agent registered for lens ${input.lensId}`))

	yield* Effect.annotateCurrentSpan({
		"maple.investigation.id": input.investigationId,
		"maple.lens.id": input.lensId,
	})

	const pass = yield* runAgentPass({
		id: `inv_${input.investigationId}_${input.lensId}`,
		agent,
		tenant: input.tenant,
		model: input.model,
		prompt: buildLensContextMessage(input.subject, input.snapshot),
		submitToolName: "submit_candidate",
		submitToolDescription: SUBMIT_DESCRIPTION,
		schema: LensCandidate,
		deadlineAtMs: input.deadlineAtMs,
	})

	return {
		candidate: pass.answer,
		model: String(input.model.id),
		usage: {
			input: pass.usage.input,
			output: pass.usage.output,
			cacheRead: pass.usage.cacheRead,
		},
		toolSteps: pass.toolCalls,
		deadlineHit: pass.deadlineHit,
	} satisfies LensAgentOutput
})
