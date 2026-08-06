/**
 * The validator: reads every lens candidate, promotes at most one, and records
 * why each rival lost.
 *
 * It has **no tools**. It ranks text that other agents already gathered, and
 * letting it re-investigate would make it a sixth lens with a casting vote —
 * which is exactly the thing the fan-out exists to avoid. Its only job is
 * adjudication, and its output is the trust payload the Hypotheses table renders.
 *
 * Promoting nothing is an allowed and meaningful outcome (`validation_inconclusive`):
 * lenses reported, none held up. That is a real answer about the incident, not a
 * failure to produce one, and the boards already draw it.
 */
import { ValidatorVerdict } from "@maple/domain/http"
import type { InvestigationSubject, InvestigationSubjectSnapshot, LensId } from "@maple/domain/http"
import type { Model } from "@maple/llm"
import { Effect, Option } from "effect"
import { AGENTS } from "@/chat/agents"
import type { TenantContext } from "@/services/auth/tenant-context"
import { runAgentPass } from "./agent-pass"
import { lensById } from "./lens-prompt"

/** What one lens handed the validator. `null` candidate = the lens found nothing. */
export interface ValidatorCandidateInput {
	readonly lensId: LensId
	readonly claim: string | null
	readonly mechanism: string | null
	readonly confidence: string | null
	readonly selfDoubt: string | null
	readonly suggestedActions: ReadonlyArray<string>
	readonly evidence: ReadonlyArray<unknown>
	/** Why this lens has no candidate, when it has none. */
	readonly note: string | null
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
	const lines = [
		"## Subject",
		JSON.stringify({ subject: input.subject, snapshot: input.snapshot }, null, 2),
		"",
		`## Candidates (${input.candidates.length} lenses dispatched)`,
	]
	for (const candidate of input.candidates) {
		const lens = lensById(candidate.lensId)
		lines.push("", `### ${lens.name} (\`${candidate.lensId}\`)`, `Question: ${lens.question}`)
		if (candidate.claim === null) {
			lines.push(`**No candidate.** ${candidate.note ?? "This lens did not report."}`)
			continue
		}
		lines.push(
			`- claim: ${candidate.claim}`,
			`- mechanism: ${candidate.mechanism ?? "(none given)"}`,
			`- confidence: ${candidate.confidence ?? "(none given)"}`,
			`- what would falsify it: ${candidate.selfDoubt ?? "(the lens did not say)"}`,
			`- suggested actions: ${candidate.suggestedActions.join("; ") || "(none)"}`,
			`- evidence: ${JSON.stringify(candidate.evidence)}`,
		)
	}
	lines.push("", "Rank these now and produce your structured verdict.")
	return lines.join("\n")
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
