/**
 * The planning pass: scope the incident, then say what is worth testing.
 *
 * Runs on the strong model — the same one the validator gets, not the cheaper
 * one the lanes get. One pass decides how the entire run is spent: a planner
 * that writes a hypothesis with no evidence source burns a whole lane, and a
 * planner that misses the real angle means no lane ever looks at it. That is the
 * highest-leverage model call in the flow, so it is the one that should not be
 * economised on.
 */
import { makeChatSessionId } from "@maple/domain/chat-session"
import { InvestigationPlan } from "@maple/domain/http"
import type { InvestigationSubject, InvestigationSubjectSnapshot } from "@maple/domain/http"
import type { Model } from "@maple/llm"
import { Effect, Option } from "effect"
import { plannerAgent } from "@/chat/agents"
import type { TenantContext } from "@/services/auth/tenant-context"
import { runAgentPass } from "./agent-pass"
import { buildIncidentContextMessage } from "./incident-context"
import { PLANNER_SUBMIT_DESCRIPTION, PLANNER_SUBMIT_TOOL } from "./planner-prompt"

export interface PlannerAgentInput {
	readonly investigationId: string
	readonly subject: InvestigationSubject
	readonly snapshot: InvestigationSubjectSnapshot | null
	readonly model: Model
	readonly tenant: TenantContext
	readonly deadlineAtMs: number
}

export interface PlannerAgentOutput {
	/** `None` when the planner never submitted. `normalizePlan` falls back to the seed catalogue. */
	readonly plan: Option.Option<InvestigationPlan>
	readonly model: string
	readonly usage: { readonly input: number; readonly output: number; readonly cacheRead: number }
	readonly toolSteps: number
	readonly deadlineHit: boolean
}

const LEAD = [
	"Plan the investigation of the incident below.",
	"",
	"Spend your tool calls establishing the interval, looking at the incident once, and finding out",
	"what this organization actually emits — then submit the plan. Do not diagnose it yourself.",
].join("\n")

export const runPlannerAgent = Effect.fn("investigation.plan")(function* (input: PlannerAgentInput) {
	yield* Effect.annotateCurrentSpan({ "maple.investigation.id": input.investigationId })

	const pass = yield* runAgentPass({
		id: `inv_${input.investigationId}_plan`,
		// The seeded transcript's chat session id, so the workflow's passes and any
		// attended follow-up land in one agent session.
		sessionId: makeChatSessionId(input.tenant.orgId, `inv-${input.investigationId}`),
		workflowName: "investigation",
		agent: plannerAgent(),
		tenant: input.tenant,
		model: input.model,
		prompt: buildIncidentContextMessage(LEAD, input.subject, input.snapshot),
		submitToolName: PLANNER_SUBMIT_TOOL,
		submitToolDescription: PLANNER_SUBMIT_DESCRIPTION,
		schema: InvestigationPlan,
		deadlineAtMs: input.deadlineAtMs,
	})

	// `planner_submitted` is the single most diagnostic bit this pass produces: a
	// planner that never called its submit tool sends the run to the seed
	// catalogue, and for a long time that was invisible everywhere.
	yield* Effect.annotateCurrentSpan({
		"maple.plan.planner_submitted": Option.isSome(pass.answer),
		"maple.plan.tool_steps": pass.toolCalls,
		"maple.plan.deadline_hit": pass.deadlineHit,
	})

	return {
		plan: pass.answer,
		model: String(input.model.id),
		usage: {
			input: pass.usage.input,
			output: pass.usage.output,
			cacheRead: pass.usage.cacheRead,
		},
		toolSteps: pass.toolCalls,
		deadlineHit: pass.deadlineHit,
	} satisfies PlannerAgentOutput
})
