import type { InvestigationSubject, InvestigationSubjectSnapshot, IssueSeverity } from "@maple/domain/http"
import { describe, expect, it } from "vitest"

import { LENS_DISPATCH_ORDER, fanoutPlan, fanoutSize, shouldFanOut } from "./fanout-policy"

const incident = (kind: "error" | "anomaly" | "alert"): InvestigationSubject =>
	({ type: "incident", incidentKind: kind, incidentId: "inc_1" }) as InvestigationSubject

const freeform: InvestigationSubject = {
	type: "freeform",
	title: "why slow",
	prompt: "why slow",
	contextRefs: [],
} as unknown as InvestigationSubject

const snap = (severity: IssueSeverity | null): InvestigationSubjectSnapshot =>
	({
		title: "t",
		scope: "checkout-api",
		status: "open",
		severity,
		facts: [],
		references: [],
		incidentStartedAt: null,
		incidentEndedAt: null,
	}) as InvestigationSubjectSnapshot

describe("fanoutSize", () => {
	it("gives a freeform question one agent — there is nothing to compare", () => {
		expect(fanoutSize(freeform, snap("critical"))).toBe(1)
	})

	it("scales an alert to the full catalogue regardless of severity", () => {
		expect(fanoutSize(incident("alert"), snap("low"))).toBe(LENS_DISPATCH_ORDER.length)
	})

	it("caps an anomaly at two regardless of severity", () => {
		expect(fanoutSize(incident("anomaly"), snap("critical"))).toBe(2)
	})

	it("scales an error incident by severity", () => {
		expect(fanoutSize(incident("error"), snap("critical"))).toBe(5)
		expect(fanoutSize(incident("error"), snap("high"))).toBe(4)
		expect(fanoutSize(incident("error"), snap("medium"))).toBe(3)
		expect(fanoutSize(incident("error"), snap("low"))).toBe(2)
		expect(fanoutSize(incident("error"), snap(null))).toBe(3)
	})
})

const FANOUT_ON_AUTOMATIC = new Set(["critical", "high"])

describe("shouldFanOut", () => {
	it("is off entirely while the org flag is off", () => {
		expect(
			shouldFanOut({
				subject: incident("error"),
				snapshot: snap("critical"),
				automatic: false,
				enabled: false,
			}),
		).toBe(false)
	})

	it("always fans out a manual start — the person already chose to wait", () => {
		for (const severity of ["critical", "high", "medium", "low"] as const) {
			expect(
				shouldFanOut({
					subject: incident("error"),
					snapshot: snap(severity),
					automatic: true,
					enabled: true,
				}),
			).toBe(FANOUT_ON_AUTOMATIC.has(severity))
			expect(
				shouldFanOut({
					subject: incident("error"),
					snapshot: snap(severity),
					automatic: false,
					enabled: true,
				}),
			).toBe(true)
		}
	})

	it("never fans out a freeform question", () => {
		expect(
			shouldFanOut({ subject: freeform, snapshot: snap("critical"), automatic: false, enabled: true }),
		).toBe(false)
	})

	it("treats a missing severity on an automatic trigger as not worth the spend", () => {
		expect(
			shouldFanOut({ subject: incident("error"), snapshot: null, automatic: true, enabled: true }),
		).toBe(false)
	})
})

describe("fanoutPlan", () => {
	/**
	 * The collision the two functions exist to keep apart: the sizing table says 5
	 * because it is an alert, the gate says no because it arrived automatically at
	 * medium severity. Size must win nothing here — the run is single-pass, and
	 * critically it dispatches zero lenses, so the UI does not render a Hypotheses
	 * tab over an empty array.
	 */
	it("does not dispatch lenses for an automatic medium alert, despite a size of 5", () => {
		const input = {
			subject: incident("alert"),
			snapshot: snap("medium"),
			automatic: true,
			enabled: true,
		}
		expect(fanoutSize(input.subject, input.snapshot)).toBe(5)
		const plan = fanoutPlan(input)
		expect(plan.size).toBe(1)
		expect(plan.lenses).toEqual([])
		expect(plan.passCount).toBe(1)
	})

	it("charges the validator as a pass", () => {
		const plan = fanoutPlan({
			subject: incident("error"),
			snapshot: snap("critical"),
			automatic: false,
			enabled: true,
		})
		expect(plan.size).toBe(5)
		expect(plan.passCount).toBe(6)
		expect(plan.lenses).toEqual(LENS_DISPATCH_ORDER)
	})

	it("takes lenses from the front of the dispatch order", () => {
		const plan = fanoutPlan({
			subject: incident("anomaly"),
			snapshot: snap("critical"),
			automatic: false,
			enabled: true,
		})
		expect(plan.lenses).toEqual(LENS_DISPATCH_ORDER.slice(0, 2))
	})

	it("collapses a size-1 subject to the single pass rather than a one-lens fan-out", () => {
		const plan = fanoutPlan({
			subject: freeform,
			snapshot: snap("critical"),
			automatic: false,
			enabled: true,
		})
		expect(plan).toEqual({ size: 1, lenses: [], passCount: 1 })
	})
})
