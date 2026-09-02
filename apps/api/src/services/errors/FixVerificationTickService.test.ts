import { assert, describe, it } from "@effect/vitest"
import { verificationVerdictAutoCloses } from "@maple/domain/http"

import { splitVersionRows, verdictFromInvestigationStatus } from "./FixVerificationTickService"

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

describe("splitVersionRows", () => {
	it("splits attributable occurrences against the merge-time baseline", () => {
		const split = splitVersionRows(
			[
				{ serviceVersion: "v1", count: 40 },
				{ serviceVersion: "v3", count: 2 },
			],
			["v1", "v2"],
			1000,
		)
		assert.deepStrictEqual(split, { postMerge: 2, staleClients: 40, unattributed: 0 })
	})

	it("keeps a count of occurrences that report no build", () => {
		// The old code discarded these rows entirely, so a service that never
		// reports `service.version` looked identical to one that went silent — and
		// with a usable pre-merge rate the no-agent fallback then wrote `verified`
		// and auto-closed the issue while the error was still firing.
		const split = splitVersionRows([{ serviceVersion: "", count: 17 }], ["v1"], 1000)
		assert.strictEqual(split.unattributed, 17)
		assert.strictEqual(split.postMerge, 0)
	})

	it("treats a truncated version scan as incomplete evidence", () => {
		// Any single non-baseline build is decisive, so a scan that dropped rows
		// past its cap cannot claim the window was clean.
		const rows = Array.from({ length: 3 }, (_, index) => ({
			serviceVersion: `v${index}`,
			count: 1,
		}))
		const split = splitVersionRows(rows, ["v0", "v1", "v2"], 3)
		assert.isAbove(split.unattributed, 0)
	})
})
