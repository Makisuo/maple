import type { V2Investigation } from "@maple/domain/http/v2"
import { describe, expect, it } from "vitest"

import {
	investigationFinding,
	investigationHeadline,
	investigationKindKey,
	investigationScope,
	matchesQuery,
	sortInvestigations,
	splitDuration,
} from "./investigation-display"

const make = (overrides: Partial<V2Investigation> = {}): V2Investigation =>
	({
		id: "inv_1",
		object: "investigation",
		status: "diagnosed",
		subject: { type: "incident", incident_kind: "alert", incident_id: "inc_1", issue_id: null },
		snapshot: {
			title: "Checkout timeout rate increased",
			scope: "checkout-api",
			status: "open",
			severity: "high",
			facts: [],
			references: [],
			incidentStartedAt: null,
			incidentEndedAt: null,
		},
		report: null,
		model: null,
		severity: "high",
		confidence: "high",
		seeded_by: "system",
		created_by: null,
		input_tokens: null,
		output_tokens: null,
		error: null,
		created_at: "2026-07-20T09:00:00.000Z",
		diagnosed_at: null,
		updated_at: "2026-07-20T09:00:00.000Z",
		...overrides,
	}) as V2Investigation

const withSnapshot = (snapshot: Partial<V2Investigation["snapshot"]>): V2Investigation =>
	make({ snapshot: { ...make().snapshot, ...snapshot } as V2Investigation["snapshot"] })

/**
 * The list used to print "Alert incident" in the title slot and the only
 * informative text — the scope — in a muted subtitle, next to a Kind column
 * that also said "Alert". These rules are that fix.
 */
describe("investigationHeadline", () => {
	it("keeps a title that says something", () => {
		expect(investigationHeadline(make())).toBe("Checkout timeout rate increased")
	})

	it("promotes the scope when the title is the API's placeholder", () => {
		const investigation = withSnapshot({
			title: "Alert incident",
			scope: "subscriptions-api public endpoints",
		})
		expect(investigationHeadline(investigation)).toBe("subscriptions-api public endpoints")
	})

	it.each(["Error incident", "Anomaly incident", "Alert incident"])(
		"treats %s as a placeholder",
		(title) => {
			expect(investigationHeadline(withSnapshot({ title, scope: "billing-api" }))).toBe("billing-api")
		},
	)

	it("does not mistake a real title that merely contains the word incident", () => {
		const title = "Alert incident volume doubled"
		expect(investigationHeadline(withSnapshot({ title }))).toBe(title)
	})

	it("falls back to the report's scope, then to the placeholder itself", () => {
		const withReport = make({
			snapshot: { ...make().snapshot, title: "Alert incident", scope: null },
			report: {
				summary: "s",
				suspectedCause: "c",
				severityAssessment: "high",
				affectedScope: "dash-api only",
				evidence: [],
				suggestedActions: [],
				confidence: "high",
			},
		} as Partial<V2Investigation>)
		expect(investigationHeadline(withReport)).toBe("dash-api only")
		expect(investigationHeadline(withSnapshot({ title: "Alert incident", scope: null }))).toBe(
			"Alert incident",
		)
	})
})

describe("investigationScope", () => {
	it("keeps the scope line when the headline came from the title", () => {
		expect(investigationScope(make())).toBe("checkout-api")
	})

	it("drops it once the headline has promoted it, so the row can't say it twice", () => {
		expect(investigationScope(withSnapshot({ title: "Alert incident" }))).toBeNull()
	})
})

/** Every lifecycle state has something to say — a blank cell was the old bug. */
describe("investigationFinding", () => {
	it("shows the suspected cause once a diagnosis lands", () => {
		const investigation = make({
			report: {
				summary: "Checkout is timing out",
				suspectedCause: "Retry budget exhausted",
				severityAssessment: "high",
				affectedScope: "checkout-api",
				evidence: [],
				suggestedActions: [],
				confidence: "high",
			},
		} as Partial<V2Investigation>)
		expect(investigationFinding(investigation)).toEqual({
			kind: "cause",
			text: "Retry budget exhausted",
		})
	})

	it("says a running pass is running, even if an older report is attached", () => {
		expect(investigationFinding(make({ status: "investigating" })).kind).toBe("pending")
	})

	it("surfaces the failure reason, which was on the wire and rendered nowhere", () => {
		expect(investigationFinding(make({ status: "failed", error: "Model timed out" }))).toEqual({
			kind: "failure",
			text: "Model timed out",
		})
	})

	it("never leaves a failed row silent about why", () => {
		expect(investigationFinding(make({ status: "failed", error: null })).kind).toBe("failure")
	})

	it("reports nothing to show when a resolved run has no report", () => {
		expect(investigationFinding(make({ status: "resolved" }))).toEqual({ kind: "none" })
	})
})

describe("investigationKindKey", () => {
	it("reads a freeform subject as a question", () => {
		expect(investigationKindKey({ type: "freeform" } as never)).toBe("question")
		expect(investigationKindKey(make().subject)).toBe("alert")
	})
})

describe("matchesQuery", () => {
	const investigation = make({
		report: {
			summary: "s",
			suspectedCause: "Retry budget exhausted",
			severityAssessment: "high",
			affectedScope: "checkout-api",
			evidence: [],
			suggestedActions: [],
			confidence: "high",
		},
	} as Partial<V2Investigation>)

	it("matches what the row actually renders, case-insensitively", () => {
		expect(matchesQuery(investigation, "TIMEOUT")).toBe(true)
		expect(matchesQuery(investigation, "retry budget")).toBe(true)
		expect(matchesQuery(investigation, "checkout-api")).toBe(true)
		expect(matchesQuery(investigation, "kafka")).toBe(false)
	})

	it("matches everything on an empty query", () => {
		expect(matchesQuery(investigation, "   ")).toBe(true)
	})
})

describe("sortInvestigations", () => {
	const at = (id: string, updated: string, extra: Partial<V2Investigation> = {}) =>
		make({ id, updated_at: updated, ...extra } as Partial<V2Investigation>)

	it("defaults to newest-updated first, which is what the column header claims", () => {
		const rows = [at("inv_old", "2026-07-01T00:00:00.000Z"), at("inv_new", "2026-07-20T00:00:00.000Z")]
		expect(sortInvestigations(rows, "updated", "desc").map((r) => r.id)).toEqual(["inv_new", "inv_old"])
		expect(sortInvestigations(rows, "updated", "asc").map((r) => r.id)).toEqual(["inv_old", "inv_new"])
	})

	it("puts the most severe first on a descending severity sort", () => {
		const rows = [
			at("inv_low", "2026-07-01T00:00:00.000Z", { severity: "low" }),
			at("inv_crit", "2026-07-01T00:00:00.000Z", { severity: "critical" }),
			at("inv_med", "2026-07-01T00:00:00.000Z", { severity: "medium" }),
		]
		expect(sortInvestigations(rows, "severity", "desc").map((r) => r.id)).toEqual([
			"inv_crit",
			"inv_med",
			"inv_low",
		])
	})

	it("sinks rows with no value to the bottom in both directions", () => {
		const rows = [
			at("inv_none", "2026-07-01T00:00:00.000Z", {
				severity: null,
				snapshot: { ...make().snapshot, severity: null } as V2Investigation["snapshot"],
			}),
			at("inv_low", "2026-07-01T00:00:00.000Z", { severity: "low" }),
		]
		expect(sortInvestigations(rows, "severity", "asc").map((r) => r.id)).toEqual(["inv_low", "inv_none"])
		expect(sortInvestigations(rows, "severity", "desc").map((r) => r.id)).toEqual(["inv_low", "inv_none"])
	})

	it("breaks ties by newest-updated so re-sorting is stable", () => {
		const rows = [
			at("inv_a", "2026-07-01T00:00:00.000Z", { confidence: "high" }),
			at("inv_b", "2026-07-20T00:00:00.000Z", { confidence: "high" }),
		]
		expect(sortInvestigations(rows, "confidence", "desc").map((r) => r.id)).toEqual(["inv_b", "inv_a"])
	})

	it("falls back to the snapshot severity when the report hasn't denormalized one", () => {
		const rows = [
			at("inv_snapshot", "2026-07-01T00:00:00.000Z", {
				severity: null,
				snapshot: { ...make().snapshot, severity: "critical" } as V2Investigation["snapshot"],
			}),
			at("inv_low", "2026-07-01T00:00:00.000Z", { severity: "low" }),
		]
		expect(sortInvestigations(rows, "severity", "desc").map((r) => r.id)).toEqual([
			"inv_snapshot",
			"inv_low",
		])
	})
})

describe("splitDuration", () => {
	it("collapses sub-second durations rather than showing microseconds", () => {
		expect(splitDuration(0)).toEqual({ value: "<1", unit: "s" })
		expect(splitDuration(500)).toEqual({ value: "<1", unit: "s" })
		expect(splitDuration(999)).toEqual({ value: "<1", unit: "s" })
	})

	it("shows whole seconds under a minute", () => {
		expect(splitDuration(1000)).toEqual({ value: "1", unit: "s" })
		expect(splitDuration(42_000)).toEqual({ value: "42", unit: "s" })
		// Floors rather than rounds: 59.6s must not display "60 s".
		expect(splitDuration(59_600)).toEqual({ value: "59", unit: "s" })
	})

	it("switches to m:ss at a minute so every second stays visible", () => {
		expect(splitDuration(60_000)).toEqual({ value: "1:00", unit: "min" })
		expect(splitDuration(187_000)).toEqual({ value: "3:07", unit: "min" })
		expect(splitDuration(3_599_000)).toEqual({ value: "59:59", unit: "min" })
	})

	it("switches to h:mm:ss at an hour", () => {
		expect(splitDuration(3_600_000)).toEqual({ value: "1:00:00", unit: "h" })
		expect(splitDuration(3_862_000)).toEqual({ value: "1:04:22", unit: "h" })
		expect(splitDuration(93_784_000)).toEqual({ value: "26:03:04", unit: "h" })
	})
})
