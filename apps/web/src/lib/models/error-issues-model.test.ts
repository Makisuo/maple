import { describe, expect, it } from "vitest"
import type { ActorRow, ErrorIssueRow } from "@/lib/collections/errors"
import { deriveErrorIssues, filterIssues, ISSUES_PAGE_LIMIT } from "./error-issues-model"

const NOW = Date.parse("2026-07-06T12:00:00.000Z")
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

const ISSUE_A = "00000000-0000-4000-8000-00000000000a"
const ISSUE_B = "00000000-0000-4000-8000-00000000000b"
const ISSUE_C = "00000000-0000-4000-8000-00000000000c"
const ACTOR_1 = "00000000-0000-4000-8000-0000000000a1"

function makeIssueRow(overrides: Partial<ErrorIssueRow> = {}): ErrorIssueRow {
	return {
		id: ISSUE_A,
		org_id: "org_test",
		kind: "error",
		source_ref_json: null,
		fingerprint_hash: "fp",
		service_name: "api",
		exception_type: "TypeError",
		exception_message: "boom",
		error_label: "TypeError",
		top_frame: "handler",
		workflow_state: "triage",
		priority: 3,
		severity: null,
		severity_source: null,
		assigned_actor_id: null,
		lease_holder_actor_id: null,
		lease_expires_at: null,
		claimed_at: null,
		notes: null,
		first_seen_at: iso(60 * 60_000),
		last_seen_at: iso(60_000),
		occurrence_count: 5,
		resolved_at: null,
		resolved_by_actor_id: null,
		snooze_until: null,
		archived_at: null,
		created_at: iso(60 * 60_000),
		updated_at: iso(60_000),
		...overrides,
	}
}

function makeActorRow(overrides: Partial<ActorRow> = {}): ActorRow {
	return {
		id: ACTOR_1,
		org_id: "org_test",
		type: "agent",
		user_id: null,
		agent_name: "triage-bot",
		model: null,
		capabilities_json: [],
		created_by: null,
		created_at: iso(60 * 60_000),
		last_active_at: null,
		...overrides,
	}
}

describe("deriveErrorIssues", () => {
	it("orders issues most recently seen first", () => {
		const issues = deriveErrorIssues({
			issues: [
				makeIssueRow({ id: ISSUE_A, last_seen_at: iso(3 * 60_000) }),
				makeIssueRow({ id: ISSUE_B, last_seen_at: iso(60_000) }),
				makeIssueRow({ id: ISSUE_C, last_seen_at: iso(2 * 60_000) }),
			],
			actors: [],
			openIncidentIssueIds: new Set(),
		})
		expect(issues.map((i) => i.id)).toEqual([ISSUE_B, ISSUE_C, ISSUE_A])
	})

	it("joins assigned actors and degrades a missing actor to null", () => {
		const issues = deriveErrorIssues({
			issues: [
				makeIssueRow({ id: ISSUE_A, assigned_actor_id: ACTOR_1 }),
				makeIssueRow({ id: ISSUE_B, assigned_actor_id: "00000000-0000-4000-8000-0000000000a2" }),
			],
			actors: [makeActorRow({ id: ACTOR_1 })],
			openIncidentIssueIds: new Set(),
		})
		const byId = new Map(issues.map((i) => [i.id as string, i]))
		expect(byId.get(ISSUE_A)?.assignedActor?.agentName).toBe("triage-bot")
		// The actors shape has no row for the id — same as the server's LEFT JOIN miss.
		expect(byId.get(ISSUE_B)?.assignedActor).toBeNull()
	})

	it("marks hasOpenIncident from open-incident membership", () => {
		const issues = deriveErrorIssues({
			issues: [makeIssueRow({ id: ISSUE_A }), makeIssueRow({ id: ISSUE_B, last_seen_at: iso(2 * 60_000) })],
			actors: [],
			openIncidentIssueIds: new Set([ISSUE_A]),
		})
		const byId = new Map(issues.map((i) => [i.id as string, i]))
		expect(byId.get(ISSUE_A)?.hasOpenIncident).toBe(true)
		expect(byId.get(ISSUE_B)?.hasOpenIncident).toBe(false)
	})
})

describe("filterIssues", () => {
	const derived = deriveErrorIssues({
		issues: [
			makeIssueRow({ id: ISSUE_A, workflow_state: "triage", severity: "high", kind: "error" }),
			makeIssueRow({ id: ISSUE_B, workflow_state: "todo", severity: null, kind: "alert", last_seen_at: iso(2 * 60_000) }),
			makeIssueRow({ id: ISSUE_C, workflow_state: "triage", severity: null, kind: "error", last_seen_at: iso(3 * 60_000) }),
		],
		actors: [],
		openIncidentIssueIds: new Set(),
	})

	it("matches workflowState exactly", () => {
		expect(filterIssues(derived, { workflowState: "todo" }).map((i) => i.id)).toEqual([ISSUE_B])
	})

	it('treats severity "unset" as NULL severity', () => {
		expect(filterIssues(derived, { severity: "unset" }).map((i) => i.id)).toEqual([ISSUE_B, ISSUE_C])
	})

	it("matches a concrete severity exactly", () => {
		expect(filterIssues(derived, { severity: "high" }).map((i) => i.id)).toEqual([ISSUE_A])
	})

	it("matches kind exactly and composes with other filters", () => {
		expect(filterIssues(derived, { kind: "alert" }).map((i) => i.id)).toEqual([ISSUE_B])
		expect(filterIssues(derived, { workflowState: "triage", severity: "unset", kind: "error" }).map((i) => i.id)).toEqual(
			[ISSUE_C],
		)
	})

	it("passes everything through unfiltered, capped at the page limit", () => {
		expect(filterIssues(derived, {}).map((i) => i.id)).toEqual([ISSUE_A, ISSUE_B, ISSUE_C])

		const many = deriveErrorIssues({
			issues: Array.from({ length: ISSUES_PAGE_LIMIT + 5 }, (_, i) =>
				makeIssueRow({
					id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
					last_seen_at: iso(i * 1000),
				}),
			),
			actors: [],
			openIncidentIssueIds: new Set(),
		})
		expect(filterIssues(many, {})).toHaveLength(ISSUES_PAGE_LIMIT)
	})
})
