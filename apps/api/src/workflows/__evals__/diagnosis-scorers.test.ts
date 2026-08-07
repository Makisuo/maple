/**
 * The scoring rules, tested without a model.
 *
 * These live in the normal suite on purpose. A scoring rule that only executes
 * when someone has set `OPENROUTER_API_KEY` is a rule nobody notices breaking,
 * and the rules are the specification of what "a good diagnosis" means here —
 * they should be as hard to break as the code they judge.
 */
import { describe, expect, it } from "vitest"
import { DIAGNOSIS_FIXTURES } from "./diagnosis-fixtures"
import {
	scoreCauseMatch,
	scoreEvidenceGrounding,
	scorePlanRelevance,
	scoreUnknownDiscipline,
} from "./diagnosis-scorers"

const fixture = (id: string) => DIAGNOSIS_FIXTURES.find((f) => f.id === id)!

const POOL = fixture("pool_exhaustion")
const DEPLOY = fixture("bad_deploy")
const UNKNOWABLE = fixture("unknowable")

describe("scoreEvidenceGrounding", () => {
	it("passes a report that cites only real identifiers", () => {
		const result = scoreEvidenceGrounding(
			{
				evidence: [
					{
						traceIds: ["0af7651916cd43dd8448eb211c80319c"],
						relatedServices: ["payments-api"],
						logPatterns: ["timeout acquiring connection from pool"],
					},
				],
			},
			POOL,
		)
		expect(result.score).toBe(1)
	})

	/** The expensive failure: a responder chases a trace id that does not exist. */
	it("fails a report that invented a trace id", () => {
		const result = scoreEvidenceGrounding(
			{ evidence: [{ traceIds: ["deadbeefdeadbeefdeadbeefdeadbeef"] }] },
			POOL,
		)
		expect(result.score).toBe(0)
		expect(result.rationale).toContain("invented")
	})

	it("penalises a report that cited nothing at all", () => {
		expect(scoreEvidenceGrounding({ evidence: [] }, POOL).score).toBe(0.5)
	})
})

describe("scoreUnknownDiscipline", () => {
	it("ignores a report that named a cause", () => {
		expect(scoreUnknownDiscipline({ suspectedCause: "Connection pool exhaustion." }).score).toBe(1)
	})

	/** The complaint that started the rework, as a test. */
	it("fails a bare unknown", () => {
		const result = scoreUnknownDiscipline({ suspectedCause: "unknown", confidence: "low" })
		expect(result.score).toBe(0)
		expect(result.rationale).toContain("at least 2")
	})

	/**
	 * "Unknown Error" is the label Maple gives a span with no exception and no
	 * status message. Reporting it as the cause is restating the question.
	 */
	it("fails a report that echoes the grouping label back as the cause", () => {
		const result = scoreUnknownDiscipline({ suspectedCause: "Unknown Error" })
		expect(result.score).toBe(0)
		expect(result.rationale).toContain("grouping label")
	})

	it("penalises ruled-out entries that name no evidence", () => {
		const result = scoreUnknownDiscipline({
			suspectedCause: "unknown",
			confidence: "low",
			ruledOut: ["Deploy", "Saturation"],
		})
		expect(result.score).toBe(0.5)
	})

	it("penalises an unknown reported at high confidence", () => {
		const result = scoreUnknownDiscipline({
			suspectedCause: "unknown",
			confidence: "high",
			ruledOut: [
				"Deploy: service.version was unchanged across 41k spans in the window.",
				"Downstream: ledger-api p99 stayed flat at 42ms throughout.",
			],
		})
		expect(result.score).toBe(0.5)
	})

	it("passes an unknown that says what it checked", () => {
		const result = scoreUnknownDiscipline({
			suspectedCause: "unknown — no signal in this window distinguishes the candidates",
			confidence: "low",
			ruledOut: [
				"Deploy: service.version is not emitted by this org at all.",
				"Saturation: no pool, queue or memory metrics are exported.",
			],
		})
		expect(result.score).toBe(1)
	})
})

describe("scoreCauseMatch", () => {
	it("passes a report that named the planted cause family", () => {
		expect(
			scoreCauseMatch({ suspectedCause: "Connection pool exhaustion in payments-api." }, POOL).score,
		).toBe(1)
	})

	it("fails a report that named the wrong family", () => {
		expect(scoreCauseMatch({ suspectedCause: "A traffic spike overwhelmed it." }, POOL).score).toBe(0)
	})

	/** The anti-confabulation assertion: a confident guess here is worse than a shrug. */
	it("scores zero for naming ANY cause on the unknowable fixture", () => {
		const result = scoreCauseMatch(
			{ suspectedCause: "A deploy at 03:10 introduced the failure." },
			UNKNOWABLE,
		)
		expect(result.score).toBe(0)
		expect(result.rationale).toContain("unknowable")
	})

	it("passes an honest unknown on the unknowable fixture", () => {
		expect(scoreCauseMatch({ suspectedCause: "unknown" }, UNKNOWABLE).score).toBe(1)
	})
})

describe("scorePlanRelevance", () => {
	/**
	 * The dead-lens regression. The fixed catalogue dispatched a saturation lane at
	 * an org exporting no resource metrics on every single run.
	 */
	it("fails a plan proposing saturation where no resource metrics exist", () => {
		const result = scorePlanRelevance(
			{
				hypotheses: [
					{ name: "Resource saturation", claimToTest: "A pool hit its ceiling." },
					{ name: "The 14:02 rollout", claimToTest: "Commit c7d3e02 introduced it." },
				],
			},
			DEPLOY,
		)
		expect(result.score).toBe(0)
		expect(result.rationale).toContain("no evidence source")
	})

	it("passes a plan that covers the planted cause and nothing unanswerable", () => {
		const result = scorePlanRelevance(
			{
				hypotheses: [
					{ name: "The 14:02 rollout", claimToTest: "Commit c7d3e02 introduced the null deref." },
					{ name: "Traffic shape", claimToTest: "Volume moved against the baseline." },
				],
			},
			DEPLOY,
		)
		expect(result.score).toBe(1)
	})

	it("half-credits a plan that avoided the unanswerable but missed the cause", () => {
		const result = scorePlanRelevance(
			{ hypotheses: [{ name: "Traffic shape", claimToTest: "Volume moved." }] },
			DEPLOY,
		)
		expect(result.score).toBe(0.5)
	})

	it("fails an empty plan", () => {
		expect(scorePlanRelevance({ hypotheses: [] }, DEPLOY).score).toBe(0)
	})

	it("passes a plan on the unknowable fixture that proposed nothing unanswerable", () => {
		const result = scorePlanRelevance(
			{
				hypotheses: [
					{
						name: "Status-message-only errors",
						claimToTest: "The failing spans share one operation, visible in the span names.",
					},
				],
			},
			UNKNOWABLE,
		)
		expect(result.score).toBe(1)
	})
})
