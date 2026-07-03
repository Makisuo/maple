import { describe, expect, it } from "vitest"
import { formatAgentDebugPrompt } from "./agent-debug-prompt"

describe("formatAgentDebugPrompt", () => {
	it("interpolates the fingerprint into the error_detail step", () => {
		const prompt = formatAgentDebugPrompt({
			fingerprintHash: "fp_abc123",
			label: "TypeError",
			serviceName: "checkout",
			message: "Cannot read property 'id' of undefined",
		})
		expect(prompt).toContain("**Maple fingerprint:** fp_abc123")
		expect(prompt).toContain('`error_detail` with fingerprint "fp_abc123"')
		expect(prompt).toContain("**Error:** TypeError in checkout")
		expect(prompt).toContain("Cannot read property 'id' of undefined")
		expect(prompt.trimEnd().endsWith("Start by calling error_detail.")).toBe(true)
	})

	it("adds the claim/propose_fix step only when an issue id is present", () => {
		const withIssue = formatAgentDebugPrompt({
			fingerprintHash: "fp_abc123",
			label: "TypeError",
			issueId: "issue_xyz",
		})
		expect(withIssue).toContain("**Maple issue ID:** issue_xyz")
		expect(withIssue).toContain('`claim_error_issue` (issue_id "issue_xyz")')
		expect(withIssue).toContain('`propose_fix` (issue_id "issue_xyz")')

		const withoutIssue = formatAgentDebugPrompt({
			fingerprintHash: "fp_abc123",
			label: "TypeError",
		})
		expect(withoutIssue).not.toContain("Maple issue ID")
		expect(withoutIssue).not.toContain("claim_error_issue")
		expect(withoutIssue).not.toContain("propose_fix")
	})

	it("omits optional sections when their data is absent", () => {
		const prompt = formatAgentDebugPrompt({
			fingerprintHash: "fp_abc123",
			label: "TypeError",
		})
		expect(prompt).not.toContain("**Message:**")
		expect(prompt).not.toContain("**Top stack frame:**")
		expect(prompt).not.toContain("**Occurrences:**")
	})

	it("renders occurrence counts with the affected-services qualifier", () => {
		const prompt = formatAgentDebugPrompt({
			fingerprintHash: "fp_abc123",
			label: "TypeError",
			occurrenceCount: 1234,
			affectedServicesCount: 3,
			firstSeen: "2026-07-01T00:00:00Z",
			lastSeen: "2026-07-01T06:00:00Z",
		})
		expect(prompt).toContain("**Occurrences:** 1,234 across 3 services")
		expect(prompt).toContain("first seen 2026-07-01T00:00:00Z")
		expect(prompt).toContain("last seen 2026-07-01T06:00:00Z")
	})
})
