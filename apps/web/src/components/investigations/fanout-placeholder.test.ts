import type { V2Investigation } from "@maple/domain/http/v2"
import { describe, expect, it } from "vitest"

import {
	LENS_CATALOGUE,
	checksHeld,
	fanoutSize,
	hasFanout,
	lensTally,
	placeholderBlastRadius,
	placeholderChecks,
	placeholderLenses,
	placeholderRunSteps,
	placeholderValidator,
} from "./fanout-placeholder"

const make = (overrides: Partial<V2Investigation> = {}): V2Investigation =>
	({
		id: "inv_1",
		object: "investigation",
		status: "diagnosed",
		subject: { type: "incident", incident_kind: "error", incident_id: "einc_1", issue_id: null },
		snapshot: {
			title: "Checkout timeouts after deploy 8f21c",
			scope: "checkout-api",
			status: "open",
			severity: "critical",
			facts: [],
			references: [],
			incidentStartedAt: null,
			incidentEndedAt: null,
		},
		report: null,
		model: null,
		severity: "critical",
		confidence: "high",
		seeded_by: "system",
		created_by: null,
		input_tokens: null,
		output_tokens: null,
		error: null,
		created_at: "2026-07-20T09:00:00.000Z",
		diagnosed_at: "2026-07-20T09:00:38.000Z",
		updated_at: "2026-07-20T09:00:38.000Z",
		...overrides,
	}) as V2Investigation

/**
 * The whole point of the module: a lane that renumbered itself on every 3s poll
 * would read as the run changing its mind. Nothing here may depend on wall clock
 * or `Math.random`.
 */
describe("determinism", () => {
	it("returns identical lanes for the same investigation", () => {
		const investigation = make()
		expect(placeholderLenses(investigation)).toEqual(placeholderLenses(investigation))
		expect(placeholderChecks(investigation)).toEqual(placeholderChecks(investigation))
		expect(placeholderBlastRadius(investigation)).toEqual(placeholderBlastRadius(investigation))
	})

	it("differs between investigations, or every page would look the same", () => {
		const a = placeholderBlastRadius(make({ id: "inv_aaa" } as Partial<V2Investigation>))
		const b = placeholderBlastRadius(make({ id: "inv_zzz" } as Partial<V2Investigation>))
		expect(a).not.toEqual(b)
	})
})

describe("fanoutSize", () => {
	it("gives a freeform question one agent and no fan-out", () => {
		const investigation = make({
			subject: { type: "freeform", title: "why slow", prompt: "why slow", context_refs: [] },
		} as Partial<V2Investigation>)
		expect(fanoutSize(investigation)).toBe(1)
		expect(hasFanout(investigation)).toBe(false)
	})

	it("scales an alert to the full catalogue", () => {
		const investigation = make({
			subject: { type: "incident", incident_kind: "alert", incident_id: "inc_1", issue_id: null },
		} as Partial<V2Investigation>)
		expect(fanoutSize(investigation)).toBe(LENS_CATALOGUE.length)
	})

	it("scales an error incident by severity", () => {
		expect(fanoutSize(make({ severity: "critical" } as Partial<V2Investigation>))).toBe(5)
		expect(fanoutSize(make({ severity: "high" } as Partial<V2Investigation>))).toBe(4)
		expect(fanoutSize(make({ severity: "medium" } as Partial<V2Investigation>))).toBe(3)
		expect(fanoutSize(make({ severity: "low" } as Partial<V2Investigation>))).toBe(2)
	})

	it("caps an anomaly at two regardless of severity", () => {
		const investigation = make({
			subject: { type: "incident", incident_kind: "anomaly", incident_id: "anom_1", issue_id: null },
			severity: "critical",
		} as Partial<V2Investigation>)
		expect(fanoutSize(investigation)).toBe(2)
	})

	it("never dispatches more lenses than the catalogue holds", () => {
		expect(placeholderLenses(make())).toHaveLength(LENS_CATALOGUE.length)
	})
})

describe("placeholderLenses", () => {
	it("promotes exactly one candidate on a diagnosed run", () => {
		const tally = lensTally(placeholderLenses(make()))
		expect(tally.promoted).toBe(1)
		expect(tally.merged).toBeLessThanOrEqual(1)
		expect(tally.promoted + tally.merged + tally.ruledOut).toBe(tally.total)
	})

	it("states the real diagnosis on the promoted lane rather than a template", () => {
		const investigation = make({
			report: {
				summary: "s",
				suspectedCause: "Connection pool exhaustion in checkout-api",
				severityAssessment: "critical",
				affectedScope: "checkout",
				evidence: [],
				suggestedActions: [],
				confidence: "high",
			},
		} as unknown as Partial<V2Investigation>)
		const promoted = placeholderLenses(investigation).find((lens) => lens.verdict === "promoted")
		expect(promoted?.claim).toBe("Connection pool exhaustion in checkout-api")
	})

	it("leaves at least one lens unfinished while investigating", () => {
		const lenses = placeholderLenses(make({ status: "investigating" }))
		expect(lenses.some((lens) => lens.status !== "reported")).toBe(true)
		expect(lenses.every((lens) => lens.verdict === "pending")).toBe(true)
	})

	it("rejects every candidate on a failed run", () => {
		const lenses = placeholderLenses(make({ status: "failed" }))
		expect(lenses.every((lens) => lens.verdict === "rejected")).toBe(true)
		expect(lensTally(lenses).promoted).toBe(0)
	})

	it("gives every rejected lane a reason — a verdict without one proves nothing", () => {
		for (const status of ["diagnosed", "failed"] as const) {
			for (const lens of placeholderLenses(make({ status }))) {
				if (lens.verdict === "promoted" || lens.verdict === "pending") continue
				expect(lens.reason).toBeTruthy()
			}
		}
	})
})

describe("placeholderValidator", () => {
	it("is absent when there is nothing to compare", () => {
		const investigation = make({
			subject: { type: "freeform", title: "q", prompt: "q", context_refs: [] },
		} as Partial<V2Investigation>)
		expect(placeholderValidator(investigation)).toBeNull()
	})

	it("is blocked while lenses are still reporting", () => {
		expect(placeholderValidator(make({ status: "investigating" }))?.status).toBe("blocked")
	})

	it("rejects all on a failed run", () => {
		expect(placeholderValidator(make({ status: "failed" }))?.status).toBe("rejected_all")
	})
})

describe("placeholderChecks", () => {
	it("runs one check per dispatched lens", () => {
		for (const status of ["investigating", "diagnosed", "failed", "resolved"] as const) {
			const investigation = make({ status })
			expect(placeholderChecks(investigation)).toHaveLength(fanoutSize(investigation))
		}
	})

	it("drops out entirely at a fan-out of one, like the rest of the fan-out UI", () => {
		const investigation = make({
			subject: { type: "freeform", title: "q", prompt: "q", context_refs: [] },
		} as Partial<V2Investigation>)
		expect(placeholderChecks(investigation)).toEqual([])
	})

	/**
	 * The regression this file exists to prevent: the rail used to generate its own
	 * verdicts, so a run whose validator rejected every candidate still showed three
	 * green ticks 300px away from "none of them held up".
	 */
	it("holds nothing when the validator promoted nothing", () => {
		const checks = placeholderChecks(make({ status: "failed" }))
		expect(checksHeld(checks)).toBe(0)
	})

	it("holds exactly the lenses the validator kept", () => {
		const investigation = make()
		const lenses = placeholderLenses(investigation)
		const kept = lenses.filter((lane) => lane.verdict === "promoted" || lane.verdict === "merged").length
		expect(checksHeld(placeholderChecks(investigation))).toBe(kept)
	})

	it("labels each check with the lens it summarises", () => {
		const investigation = make()
		expect(placeholderChecks(investigation).map((check) => check.key)).toEqual(
			placeholderLenses(investigation).map((lane) => lane.lens.id),
		)
	})

	it("leaves later checks unsettled while investigating", () => {
		const checks = placeholderChecks(make({ status: "investigating" }))
		expect(checks.some((check) => check.state === "checking")).toBe(true)
	})

	it("only blames the tool budget on a lens that actually ran out", () => {
		for (const status of ["investigating", "diagnosed", "resolved"] as const) {
			for (const check of placeholderChecks(make({ status }))) {
				expect(check.result).not.toContain("ran out of budget")
			}
		}
	})

	it("never renders an empty result line", () => {
		for (const status of ["investigating", "diagnosed", "failed", "resolved"] as const) {
			for (const check of placeholderChecks(make({ status }))) {
				expect(check.result.length).toBeGreaterThan(0)
			}
		}
	})
})

describe("placeholderRunSteps", () => {
	it("drops out entirely at a fan-out of one", () => {
		const investigation = make({
			subject: { type: "freeform", title: "q", prompt: "q", context_refs: [] },
		} as Partial<V2Investigation>)
		expect(placeholderRunSteps(investigation)).toEqual([])
	})

	it("ends on validation for a diagnosed run", () => {
		const steps = placeholderRunSteps(make())
		expect(steps.at(-1)?.key).toBe("validated")
	})

	it("ends on inconclusive validation for a failed run", () => {
		const steps = placeholderRunSteps(make({ status: "failed" }))
		expect(steps.at(-1)?.key).toBe("inconclusive")
		expect(steps.at(-1)?.tone).toBe("failed")
	})

	it("reports partial progress while investigating", () => {
		const steps = placeholderRunSteps(make({ status: "investigating" }))
		expect(steps.at(-1)?.tone).toBe("active")
	})
})

describe("placeholderBlastRadius", () => {
	it("keeps affected users under total events", () => {
		const { events, users } = placeholderBlastRadius(make())
		expect(users).toBeGreaterThan(0)
		expect(users).toBeLessThan(events)
	})
})
