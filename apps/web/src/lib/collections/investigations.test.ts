import { describe, expect, it } from "vitest"

import {
	deriveValidator,
	liveLensRuns,
	rowsToInvestigation,
	type InvestigationLensRunRow,
	type InvestigationRow,
} from "./investigations"

const row = (overrides: Partial<InvestigationRow> = {}): InvestigationRow => ({
	id: "88888888-8888-4888-8888-888888888888",
	org_id: "org_1",
	status: "diagnosed",
	seeded_by: "system",
	subject_json: {
		type: "incident",
		incidentKind: "error",
		incidentId: "018f2b3c-4d5e-6f70-8192-a3b4c5d6e7f8",
		issueId: "77777777-7777-4777-8777-777777777777",
	},
	snapshot_json: {
		title: "Checkout timeouts after deploy 8f21c",
		scope: "checkout-api",
		status: "open",
		severity: "critical",
		facts: [],
		references: [],
		incidentStartedAt: "2026-08-01T14:02:00.000Z",
		incidentEndedAt: null,
	},
	report_json: {
		summary: "checkout-api saturated its connection pool",
		suspectedCause: "Pool exhaustion in checkout-api",
		severityAssessment: "critical",
		affectedScope: "Checkout & payment capture",
		evidence: [],
		suggestedActions: ["Roll back deploy 8f21c"],
		confidence: "high",
	},
	severity: "critical",
	confidence: "high",
	model: "claude-opus-5",
	input_tokens: 12000,
	output_tokens: 800,
	error: null,
	fanout_state: "ranked",
	fanout_size: 2,
	fanout_attempt: 1,
	validator_note: null,
	validator_elapsed_ms: 8200,
	created_by: null,
	created_at: "2026-08-01T14:02:00.000Z",
	started_at: "2026-08-01T14:02:00.000Z",
	diagnosed_at: "2026-08-01T14:02:38.000Z",
	updated_at: "2026-08-01T14:02:38.000Z",
	...overrides,
})

const lens = (overrides: Partial<InvestigationLensRunRow> = {}): InvestigationLensRunRow => ({
	id: "lens-row-1",
	org_id: "org_1",
	investigation_id: "88888888-8888-4888-8888-888888888888",
	lens_id: "deploy_correlation",
	attempt: 1,
	ordinal: 0,
	status: "reported",
	verdict: "promoted",
	claim: "a deploy landed before the onset",
	reason: null,
	progress_note: null,
	confidence: "high",
	tool_count: 3,
	elapsed_ms: 9400,
	lens_name: null,
	lens_question: null,
	priority: null,
	deadline_hit: false,
	started_at: "2026-08-01T14:02:04.000Z",
	...overrides,
})

describe("rowsToInvestigation", () => {
	it("rebuilds the object the page renders", () => {
		const investigation = rowsToInvestigation(row(), [lens()])
		expect(investigation).not.toBeNull()
		expect(investigation).toMatchObject({
			object: "investigation",
			status: "diagnosed",
			subject: { type: "incident", incident_kind: "error" },
			report: { suspectedCause: "Pool exhaustion in checkout-api" },
			fanout: { state: "ranked", size: 2 },
		})
		// ms → seconds at one decimal, exactly as InvestigationService does it.
		expect(investigation?.lens_runs[0]).toMatchObject({ elapsedSeconds: 9.4, verdict: "promoted" })
	})

	/**
	 * The partial's payload has to survive the decode, and asserting the decode
	 * merely *succeeded* would not prove it: `rowsToInvestigation` runs
	 * `Schema.decodeUnknownOption`, which silently DROPS keys the schema does not
	 * declare. A `V2AiTriageResult` missing `ruledOut` / `unchecked` would pass a
	 * not-null check while shipping an inconclusive investigation with its entire
	 * result removed — so these assert the fields are present on the output.
	 */
	it("carries an inconclusive run's ruled-out and unchecked lists through the decode", () => {
		const investigation = rowsToInvestigation(
			row({
				status: "inconclusive",
				severity: null,
				confidence: "low",
				error: null,
				fanout_state: "rejected_all",
				validator_note: "no candidate survived",
				report_json: {
					summary: "Nothing held up.",
					suspectedCause: "Possibly the payments-api pool, unconfirmed",
					severityAssessment: "low",
					affectedScope: "checkout-api",
					evidence: [],
					suggestedActions: [],
					confidence: "low",
					ruledOut: ["Deploy: service.version unchanged across 41k spans"],
					unchecked: ["Pool depth: payments-api emits no connection metrics"],
				},
			}),
			[lens()],
		)
		expect(investigation?.status).toBe("inconclusive")
		expect(investigation?.report?.ruledOut).toEqual([
			"Deploy: service.version unchanged across 41k spans",
		])
		expect(investigation?.report?.unchecked).toEqual([
			"Pool depth: payments-api emits no connection metrics",
		])
	})

	/**
	 * `snapshot_json` is nullable in the table but non-nullable on the resource,
	 * and the page reads straight through it. Passing the null along was the bug a
	 * cast hid; the server has had `fallbackSnapshot` for this all along.
	 */
	it("substitutes a snapshot for an investigation opened without one", () => {
		const investigation = rowsToInvestigation(row({ snapshot_json: null }), [])
		expect(investigation?.snapshot).toMatchObject({
			title: "Error incident",
			facts: [{ label: "Incident", value: "018f2b3c-4d5e-6f70-8192-a3b4c5d6e7f8" }],
		})
	})

	it("carries a freeform subject through", () => {
		const investigation = rowsToInvestigation(
			row({
				subject_json: {
					type: "freeform",
					title: "why is checkout slow",
					prompt: "…",
					contextRefs: [],
				},
				snapshot_json: null,
			}),
			[],
		)
		expect(investigation?.subject).toMatchObject({ type: "freeform", title: "why is checkout slow" })
		expect(investigation?.snapshot.title).toBe("why is checkout slow")
	})

	/**
	 * A row we cannot read is reported, not guessed at. The server raises
	 * `InvestigationSubjectDecodeError` at the same point; here the page shows its
	 * retry rather than a chain built on an id nothing can open.
	 */
	it("returns null rather than a half-built object when the subject will not decode", () => {
		expect(
			rowsToInvestigation(row({ subject_json: { type: "incident", incidentKind: "error" } }), []),
		).toBeNull()
		expect(rowsToInvestigation(row({ status: "not-a-status" }), [])).toBeNull()
	})
})

describe("liveLensRuns", () => {
	/**
	 * A retried run leaves the previous attempt's lanes in the table. Rendering
	 * them beside the attempt that superseded them shows one run assembled from
	 * two — the same filter the service applies.
	 */
	it("keeps only the current attempt, in dispatch order", () => {
		const lanes = liveLensRuns(row({ fanout_attempt: 2 }), [
			lens({ id: "b", attempt: 2, ordinal: 1, lens_id: "second" }),
			lens({ id: "stale", attempt: 1, ordinal: 0, lens_id: "previous" }),
			lens({ id: "a", attempt: 2, ordinal: 0, lens_id: "first" }),
		])
		expect(lanes.map((lane) => lane.lens_id)).toEqual(["first", "second"])
	})

	it("ignores lanes belonging to another investigation", () => {
		expect(liveLensRuns(row(), [lens({ investigation_id: "other" })])).toHaveLength(0)
	})
})

describe("deriveValidator", () => {
	it("is absent before the fan-out has anything to validate", () => {
		expect(deriveValidator(row({ fanout_state: "none" }), [])).toBeNull()
		expect(deriveValidator(row({ fanout_state: "queued" }), [])).toBeNull()
	})

	it("blocks while the lanes are still reporting", () => {
		expect(
			deriveValidator(row({ fanout_state: "running" }), [lens({ status: "checking" })]),
		).toMatchObject({ status: "blocked" })
	})

	/** Mirrors `validatorFor`: an unwritten note falls back to the lane tally. */
	it("tallies the lanes when the run ranked without writing a note", () => {
		expect(
			deriveValidator(row({ fanout_state: "ranked", validator_note: null }), [
				lens({ verdict: "promoted" }),
				lens({ verdict: "ruled_out" }),
			]),
		).toMatchObject({
			status: "ranked",
			note: "1 promoted · 0 merged · 1 ruled out",
			elapsedSeconds: 8.2,
		})
	})

	it("prefers the stored note when there is one", () => {
		expect(
			deriveValidator(row({ fanout_state: "rejected_all", validator_note: "nothing survived" }), []),
		).toMatchObject({ status: "rejected_all", note: "nothing survived" })
	})
})
