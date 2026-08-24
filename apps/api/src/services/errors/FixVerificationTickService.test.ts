import { assert, describe, it } from "@effect/vitest"
import { verificationVerdictAutoCloses } from "@maple/domain/http"

import { verdictFromInvestigationStatus } from "./FixVerificationTickService"

/**
 * The verdict mapping is deliberately inverted relative to an incident
 * investigation, and that inversion is the whole reason these tests exist: a
 * reader who has not held the question the run was asked will see
 * `inconclusive -> verified` as a bug and "fix" it, and the fix silently
 * auto-closes every issue whose fix did NOT hold. Asserted literally, not
 * derived from the implementation.
 */
describe("verdictFromInvestigationStatus", () => {
	it("reads an established cause as the fix NOT holding", () => {
		const { verdict } = verdictFromInvestigationStatus("diagnosed")
		assert.strictEqual(verdict, "not_fixed")
	})

	it("reads finding nothing as the fix holding", () => {
		// The agent was asked to contradict a clean occurrence count. Failing to
		// do so corroborates it — the opposite of what `inconclusive` means for an
		// incident.
		const { verdict } = verdictFromInvestigationStatus("inconclusive")
		assert.strictEqual(verdict, "verified")
	})

	it("does not turn a run that never finished into a verdict either way", () => {
		for (const status of ["failed", "investigating", "cancelled"]) {
			const { verdict } = verdictFromInvestigationStatus(status)
			assert.strictEqual(verdict, "inconclusive", status)
		}
	})

	it("names the status it could not interpret, rather than guessing", () => {
		// A renamed or newly added investigation status falls here. It must stay
		// inconclusive (which earns a retry) and say so, never silently read as
		// `verified` — that path closes the issue.
		const { verdict, reason } = verdictFromInvestigationStatus("brand_new_status")
		assert.strictEqual(verdict, "inconclusive")
		assert.include(reason, "brand_new_status")
	})

	it("reaches the issue-closing verdict from exactly one status", () => {
		// `verified` is the only verdict that closes an issue (for a severity that
		// auto-closes at all), so the set of statuses producing it is the blast
		// radius of this mapping. Pinned as a set: widening it is how a failed fix
		// gets closed automatically.
		const verifying = ["diagnosed", "inconclusive", "failed", "investigating", "cancelled"].filter(
			(status) => verdictFromInvestigationStatus(status).verdict === "verified",
		)
		assert.deepStrictEqual(verifying, ["inconclusive"])
		assert.strictEqual(verificationVerdictAutoCloses("low"), true)
		assert.strictEqual(verificationVerdictAutoCloses("critical"), false)
	})
})
