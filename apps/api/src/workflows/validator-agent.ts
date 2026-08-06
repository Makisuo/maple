/**
 * The validator: reads every hypothesis candidate, promotes at most one, and
 * records why each rival lost.
 *
 * It has **no tools**. It ranks text that other agents already gathered, and
 * letting it re-investigate would make it one more investigator with a casting
 * vote — exactly the thing the fan-out exists to avoid. Its only job is
 * adjudication, and its output is the trust payload the Hypotheses table renders.
 *
 * Promoting nothing is an allowed and meaningful outcome (`validation_inconclusive`):
 * lanes reported, none held up. That is a real answer about the incident, not a
 * failure to produce one, and the boards already draw it.
 */
import { ValidatorVerdict } from "@maple/domain/http"
import type { InvestigationSubject, InvestigationSubjectSnapshot } from "@maple/domain/http"
import type { Model } from "@maple/llm"
import { Effect, Option } from "effect"
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
	readonly model: Model
	readonly tenant: TenantContext
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

export const runValidatorAgent = Effect.fn("investigation.validator")(function* (input: ValidatorAgentInput) {
	const agent = AGENTS["investigation-validator"]
	if (!agent) return yield* Effect.die(new Error("no investigation-validator agent registered"))

	yield* Effect.annotateCurrentSpan({
		"maple.investigation.id": input.investigationId,
		"maple.validator.candidate_count": input.candidates.length,
	})

	const pass = yield* runAgentPass({
		id: `inv_${input.investigationId}_validator`,
		agent,
		tenant: input.tenant,
		model: input.model,
		prompt: buildValidatorPrompt(input),
		submitToolName: "submit_verdict",
		submitToolDescription:
			"Record your ranking. Call it exactly once. Promoting nothing is a legitimate outcome — " +
			"set promotedLensId and report to null together and explain in `note`.",
		schema: ValidatorVerdict,
	})

	// The schema cannot express "these two are null together", so it is enforced
	// here: a promoted lens with no report would flip the row to `diagnosed` with
	// nothing to show, and a report with no promoted lens would leave every lane
	// saying it lost while the page displays a cause. A validator that never
	// answered at all is the same outcome — nothing was promoted.
	const raw = Option.getOrUndefined(pass.answer)
	const coherent =
		raw && (raw.promotedLensId === null) === (raw.report === null)
			? raw
			: new ValidatorVerdict({
					promotedLensId: null,
					report: null,
					rivals: raw?.rivals ?? [],
					note: raw
						? `${raw.note} (discarded: the validator promoted a lens without a report, or a report without a lens)`
						: "The validator did not return a ranking.",
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
