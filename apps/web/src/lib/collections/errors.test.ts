import { describe, expect, it, vi } from "vitest"

// The mappers are pure; stub the registry so importing the collection module
// doesn't spin up the ManagedRuntime / atom-registry side effects.
vi.mock("@/lib/registry", () => ({ mapleRuntime: {} }))

import type { ActorDocument } from "@maple/domain/http"
import {
	type ActorRow,
	type ErrorIncidentRow,
	type ErrorIssueRow,
	rowToActor,
	rowToErrorIncident,
	rowToIssue,
} from "./errors"

const ISSUE_ID = "11111111-2222-4333-8444-555555555555"
const ACTOR_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const LEASE_ACTOR_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
const INCIDENT_ID = "12121212-3434-4565-8787-909090909090"

const actorRow: ActorRow = {
	id: ACTOR_ID,
	org_id: "org_1",
	type: "user",
	user_id: "user_42",
	agent_name: null,
	model: null,
	capabilities_json: ["read", "write"],
	created_by: "user_42",
	created_at: "2026-07-01T00:00:00.000Z",
	last_active_at: "2026-07-02T00:00:00.000Z",
}

describe("rowToActor", () => {
	it("maps a raw actors row into an ActorDocument", () => {
		const doc = rowToActor(actorRow)
		expect(doc.id).toBe(ACTOR_ID)
		expect(doc.type).toBe("user")
		expect(doc.userId).toBe("user_42")
		expect(doc.agentName).toBeNull()
		expect(doc.capabilities).toEqual(["read", "write"])
		expect(doc.lastActiveAt).toBe("2026-07-02T00:00:00.000Z")
	})

	it("defaults capabilities to [] when the json column is not a string array", () => {
		expect(rowToActor({ ...actorRow, capabilities_json: null }).capabilities).toEqual([])
		expect(rowToActor({ ...actorRow, capabilities_json: "oops" }).capabilities).toEqual([])
	})
})

const issueRow: ErrorIssueRow = {
	id: ISSUE_ID,
	org_id: "org_1",
	kind: "error",
	source_ref_json: { alertRuleId: "r1" },
	fingerprint_hash: "fp-abc",
	service_name: "checkout",
	exception_type: "TypeError",
	exception_message: "boom",
	error_label: "TypeError: boom",
	top_frame: "at handler (index.ts:1)",
	workflow_state: "triage",
	priority: 3,
	severity: "high",
	severity_source: "manual",
	assigned_actor_id: ACTOR_ID,
	lease_holder_actor_id: LEASE_ACTOR_ID,
	lease_expires_at: "2026-07-03T00:00:00.000Z",
	claimed_at: "2026-07-02T12:00:00.000Z",
	notes: "look into this",
	first_seen_at: "2026-06-01T00:00:00.000Z",
	last_seen_at: "2026-07-04T00:00:00.000Z",
	occurrence_count: 17,
	resolved_at: null,
	resolved_by_actor_id: null,
	snooze_until: null,
	archived_at: null,
	created_at: "2026-06-01T00:00:00.000Z",
	updated_at: "2026-07-04T00:00:00.000Z",
}

describe("rowToIssue", () => {
	const actor = rowToActor(actorRow)
	const leaseActor = rowToActor({ ...actorRow, id: LEASE_ACTOR_ID, agent_name: "triage-bot", type: "agent" })
	const actorMap = new Map<string, ActorDocument>([
		[ACTOR_ID, actor],
		[LEASE_ACTOR_ID, leaseActor],
	])

	it("maps snake_case columns + joins actors + carries hasOpenIncident", () => {
		const doc = rowToIssue(issueRow, true, actorMap)
		expect(doc.id).toBe(ISSUE_ID)
		expect(doc.kind).toBe("error")
		expect(doc.serviceName).toBe("checkout")
		expect(doc.exceptionType).toBe("TypeError")
		expect(doc.workflowState).toBe("triage")
		expect(doc.severity).toBe("high")
		expect(doc.severitySource).toBe("manual")
		expect(doc.sourceRef).toEqual({ alertRuleId: "r1" })
		expect(doc.assignedActor?.id).toBe(ACTOR_ID)
		expect(doc.leaseHolder?.id).toBe(LEASE_ACTOR_ID)
		expect(doc.leaseExpiresAt).toBe("2026-07-03T00:00:00.000Z")
		expect(doc.firstSeenAt).toBe("2026-06-01T00:00:00.000Z")
		expect(doc.occurrenceCount).toBe(17)
		expect(doc.hasOpenIncident).toBe(true)
	})

	it("nulls actor joins + severity when the ids/columns are null", () => {
		const doc = rowToIssue(
			{ ...issueRow, assigned_actor_id: null, lease_holder_actor_id: null, severity: null, severity_source: null },
			false,
			actorMap,
		)
		expect(doc.assignedActor).toBeNull()
		expect(doc.leaseHolder).toBeNull()
		expect(doc.severity).toBeNull()
		expect(doc.severitySource).toBeNull()
		expect(doc.hasOpenIncident).toBe(false)
	})

	it("nulls an actor join when the id is present but the actor is missing from the map", () => {
		expect(rowToIssue(issueRow, false, new Map()).assignedActor).toBeNull()
	})
})

describe("rowToErrorIncident", () => {
	it("maps a raw error_incidents row", () => {
		const row: ErrorIncidentRow = {
			id: INCIDENT_ID,
			org_id: "org_1",
			issue_id: ISSUE_ID,
			status: "open",
			reason: "first_seen",
			first_triggered_at: "2026-07-01T00:00:00.000Z",
			last_triggered_at: "2026-07-04T00:00:00.000Z",
			resolved_at: null,
			occurrence_count: 5,
			created_at: "2026-07-01T00:00:00.000Z",
			updated_at: "2026-07-04T00:00:00.000Z",
		}
		const doc = rowToErrorIncident(row)
		expect(doc.id).toBe(INCIDENT_ID)
		expect(doc.issueId).toBe(ISSUE_ID)
		expect(doc.status).toBe("open")
		expect(doc.reason).toBe("first_seen")
		expect(doc.resolvedAt).toBeNull()
		expect(doc.occurrenceCount).toBe(5)
	})
})
