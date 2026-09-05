import { describe, expect, it } from "vitest"
import { organizationFeatureFlagsFrom } from "./organization-feature-flags"

describe("organizationFeatureFlagsFrom", () => {
	it("decodes every organization rollout flag", () => {
		expect(
			organizationFeatureFlagsFrom({
				aiautotriage: true,
				agent_tracing: true,
				unrelated_metadata: "preserved by Clerk, ignored here",
			}),
		).toEqual({ aiAutoTriage: true, agentTracing: true, releases: false })
	})

	// `webanalytics` was a rollout flag until Web Analytics shipped to everyone.
	// Orgs still carry the key in Clerk metadata, and a retired flag must decode
	// as an ignored extra rather than failing the whole struct — which would take
	// the live flags down with it and fail closed for the orgs that have them on.
	it("ignores a retired flag still present in metadata", () => {
		expect(organizationFeatureFlagsFrom({ aiautotriage: true, webanalytics: true })).toEqual({
			aiAutoTriage: true,
			agentTracing: false,
			releases: false,
		})
	})

	it("disables a missing or malformed flag", () => {
		expect(organizationFeatureFlagsFrom({})).toEqual({
			aiAutoTriage: false,
			agentTracing: false,
			releases: false,
		})
		// The string "true" is the shape a hand-edited Clerk dashboard field
		// produces, and it must not read as enabled.
		expect(organizationFeatureFlagsFrom({ aiautotriage: "true", agent_tracing: "true" })).toEqual({
			aiAutoTriage: false,
			agentTracing: false,
			releases: false,
		})
	})

	it("fails closed when public metadata is unavailable", () => {
		expect(organizationFeatureFlagsFrom(undefined)).toEqual({
			aiAutoTriage: false,
			agentTracing: false,
			releases: false,
		})
	})
})
