/**
 * One hypothesis pass: test a single named claim, then answer in a
 * `LensCandidate`.
 *
 * Runs on the shared turn loop as a per-run `AgentDefinition`, so it inherits
 * retry, context pruning, the step budget and permission gating. It has no
 * `task` tool — a lane cannot spawn anything — and no `submit_diagnosis`: a lane
 * produces a candidate to be *ranked*, and handing it the tool that publishes a
 * diagnosis would let any one of several rivals declare itself the answer before
 * the validator ran.
 */
import { makeChatSessionId } from "@maple/domain/chat-session"
import { AiTriageResult, LensCandidate } from "@maple/domain/http"
import type { InvestigationSubject, InvestigationSubjectSnapshot } from "@maple/domain/http"
import type { Model } from "@maple/llm"
import { Effect, Option } from "effect"
import { hypothesisAgent } from "@/chat/agents"
import type { TenantContext } from "@/services/auth/tenant-context"
import { runAgentPass } from "./agent-pass"
import { buildIncidentContextMessage } from "./incident-context"
import type { PlannedHypothesis } from "./plan-normalize"

export interface HypothesisAgentInput {
	readonly investigationId: string
	readonly hypothesis: PlannedHypothesis
	/** What the planner established. Prefixed onto the brief so lanes share one scope. */
	readonly scopeSummary: string
	readonly subject: InvestigationSubject
	readonly snapshot: InvestigationSubjectSnapshot | null
	readonly model: Model
	readonly tenant: TenantContext
	/** Wall-clock budget; the turn spends one last step submitting past it. */
	readonly deadlineAtMs: number
}

export interface HypothesisAgentOutput {
	/** `None` when the lane reached no candidate — a valid result, not a failure. */
	readonly candidate: Option.Option<LensCandidate>
	readonly model: string
	readonly usage: { readonly input: number; readonly output: number; readonly cacheRead: number }
	readonly toolSteps: number
	readonly deadlineHit: boolean
}

const SUBMIT_DESCRIPTION =
	"Record your candidate. Call it exactly once, after you have gathered evidence. If your " +
	"hypothesis did not hold, still call it — say in `claim` what you checked, what you saw " +
	"instead, and what would have convinced you. A lane that reports an honest negative is doing " +
	"its job; one that reports nothing is indistinguishable from one that never looked."

export const runHypothesisAgent = Effect.fn("investigation.hypothesis")(function* (
	input: HypothesisAgentInput,
) {
	yield* Effect.annotateCurrentSpan({
		"maple.investigation.id": input.investigationId,
		"maple.hypothesis.id": input.hypothesis.id,
	})

	const pass = yield* runAgentPass({
		id: `inv_${input.investigationId}_${input.hypothesis.id}`,
		sessionId: makeChatSessionId(input.tenant.orgId, `inv-${input.investigationId}`),
		agent: hypothesisAgent(input.hypothesis),
		tenant: input.tenant,
		model: input.model,
		prompt: buildIncidentContextMessage(
			[
				"Test your assigned hypothesis against the incident below.",
				"",
				"## What the planner established",
				"",
				input.scopeSummary,
			].join("\n"),
			input.subject,
			input.snapshot,
		),
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
	} satisfies HypothesisAgentOutput
})

/**
 * The collapsed path: one hypothesis, answering with a full diagnosis.
 *
 * When the planner establishes the cause unambiguously there are no rivals to
 * rank, so a validator pass would be a strong-model call spent comparing one
 * candidate to nothing. The lane submits the published report directly instead.
 *
 * Deliberately the same agent, prompt and tools as a ranked lane — only the
 * answer schema differs. A separate "solo investigator" prompt would be a third
 * place where the rules about evidence and honest unknowns have to stay in sync,
 * and the two would drift.
 */
export interface SoloHypothesisOutput {
	readonly report: Option.Option<AiTriageResult>
	readonly model: string
	readonly usage: { readonly input: number; readonly output: number; readonly cacheRead: number }
	readonly toolSteps: number
	readonly deadlineHit: boolean
}

const SOLO_SUBMIT_DESCRIPTION =
	"Record the diagnosis. Call it exactly once, after you have gathered evidence. This is " +
	"published as the investigation's report, so `ruledOut` is what tells the reader what else " +
	"you considered — fill it even when you are confident, and especially when you are not."

export const runSoloHypothesisAgent = Effect.fn("investigation.solo")(function* (
	input: HypothesisAgentInput,
) {
	yield* Effect.annotateCurrentSpan({
		"maple.investigation.id": input.investigationId,
		"maple.hypothesis.id": input.hypothesis.id,
		"maple.investigation.collapsed": true,
	})

	const pass = yield* runAgentPass({
		id: `inv_${input.investigationId}_${input.hypothesis.id}`,
		sessionId: makeChatSessionId(input.tenant.orgId, `inv-${input.investigationId}`),
		agent: hypothesisAgent(input.hypothesis),
		tenant: input.tenant,
		model: input.model,
		prompt: buildIncidentContextMessage(
			[
				"Investigate the incident below. Planning established a single likely cause, so you are",
				"the only agent on it and your report is published directly — there is no validator to",
				"catch a wrong answer. Test the claim rather than assuming it.",
				"",
				"## What the planner established",
				"",
				input.scopeSummary,
			].join("\n"),
			input.subject,
			input.snapshot,
		),
		submitToolName: "submit_diagnosis",
		submitToolDescription: SOLO_SUBMIT_DESCRIPTION,
		schema: AiTriageResult,
		deadlineAtMs: input.deadlineAtMs,
	})

	return {
		report: pass.answer,
		model: String(input.model.id),
		usage: {
			input: pass.usage.input,
			output: pass.usage.output,
			cacheRead: pass.usage.cacheRead,
		},
		toolSteps: pass.toolCalls,
		deadlineHit: pass.deadlineHit,
	} satisfies SoloHypothesisOutput
})
