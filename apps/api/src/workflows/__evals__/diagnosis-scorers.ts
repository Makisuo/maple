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

/**
 * Every field is `unknown`, and that is the point.
 *
 * These rules run over `JSON.parse` of raw model output. `generateObject` asks for
 * the report schema, but a provider that returns `ruledOut: [{name: "Deploy"}]`
 * satisfies nothing and still reaches here — and a scorer that trusts the declared
 * type throws `entry.trim is not a function`, so the one answer that most deserves
 * a score is the one that errors the case out instead of scoring it.
 *
 * **A malformed field scores zero.** Not half credit, not a coercion to its JSON
 * text: the report contract is part of what is under test, and an answer that
 * breaks the contract is a worse answer than one that merely reasoned badly within
 * it. Absent optional fields are still absent, not malformed — only a *present*
 * field of the wrong shape fails.
 */
export interface ScoredReport {
	readonly suspectedCause?: unknown
	readonly summary?: unknown
	readonly affectedScope?: unknown
	readonly confidence?: unknown
	readonly evidence?: unknown
	readonly suggestedActions?: unknown
	readonly ruledOut?: unknown
}

export interface ScoredPlan {
	readonly hypotheses?: unknown
}

export interface RuleScore {
	readonly score: number
	readonly rationale: string
}

const pass = (rationale: string): RuleScore => ({ score: 1, rationale })
const fail = (rationale: string): RuleScore => ({ score: 0, rationale })

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const wrongType = (field: string, value: unknown): string => `${field} is malformed: ${JSON.stringify(value)}`

/** Describes a present-but-wrong-type field for the rationale; `undefined` if it is fine. */
const notString = (field: string, value: unknown): string | undefined =>
	value === undefined || typeof value === "string" ? undefined : wrongType(field, value)

const notList = (field: string, value: unknown): string | undefined =>
	value === undefined || Array.isArray(value) ? undefined : wrongType(field, value)

const text = (value: unknown): string => (typeof value === "string" ? value : "")
const lower = (value: unknown): string => text(value).toLowerCase()
const items = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : [])

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
	const breach = notList("evidence", report.evidence)
	if (breach) return fail(breach)

	const known = fixture.knownIdentifiers.map((id) => id.toLowerCase())
	const claimed: Array<unknown> = []
	for (const entry of items(report.evidence)) {
		if (!isRecord(entry)) return fail(`an evidence entry is malformed: ${JSON.stringify(entry)}`)
		claimed.push(...items(entry.traceIds), ...items(entry.relatedServices), ...items(entry.logPatterns))
	}
	if (claimed.length === 0) {
		// Not invented, but not grounded either. A report with no citations at all is
		// exactly as unverifiable as one with fabricated ones.
		return { score: 0.5, rationale: "the report cited no identifiers at all" }
	}
	// A non-string citation is no more checkable than a fabricated one, so it lands in
	// the same bucket rather than getting its own softer verdict.
	const invented = claimed.filter((value) => {
		if (typeof value !== "string") return true
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
	const breach =
		notString("suspectedCause", report.suspectedCause) ??
		notString("confidence", report.confidence) ??
		notList("ruledOut", report.ruledOut)
	if (breach) return fail(breach)

	const cause = text(report.suspectedCause)
	if (/^\s*unknown\s+error\s*$/i.test(cause)) {
		return fail("the cause is the grouping label echoed back, not an explanation")
	}
	if (!UNKNOWN_PATTERN.test(cause)) return pass("named a cause, so the unknown rules do not apply")

	const ruledOut = items(report.ruledOut)
	// A ruled-out entry that is not prose cannot carry evidence at all — an object or a
	// number here is a broken answer, and it fails outright rather than crashing the case.
	const notProse = ruledOut.filter((entry) => typeof entry !== "string")
	if (notProse.length > 0) {
		return fail(`ruled-out entries are not strings: ${JSON.stringify(notProse)}`)
	}
	if (ruledOut.length < 2) {
		return fail(`reported unknown with ${ruledOut.length} ruled-out cause(s); at least 2 are required`)
	}
	// A ruled-out entry has to carry the evidence that ruled it out, not just the
	// name of the thing. "Deploy" is a category; "no version change across 41k
	// spans" is a finding.
	const bare = ruledOut.filter((entry) => text(entry).trim().split(/\s+/).length < 4)
	if (bare.length > 0) {
		return { score: 0.5, rationale: `ruled-out entries name no evidence: ${JSON.stringify(bare)}` }
	}
	if (lower(report.confidence) !== "low") {
		return { score: 0.5, rationale: `reported unknown at confidence "${text(report.confidence)}"` }
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
	const breach = notString("suspectedCause", report.suspectedCause) ?? notString("summary", report.summary)
	if (breach) return fail(breach)

	const said = `${lower(report.suspectedCause)} ${lower(report.summary)}`
	if (fixture.unknowable) {
		return UNKNOWN_PATTERN.test(text(report.suspectedCause))
			? pass("correctly declined to name a cause")
			: fail(`named a cause on an unknowable incident: "${text(report.suspectedCause)}"`)
	}
	const hit = fixture.expectedCauseTerms.find((term) => said.includes(term))
	return hit === undefined
		? fail(
				`named none of the expected cause terms ${JSON.stringify(fixture.expectedCauseTerms)}; said "${text(report.suspectedCause)}"`,
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
	const breach = notList("hypotheses", plan.hypotheses)
	if (breach) return fail(breach)

	const hypotheses = items(plan.hypotheses)
	if (hypotheses.length === 0) return fail("the plan contained no hypotheses")

	const broken = hypotheses.filter(
		(h) =>
			!isRecord(h) ||
			notString("name", h.name) !== undefined ||
			notString("claimToTest", h.claimToTest) !== undefined,
	)
	if (broken.length > 0) {
		return fail(`hypotheses are malformed: ${JSON.stringify(broken)}`)
	}

	const said = hypotheses.map((h) => (isRecord(h) ? `${lower(h.name)} ${lower(h.claimToTest)}` : ""))
	const unanswerable = fixture.forbiddenHypothesisTerms.filter((term) =>
		said.some((entry) => entry.includes(term)),
	)
	if (unanswerable.length > 0) {
		return fail(`proposed hypotheses with no evidence source: ${JSON.stringify(unanswerable)}`)
	}
	if (fixture.expectedCauseTerms.length === 0) {
		// Nothing is checkable here, so any plan that avoided the forbidden framings
		// is doing as well as a plan can.
		return pass("avoided every unanswerable framing on an unknowable incident")
	}
	const covered = fixture.expectedCauseTerms.some((term) => said.some((entry) => entry.includes(term)))
	return covered
		? pass("the plan includes the planted cause family and nothing unanswerable")
		: { score: 0.5, rationale: "avoided the unanswerable framings but missed the planted cause" }
}
