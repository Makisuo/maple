import { describe, expect, it } from "vitest"
import { decodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { ErrorIssueEventType } from "@maple/domain/http"
import { AuditResources, auditResourceFields } from "./audit-actions"

describe("AuditResources", () => {
	it("names every resource in the `<resource>.<verb>` snake_case shape the rows store", () => {
		for (const [resource, { verbs }] of Object.entries(AuditResources)) {
			expect(resource).toMatch(/^[a-z][a-z0-9_]*$/)
			for (const verb of verbs) expect(verb).toMatch(/^[a-z][a-z0-9_]*$/)
		}
	})

	// The issue workflow audits `error_issue.${type}` for every event type it
	// attributes, so a new event type must not silently produce an undeclared action.
	it("declares an `error_issue` verb for every issue event type", () => {
		expect([...AuditResources.error_issue.verbs]).toEqual([...ErrorIssueEventType.literals])
	})
})

describe("auditResourceFields", () => {
	it("derives the resource type from the action", () => {
		expect(auditResourceFields("alert_rule.created").resourceType).toBe("alert_rule")
		expect(auditResourceFields("dashboard_share.rotated").resourceType).toBe("dashboard_share")
		expect(auditResourceFields("dashboard.version_restored").resourceType).toBe("dashboard")
	})

	it("encodes the internal ID with the resource's own public prefix", () => {
		const internal = "3f1b7c02-9a44-4d1e-8b2f-0c5d6e7a8b91"
		const { resourceId } = auditResourceFields("alert_rule.created", internal)
		expect(resourceId).toMatch(/^alrt_/)
		expect(decodePublicId(PublicIdPrefixes.alertRule, resourceId!)).toBe(internal)
	})

	it("omits the resource ID for org-singleton resources", () => {
		expect(auditResourceFields("ingest_key.rolled")).toEqual({ resourceType: "ingest_key" })
		expect(auditResourceFields("api.request")).toEqual({ resourceType: "api" })
	})
})
