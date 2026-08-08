import { describe, expect, it } from "vitest"
import { organizationFeatureFlagsFrom } from "./organization-feature-flags"

describe("organizationFeatureFlagsFrom", () => {
	it("decodes every organization rollout flag", () => {
		expect(
			organizationFeatureFlagsFrom({
				aiautotriage: true,
				unrelated_metadata: "preserved by Clerk, ignored here",
			}),
		).toEqual({ aiAutoTriage: true })
	})

	it("disables a missing or malformed flag", () => {
		expect(organizationFeatureFlagsFrom({})).toEqual({
			aiAutoTriage: false,
		})
		expect(
			organizationFeatureFlagsFrom({
				aiautotriage: "true",
			}),
		).toEqual({ aiAutoTriage: false })
	})

	it("fails closed when public metadata is unavailable", () => {
		expect(organizationFeatureFlagsFrom(undefined)).toEqual({
			aiAutoTriage: false,
		})
	})
})
