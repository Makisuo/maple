import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { V2ErrorIssue, encodePublicId } from "@maple/domain/http/v2"
import {
	appendUniqueErrorIssues,
	buildErrorIssueListQuery,
	buildServiceOpenIssuesQuery,
	errorIssueFromV2,
} from "./error-issues"

describe("error issue v2 queries", () => {
	it("builds one bounded, server-filtered page for the issues route", () => {
		expect(
			buildErrorIssueListQuery({ workflowState: "triage", severity: "critical", kind: "error" }),
		).toEqual({ limit: 100, workflow_state: "triage", severity: "critical", kind: "error" })
		expect(buildErrorIssueListQuery({ workflowState: "all", severity: "all", kind: "all" })).toEqual({
			limit: 100,
		})
	})

	it("requests exactly five actionable service issues in urgency order", () => {
		expect(buildServiceOpenIssuesQuery("checkout-api")).toEqual({
			service_name: "checkout-api",
			actionable: "true",
			sort: "severity",
			limit: 5,
		})
	})

	it("scopes to an environment + window only when an environment is selected", () => {
		expect(
			buildServiceOpenIssuesQuery("checkout-api", {
				environment: "production",
				startTime: "2026-07-18 00:00:00",
				endTime: "2026-07-19 00:00:00",
			}),
		).toEqual({
			service_name: "checkout-api",
			actionable: "true",
			sort: "severity",
			limit: 5,
			deployment_environment: "production",
			start_time: "2026-07-18T00:00:00Z",
			end_time: "2026-07-19T00:00:00Z",
		})
		// No environment selected → the window does not ride along (all-time panel).
		expect(
			buildServiceOpenIssuesQuery("checkout-api", {
				startTime: "2026-07-18 00:00:00",
				endTime: "2026-07-19 00:00:00",
			}),
		).toEqual({ service_name: "checkout-api", actionable: "true", sort: "severity", limit: 5 })
		// The synthetic "unknown" label maps back to the raw empty-string env.
		expect(buildServiceOpenIssuesQuery("checkout-api", { environment: "unknown" })).toMatchObject({
			deployment_environment: "",
		})
	})
})

describe("errorIssueFromV2", () => {
	it("adapts the snake_case v2 resource to the existing issue view model", () => {
		const id = "00000000-0000-4000-8000-000000000001"
		const issue = Schema.decodeUnknownSync(V2ErrorIssue)({
			id: encodePublicId("iss", id),
			object: "error_issue",
			kind: "error",
			fingerprint_hash: "fp",
			service_name: "checkout-api",
			exception_type: "TimeoutError",
			exception_message: "upstream timed out",
			error_label: "TimeoutError: upstream timed out",
			top_frame: "handler.ts:42",
			workflow_state: "triage",
			priority: 0,
			severity: "critical",
			severity_source: "detector",
			source_ref: null,
			assigned_actor: null,
			lease_holder: null,
			lease_expires_at: null,
			claimed_at: null,
			notes: null,
			first_seen_at: "2026-07-15T00:00:00.000Z",
			last_seen_at: "2026-07-15T01:00:00.000Z",
			occurrence_count: 12,
			resolved_at: null,
			snooze_until: null,
			archived_at: null,
			has_open_incident: true,
		})
		const adapted = errorIssueFromV2(issue)
		expect(adapted.id).toBe(id)
		expect(adapted.serviceName).toBe("checkout-api")
		expect(adapted.hasOpenIncident).toBe(true)
		expect(appendUniqueErrorIssues([adapted], [adapted])).toEqual([adapted])
	})
})
