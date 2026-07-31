import { describe, expect, it } from "vitest"

import { Result } from "@/lib/effect-atom"
import { deriveInitialRuleDraft } from "./alert-create-page-content"

/**
 * The starter-template deep link from the overview empty state. With no ruleId /
 * chart / dashboard params, `deriveInitialRuleDraft` reaches the template branch
 * before the rules/dashboards results ever matter, so `Result.initial()` stands
 * in for both.
 */
const loading = Result.initial()

describe("deriveInitialRuleDraft — template deep link", () => {
	// `low_apdex` differs from the blank defaults on signal, comparator, and
	// threshold, so a pass proves the template was applied (not just defaults).
	it("pre-applies a known template and skips the first-touch overlay", () => {
		const draft = deriveInitialRuleDraft({
			search: { template: "low_apdex" },
			chartContext: undefined,
			rulesResult: loading,
			dashboardsResult: loading,
		})

		expect(draft.form.signalType).toBe("apdex")
		expect(draft.form.comparator).toBe("lt")
		expect(draft.form.threshold).toBe("0.8")
		expect(draft.form.apdexThresholdMs).toBe("500")
		expect(draft.form.name).toBe("Low Apdex score")
		expect(draft.showTemplatesInitially).toBe(false)
		expect(draft.key).toBe("new:template:low_apdex")
	})

	it("falls through to a blank draft (overlay opens) for an unknown template id", () => {
		const draft = deriveInitialRuleDraft({
			search: { template: "not-a-real-template" },
			chartContext: undefined,
			rulesResult: loading,
			dashboardsResult: loading,
		})

		expect(draft.form.signalType).toBe("error_rate")
		expect(draft.form.name).toBe("")
		// No serviceName + unknown template → the overlay still leads the flow.
		expect(draft.showTemplatesInitially).toBe(true)
		expect(draft.key).toBe("new:blank")
	})
})
