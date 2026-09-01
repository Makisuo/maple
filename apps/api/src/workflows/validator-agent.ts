/**
 * The validator: reads every hypothesis candidate, promotes at most one, and
 * records why each rival lost.
 *
 * It has **no tools**. It ranks text that other agents already gathered, and
 * letting it re-investigate would make it one more investigator with a casting
 * vote — exactly the thing the fan-out exists to avoid. Its only job is
 * adjudication, and its output is the trust payload the Hypotheses table renders.
 *
 * Promoting nothing is an allowed and meaningful outcome: lanes reported, none
 * held up. That is a real answer about the incident, not a failure to produce
 * one — and it is now published as one. The validator leaves `promotedLensId`
 * null but still submits a `report`, the *partial*: what was ruled out, what
 * could not be checked, and the strongest remaining lead at low confidence. The
 * run lands on `status: "inconclusive"`, not `failed`.
 */
import { makeChatSessionId } from "@maple/domain/chat-session"
import { ValidatorVerdict } from "@maple/domain/http"
import type { InvestigationSubject, InvestigationSubjectSnapshot } from "@maple/domain/http"
import type { LanguageModel } from "@opencode-ai/ai"
import { Effect, Option, Schema } from "effect"
import { AGENTS } from "@/chat/agents"
import type { TenantContext } from "@/services/auth/tenant-context"
import { runAgentPass } from "./agent-pass"
import { buildIncidentContextMessage } from "./incident-context"

/** What one lane handed the validator. `null` candidate = the lane found nothing. */
export interface ValidatorCandidateInput {
	readonly lensId: string
	/**
	 * The planner's label for this lane. Null on legacy rows, where `lensId` was a
	 * catalogue token the validator could look copy up for; there is no catalogue
	 * to look in now, so the name travels with the candidate.
	 */
	readonly name: string | null
	readonly claim: string | null
	readonly mechanism: string | null
	readonly confidence: string | null
	readonly selfDoubt: string | null
	readonly suggestedActions: ReadonlyArray<string>
	readonly evidence: ReadonlyArray<unknown>
	/** Why this lane has no candidate, when it has none. */
	readonly note: string | null
	/**
	 * True when the lane ran out of clock rather than finishing.
	 *
	 * Surfaced to the validator because the ranking rules turn on it: a clean
	 * negative is evidence that can rule out a rival, and a lane that was cut short
	 * did not produce one — it produced silence that looks identical.
	 */
	readonly deadlineHit: boolean
}

export interface ValidatorAgentInput {
	readonly investigationId: string
	readonly subject: InvestigationSubject
	readonly snapshot: InvestigationSubjectSnapshot | null
	readonly candidates: ReadonlyArray<ValidatorCandidateInput>
	readonly model: LanguageModel
	readonly tenant: TenantContext
	/**
	 * Wall clock after which the pass stops at its next step boundary.
	 *
	 * Not optional the way `runAgentPass` allows, because omitting it is what
	 * production did and the result was a ranking that sometimes sat for five
	 * minutes and was then killed by the workflow's step timeout. The two
	 * outcomes are not the same: a soft-stopped validator spends a last step on
	 * the forced submit and still returns a verdict, a timed-out one returns
	 * nothing and the run records `validation_failed`.
	 */
	readonly deadlineAtMs: number
}

export interface ValidatorAgentOutput {
	readonly verdict: ValidatorVerdict
	readonly model: string
	readonly usage: { readonly input: number; readonly output: number; readonly cacheRead: number }
}

const buildValidatorPrompt = (input: ValidatorAgentInput): string => {
	const lines = [`## Candidates (${input.candidates.length} hypotheses dispatched)`]
	for (const candidate of input.candidates) {
		lines.push("", `### ${candidate.name ?? candidate.lensId} (\`${candidate.lensId}\`)`)
		if (candidate.claim === null) {
			// The distinction the ranking rules hang on. A lane with no candidate that
			// also ran out of clock reported nothing *about the world*; saying so here
			// is what stops its silence being read as a clean negative.
			lines.push(
				candidate.deadlineHit
					? `**No candidate — CUT SHORT by the time budget.** It did not finish checking; its silence is not a negative result. ${candidate.note ?? ""}`.trim()
					: `**No candidate.** ${candidate.note ?? "This hypothesis did not report."}`,
			)
			continue
		}
		lines.push(
			...(candidate.deadlineHit
				? ["**CUT SHORT by the time budget** — this is what it had, not what there was."]
				: []),
			`- claim: ${candidate.claim}`,
			`- mechanism: ${candidate.mechanism ?? "(none given)"}`,
			`- confidence: ${candidate.confidence ?? "(none given)"}`,
			`- what would falsify it: ${candidate.selfDoubt ?? "(the agent did not say)"}`,
			`- suggested actions: ${candidate.suggestedActions.join("; ") || "(none)"}`,
			`- evidence: ${JSON.stringify(candidate.evidence)}`,
		)
	}
	lines.push("", "Rank these now and produce your structured verdict.")
	return buildIncidentContextMessage(lines.join("\n"), input.subject, input.snapshot)
}

/**
 * The agent table is a module constant, so a missing entry is a build that
 * shipped without it rather than a runtime condition to recover from.
 */
class MissingAgentError extends Schema.TaggedError<MissingAgentError>()(
	"@maple/api/workflows/MissingAgentError",
	{ agentName: Schema.String, message: Schema.String },
) {}

export const runValidatorAgent = Effect.fn("investigation.validator")(function* (input: ValidatorAgentInput) {
	const agent = AGENTS["investigation-validator"]
	if (!agent) {
		// `AGENTS` is a module constant, so an absent entry is a build that shipped
		// without it — nothing a run could recover from.
		// oxlint-disable-next-line maple/no-effect-die
		return yield* Effect.die(
			new MissingAgentError({
				agentName: "investigation-validator",
				message: "No investigation-validator agent is registered",
			}),
		)
	}

	yield* Effect.annotateCurrentSpan({
		"maple.investigation.id": input.investigationId,
		"maple.validator.candidate_count": input.candidates.length,
	})

	const pass = yield* runAgentPass({
		id: `inv_${input.investigationId}_validator`,
		sessionId: makeChatSessionId(input.tenant.orgId, `inv-${input.investigationId}`),
		workflowName: "investigation",
		agent,
		tenant: input.tenant,
		model: input.model,
		prompt: buildValidatorPrompt(input),
		submitToolName: "submit_verdict",
		submitToolDescription:
			"Record your ranking. Call it exactly once — this call IS your answer, and prose outside " +
			"it is discarded. Promoting nothing is a legitimate outcome: leave promotedLensId null " +
			"and still submit a `report` as a partial, saying what was ruled out, what could not be " +
			"checked, and the strongest remaining lead at low confidence.",
		schema: ValidatorVerdict,
		deadlineAtMs: input.deadlineAtMs,
	})

	yield* Effect.annotateCurrentSpan({ "maple.validator.deadline_hit": pass.deadlineHit })

	// The schema cannot express the one-directional invariant, so it is enforced
	// here. Only ONE pairing is incoherent: a promoted lens with no report, which
	// would flip the row to `diagnosed` with nothing to show. It is coerced to
	// "promoted nothing".
	//
	// A report with no promoted lens is NOT incoherent — it is the partial, and
	// coercing it away is precisely what this code used to do. Every "we could
	// not tell" arrived at the user stripped of what the run had established, as
	// `validation_inconclusive: …` in an error box.
	//
	// A validator that never answered still yields both-null; the workflow
	// synthesises the partial from the lane rows rather than publishing nothing.
	const raw = Option.getOrUndefined(pass.answer)
	const promotedWithoutReport = raw !== undefined && raw.promotedLensId !== null && raw.report === null
	const coherent =
		raw !== undefined && !promotedWithoutReport
			? raw
			: new ValidatorVerdict({
					promotedLensId: null,
					report: raw?.report ?? null,
					rivals: raw?.rivals ?? [],
					note: raw
						? `${raw.note} (discarded: the validator promoted a lens without a report to publish)`
						: "The validator did not return a ranking, so this run reports only what its lanes established.",
				})

	return {
		verdict: coherent,
		model: String(input.model.id),
		usage: {
			input: pass.usage.input,
			output: pass.usage.output,
			cacheRead: pass.usage.cacheRead,
		},
	} satisfies ValidatorAgentOutput
})
