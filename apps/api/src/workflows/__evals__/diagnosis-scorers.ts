/**
 * What makes a diagnosis good, expressed as functions.
 *
 * Nothing scored a *conclusion* before this. The existing eval suite scores tool
 * selection — "given this prompt, does the model pick the right tool" — and the
 * workflow tests stub every model call, so a diagnosis that invented a trace id
 * or reported "it's an unknown error" passed everything in the repo.
 *
 * Kept as pure functions over the report rather than as `vitest-evals` scorers
 * directly, so the same rules are unit-tested in the normal suite (see
 * `diagnosis-scorers.test.ts`) and wrapped for the model-driven eval. A scoring
 * rule that only runs when someone sets an API key is a rule that rots.
 */
import type { DiagnosisFixture } from "./diagnosis-fixtures"

export interface ScoredReport {
	readonly suspectedCause?: string
	readonly summary?: string
	readonly affectedScope?: string
	readonly confidence?: string
	readonly evidence?: ReadonlyArray<{
		readonly traceIds?: ReadonlyArray<string>
		readonly logPatterns?: ReadonlyArray<string>
		readonly relatedServices?: ReadonlyArray<string>
		readonly note?: string
	}>
	readonly suggestedActions?: ReadonlyArray<string>
	readonly ruledOut?: ReadonlyArray<string>
}

export interface ScoredPlan {
	readonly hypotheses?: ReadonlyArray<{ readonly name?: string; readonly claimToTest?: string }>
}

export interface RuleScore {
	readonly score: number
	readonly rationale: string
}

const pass = (rationale: string): RuleScore => ({ score: 1, rationale })
const fail = (rationale: string): RuleScore => ({ score: 0, rationale })

const lower = (value: string | undefined): string => (value ?? "").toLowerCase()

/**
 * Every identifier in the report must exist in the fixture's world.
 *
 * The failure this catches is the expensive one: a responder acts on a trace id,
 * finds nothing, and stops trusting the whole surface. The prompt has always
 * said "never invent identifiers" and nothing has ever checked.
 *
 * Only *identifier-shaped* fields are checked — trace ids, service names, log
 * patterns. Prose is not, because a summary legitimately contains words that are
 * not identifiers.
 */
export const scoreEvidenceGrounding = (report: ScoredReport, fixture: DiagnosisFixture): RuleScore => {
	const known = fixture.knownIdentifiers.map((id) => id.toLowerCase())
	const claimed: Array<string> = []
	for (const entry of report.evidence ?? []) {
		claimed.push(
			...(entry.traceIds ?? []),
			...(entry.relatedServices ?? []),
			...(entry.logPatterns ?? []),
		)
	}
	if (claimed.length === 0) {
		// Not invented, but not grounded either. A report with no citations at all is
		// exactly as unverifiable as one with fabricated ones.
		return { score: 0.5, rationale: "the report cited no identifiers at all" }
	}
	const invented = claimed.filter((value) => {
		const needle = value.toLowerCase()
		return !known.some((id) => id.includes(needle) || needle.includes(id))
	})
	return invented.length === 0
		? pass(`all ${claimed.length} cited identifiers exist in the fixture`)
		: { score: 0, rationale: `invented identifiers: ${JSON.stringify(invented)}` }
}

const UNKNOWN_PATTERN = /\b(unknown|undetermined|inconclusive|could not determine|unclear)\b/i

/**
 * An "unknown" must say what was checked.
 *
 * This is the direct regression guard for the complaint that started the rework:
 * a report whose cause was "it's an unknown error" and whose body was empty. An
 * unknown with nothing behind it is indistinguishable from not having
 * investigated, and it was previously a fully compliant answer.
 *
 * Also fails a report that echoes the grouping *label* back as a cause. "Unknown
 * Error" is the name Maple gives a span with no exception and no status message
 * — it is the thing being asked about, not an answer to it.
 */
export const scoreUnknownDiscipline = (report: ScoredReport): RuleScore => {
	const cause = report.suspectedCause ?? ""
	if (/^\s*unknown\s+error\s*$/i.test(cause)) {
		return fail("the cause is the grouping label echoed back, not an explanation")
	}
	if (!UNKNOWN_PATTERN.test(cause)) return pass("named a cause, so the unknown rules do not apply")

	const ruledOut = report.ruledOut ?? []
	if (ruledOut.length < 2) {
		return fail(`reported unknown with ${ruledOut.length} ruled-out cause(s); at least 2 are required`)
	}
	// A ruled-out entry has to carry the evidence that ruled it out, not just the
	// name of the thing. "Deploy" is a category; "no version change across 41k
	// spans" is a finding.
	const bare = ruledOut.filter((entry) => entry.trim().split(/\s+/).length < 4)
	if (bare.length > 0) {
		return { score: 0.5, rationale: `ruled-out entries name no evidence: ${JSON.stringify(bare)}` }
	}
	if ((report.confidence ?? "").toLowerCase() !== "low") {
		return { score: 0.5, rationale: `reported unknown at confidence "${report.confidence}"` }
	}
	return pass(`reported unknown with ${ruledOut.length} evidenced negatives at low confidence`)
}

/**
 * Did it name the planted cause — and, on the unknowable fixture, did it refrain
 * from naming any?
 *
 * The second half is the one worth having. Confidently naming a cause on a
 * fixture where nothing is checkable scores zero, which is the only way a
 * confabulation is worse than an honest shrug rather than merely different.
 */
export const scoreCauseMatch = (report: ScoredReport, fixture: DiagnosisFixture): RuleScore => {
	const text = `${lower(report.suspectedCause)} ${lower(report.summary)}`
	if (fixture.unknowable) {
		return UNKNOWN_PATTERN.test(report.suspectedCause ?? "")
			? pass("correctly declined to name a cause")
			: fail(`named a cause on an unknowable incident: "${report.suspectedCause}"`)
	}
	const hit = fixture.expectedCauseTerms.find((term) => text.includes(term))
	return hit === undefined
		? fail(
				`named none of the expected cause terms ${JSON.stringify(fixture.expectedCauseTerms)}; said "${report.suspectedCause}"`,
			)
		: pass(`named the planted cause family via "${hit}"`)
}

/**
 * Did the plan avoid hypotheses this world cannot answer?
 *
 * The direct regression test for the dead-lens problem. The fixed catalogue
 * dispatched a saturation lane at an org that exports no resource metrics and a
 * deploy lane at one that emits no version attribute, every single time — and
 * then had to rank whatever those lanes came back with.
 */
export const scorePlanRelevance = (plan: ScoredPlan, fixture: DiagnosisFixture): RuleScore => {
	const hypotheses = plan.hypotheses ?? []
	if (hypotheses.length === 0) return fail("the plan contained no hypotheses")

	const text = hypotheses.map((h) => `${lower(h.name)} ${lower(h.claimToTest)}`)
	const unanswerable = fixture.forbiddenHypothesisTerms.filter((term) =>
		text.some((entry) => entry.includes(term)),
	)
	if (unanswerable.length > 0) {
		return fail(`proposed hypotheses with no evidence source: ${JSON.stringify(unanswerable)}`)
	}
	if (fixture.expectedCauseTerms.length === 0) {
		// Nothing is checkable here, so any plan that avoided the forbidden framings
		// is doing as well as a plan can.
		return pass("avoided every unanswerable framing on an unknowable incident")
	}
	const covered = fixture.expectedCauseTerms.some((term) => text.some((entry) => entry.includes(term)))
	return covered
		? pass("the plan includes the planted cause family and nothing unanswerable")
		: { score: 0.5, rationale: "avoided the unanswerable framings but missed the planted cause" }
}
