/**
 * The routing table, as a table.
 *
 * This replaces `fanout-policy.test.ts`, which passed while the thing it tested
 * could not run: it asserted the sizing arithmetic and the severity gate without
 * ever asserting that a real incident reached the multi-hypothesis path. Every
 * case below is one of the three independent reasons it never did.
 */
import { describe, expect, it } from "vitest"
import { InvestigationSubject, InvestigationSubjectSnapshot, type IssueSeverity } from "@maple/domain/http"
import { Schema } from "effect"
import { routeInvestigation } from "./investigation-route"

const incident = (incidentKind: "error" | "alert" | "anomaly") =>
	Schema.decodeUnknownSync(InvestigationSubject)({
		type: "incident",
		incidentKind,
		incidentId: "inc_1",
	})

const freeform = Schema.decodeUnknownSync(InvestigationSubject)({
	type: "freeform",
	title: "Why is checkout slow?",
	prompt: "Why is checkout slow?",
	contextRefs: [],
})

const snapshot = (severity: IssueSeverity | null) =>
	Schema.decodeUnknownSync(InvestigationSubjectSnapshot)({
		title: "Checkout timeouts",
		scope: "checkout-api",
		status: "open",
		severity,
		facts: [],
		references: [],
		incidentStartedAt: null,
		incidentEndedAt: null,
	})

describe("routeInvestigation", () => {
	/**
	 * The regression that matters most. Error incidents carry no severity until
	 * someone triages them, and the old gate required one — so the highest-volume
	 * incident kind could never reach the multi-hypothesis path at all.
	 */
	it("plans an incident with no severity at all", () => {
		expect(routeInvestigation({ subject: incident("error"), snapshot: snapshot(null) }).kind).toBe(
			"planned",
		)
	})

	it("plans an incident with no snapshot at all", () => {
		expect(routeInvestigation({ subject: incident("error"), snapshot: null }).kind).toBe("planned")
	})

	it.each(["critical", "high", "medium", "low"] as const)("plans a %s incident", (severity) => {
		expect(routeInvestigation({ subject: incident("alert"), snapshot: snapshot(severity) }).kind).toBe(
			"planned",
		)
	})

	/**
	 * There is no setting that can make an incident skip planning. The flag this
	 * replaced defaulted off and had no write path, so the good behaviour was the
	 * one nobody could switch on; a well-behaved toggle would still leave a way to
	 * get the shallow version by accident.
	 */
	it.each(["error", "alert", "anomaly"] as const)(
		"has no configuration that keeps a %s incident on one pass",
		(kind) => {
			expect(routeInvestigation({ subject: incident(kind), snapshot: snapshot(null) }).kind).toBe(
				"planned",
			)
		},
	)

	/** A free-form question is a conversation; there is no incident to scope. */
	it("keeps free-form questions on the single pass", () => {
		expect(routeInvestigation({ subject: freeform, snapshot: null })).toEqual({
			kind: "single_pass",
			reason: "freeform",
		})
	})

	it("reserves the width plus the planner and the validator", () => {
		expect(
			routeInvestigation({ subject: incident("error"), snapshot: snapshot("critical") }),
		).toMatchObject({ kind: "planned", maxWidth: 5, reservedPasses: 7 })
	})

	it("narrows an anomaly, which is already a claim about one signal", () => {
		expect(
			routeInvestigation({ subject: incident("anomaly"), snapshot: snapshot("critical") }),
		).toMatchObject({ kind: "planned", maxWidth: 3, reservedPasses: 5 })
	})
})
