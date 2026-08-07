/**
 * The normalization table, as a table.
 *
 * Every case here is a way a model can hand back something unusable, and each
 * one used to be a way an investigation could dispatch a lane that could not
 * work. The rule worth defending hardest is the tool intersection: a hypothesis
 * with no usable tools is dropped, not run — because a lane that cannot check
 * its claim does not report "inconclusive", it reports a guess.
 */
import { describe, expect, it } from "vitest"
import { InvestigationPlan, InvestigationSubject } from "@maple/domain/http"
import { Option, Schema } from "effect"
import { normalizePlan, widthFor } from "./plan-normalize"

const subject = Schema.decodeUnknownSync(InvestigationSubject)({
	type: "incident",
	incidentKind: "error",
	incidentId: "inc_1",
})

const hypothesis = (overrides: Record<string, unknown> = {}) => ({
	id: "pool_exhaustion",
	name: "Pool exhaustion",
	question: "Did the payments-api pool run out?",
	claimToTest: "payments-api pool acquisition blocks past 2s from 14:03.",
	rationale: "Saw acquisition waits in the sweep.",
	toolNames: ["query_data", "list_metrics"],
	priority: 1,
	seedLensId: null,
	...overrides,
})

const plan = (hypotheses: ReadonlyArray<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
	Option.some(
		Schema.decodeUnknownSync(InvestigationPlan)({
			scopeSummary: "scope",
			incidentStartedAt: null,
			incidentEndedAt: null,
			collapseReason: null,
			hypotheses,
			...extra,
		}),
	)

const context = { subject, snapshot: null, maxWidth: 4 }

describe("normalizePlan", () => {
	it("keeps a well-formed plan as written", () => {
		const result = normalizePlan(plan([hypothesis()]), { ...context, maxWidth: 4 })
		expect(result.hypotheses.map((h) => h.id)).toEqual(["pool_exhaustion"])
		expect(result.usedSeedFallback).toBe(false)
		expect(result.notes).toEqual([])
	})

	it("falls back to the seed catalogue when the planner produced nothing", () => {
		const result = normalizePlan(Option.none(), context)
		expect(result.usedSeedFallback).toBe(true)
		expect(result.hypotheses.length).toBeGreaterThan(0)
		expect(result.hypotheses.every((h) => h.seedLensId !== null)).toBe(true)
		// Narrower than maxWidth: these were not selected on evidence, so spending a
		// critical incident's full width on standing questions buys breadth, not fit.
		expect(result.hypotheses.length).toBeLessThanOrEqual(3)
	})

	it("slugifies an id the model wrote as prose", () => {
		const result = normalizePlan(plan([hypothesis({ id: "Pool exhaustion in payments-api!" })]), context)
		expect(result.hypotheses[0]!.id).toBe("pool_exhaustion_in_payments_api")
	})

	it("falls back to the name when the id slugs to nothing", () => {
		const result = normalizePlan(plan([hypothesis({ id: "***" })]), context)
		expect(result.hypotheses[0]!.id).toBe("pool_exhaustion")
	})

	/**
	 * The id keys `(investigation_id, attempt, lens_id)`. Two colliding ids would
	 * silently collapse into one lane through `onConflictDoNothing`, so the second
	 * hypothesis would be paid for and never dispatched.
	 */
	it("suffixes a duplicate id rather than losing the lane", () => {
		const result = normalizePlan(
			plan([hypothesis(), hypothesis({ name: "Also pool", priority: 2 })]),
			context,
		)
		expect(result.hypotheses.map((h) => h.id)).toEqual(["pool_exhaustion", "pool_exhaustion_2"])
	})

	it("drops tools that are not in the universe, and says so", () => {
		const result = normalizePlan(
			plan([hypothesis({ toolNames: ["query_data", "restart_the_database"] })]),
			context,
		)
		expect(result.hypotheses[0]!.toolNames).toEqual(["query_data"])
		expect(result.notes.join(" ")).toContain("unknown tool")
	})

	/** The `config_flags` failure mode, caught mechanically instead of by a comment. */
	it("drops a hypothesis left with no tools at all", () => {
		const result = normalizePlan(
			plan([
				hypothesis(),
				hypothesis({
					id: "flag_flip",
					name: "Flag flip",
					toolNames: ["read_feature_flags"],
					priority: 2,
				}),
			]),
			context,
		)
		expect(result.hypotheses.map((h) => h.id)).toEqual(["pool_exhaustion"])
		expect(result.notes.join(" ")).toContain("none of its tools exist")
	})

	it("falls back to seeds when nothing survives normalization", () => {
		const result = normalizePlan(plan([hypothesis({ toolNames: ["nope"] })]), context)
		expect(result.usedSeedFallback).toBe(true)
	})

	it("truncates to maxWidth by priority, not by submission order", () => {
		const result = normalizePlan(
			plan([
				hypothesis({ id: "third", name: "Third", priority: 3 }),
				hypothesis({ id: "first", name: "First", priority: 1 }),
				hypothesis({ id: "second", name: "Second", priority: 2 }),
			]),
			{ ...context, maxWidth: 2 },
		)
		expect(result.hypotheses.map((h) => h.id)).toEqual(["first", "second"])
		expect(result.notes.join(" ")).toContain("kept the top 2 of 3")
	})

	it("collapses on a single hypothesis and keeps the planner's reason", () => {
		const result = normalizePlan(
			plan([hypothesis()], { collapseReason: "One exception type, one service." }),
			context,
		)
		expect(result.collapsed).toBe(true)
		expect(result.collapseReason).toBe("One exception type, one service.")
	})

	/**
	 * A collapse with no stated reason is indistinguishable from a planner that
	 * gave up, so one is synthesized rather than left null.
	 */
	it("synthesizes a collapse reason when the planner omitted one", () => {
		const result = normalizePlan(plan([hypothesis()]), context)
		expect(result.collapsed).toBe(true)
		expect(result.collapseReason).toContain("Only one hypothesis")
	})

	it("prefers the planner's interval over the snapshot's", () => {
		const result = normalizePlan(
			plan([hypothesis(), hypothesis({ id: "other", priority: 2 })], {
				incidentStartedAt: "2026-08-06T14:00:00.000Z",
			}),
			context,
		)
		expect(result.incidentStartedAt).toBe("2026-08-06T14:00:00.000Z")
	})
})

describe("widthFor", () => {
	/**
	 * A null severity is unclassified, not unimportant. Error incidents carry no
	 * severity until someone triages them, so treating null as the floor would give
	 * the highest-volume incident kind the thinnest investigations.
	 */
	it("treats an unclassified incident as medium, not as the minimum", () => {
		expect(widthFor(null, "error")).toBe(4)
		expect(widthFor("medium", "error")).toBe(4)
	})

	it("scales with severity", () => {
		expect(widthFor("critical", "error")).toBe(5)
		expect(widthFor("high", "error")).toBe(4)
		expect(widthFor("low", "error")).toBe(3)
	})

	/** An anomaly is already a narrow claim about one signal. */
	it("caps anomalies below the others regardless of severity", () => {
		expect(widthFor("critical", "anomaly")).toBe(3)
	})
})
