import { describe, expect, it } from "vitest"
import { organizationFeatureFlagsFrom } from "./organization-feature-flags"

describe("organizationFeatureFlagsFrom", () => {
	it("gates each flag independently", () => {
		expect(organizationFeatureFlagsFrom({ webanalytics: true })).toEqual({
			aiAutoTriage: false,
			webAnalytics: true,
		})
	})

	it("decodes every organization rollout flag", () => {
		expect(
			organizationFeatureFlagsFrom({
				aiautotriage: true,
				webanalytics: true,
				unrelated_metadata: "preserved by Clerk, ignored here",
			}),
		).toEqual({ aiAutoTriage: true, webAnalytics: true })
	})

	it("disables a missing or malformed flag", () => {
		expect(organizationFeatureFlagsFrom({})).toEqual({
			aiAutoTriage: false,
			webAnalytics: false,
		})
		// The string "true" is the shape a hand-edited Clerk dashboard field
		// produces, and it must not read as enabled.
		expect(
			organizationFeatureFlagsFrom({
				aiautotriage: "true",
				webanalytics: "true",
			}),
		).toEqual({ aiAutoTriage: false, webAnalytics: false })
	})

	it("fails closed when public metadata is unavailable", () => {
		expect(organizationFeatureFlagsFrom(undefined)).toEqual({
			aiAutoTriage: false,
			webAnalytics: false,
		})
	})
})
