import { describe, expect, it } from "vitest"
import { organizationFeatureFlagsFrom } from "./organization-feature-flags"

describe("organizationFeatureFlagsFrom", () => {
	it("decodes every organization rollout flag", () => {
		expect(
			organizationFeatureFlagsFrom({
				aiautotriage: true,
				infra_monitoring: true,
				unrelated_metadata: "preserved by Clerk, ignored here",
			}),
		).toEqual({ aiAutoTriage: true, infrastructureMonitoring: true })
	})

	it("disables missing and malformed flags independently", () => {
		expect(organizationFeatureFlagsFrom({})).toEqual({
			aiAutoTriage: false,
			infrastructureMonitoring: false,
		})
		expect(
			organizationFeatureFlagsFrom({
				aiautotriage: "true",
				infra_monitoring: true,
			}),
		).toEqual({ aiAutoTriage: false, infrastructureMonitoring: true })
		expect(
			organizationFeatureFlagsFrom({
				aiautotriage: true,
				infra_monitoring: 1,
			}),
		).toEqual({ aiAutoTriage: true, infrastructureMonitoring: false })
	})

	it("fails closed when public metadata is unavailable", () => {
		expect(organizationFeatureFlagsFrom(undefined)).toEqual({
			aiAutoTriage: false,
			infrastructureMonitoring: false,
		})
	})
})
