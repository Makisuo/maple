import { describe, expect, it } from "vitest"
import { buildRuleCreateParamsV2, defaultRuleForm } from "@/lib/alerts/form-utils"
import { toPreviewForm } from "@/hooks/use-alert-rule-preview"

describe("toPreviewForm", () => {
	it("builds an identical preview payload while non-query fields are being typed", () => {
		// The preview atom is keyed by the payload; if name/notes/tag
		// edits change it, every keystroke mints a new retained warehouse query.
		const base = defaultRuleForm()
		const edited = {
			...base,
			name: "My critical aler",
			notes: "half-typed not",
			tags: ["team-a"],
			notificationTitle: "It brok",
			notificationBody: "Look at ",
		}
		expect(buildRuleCreateParamsV2(toPreviewForm(edited))).toEqual(
			buildRuleCreateParamsV2(toPreviewForm(base)),
		)
	})

	it("still re-keys the payload when a query-relevant field changes", () => {
		const base = defaultRuleForm()
		const edited = { ...base, threshold: "9" }
		expect(buildRuleCreateParamsV2(toPreviewForm(edited))).not.toEqual(
			buildRuleCreateParamsV2(toPreviewForm(base)),
		)
	})
})
