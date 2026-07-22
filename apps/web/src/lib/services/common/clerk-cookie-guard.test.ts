import { describe, expect, it } from "vitest"
import {
	computeClerkCookieSuffix,
	cookieDomainCandidates,
	foreignClientUatCookieNames,
} from "./clerk-cookie-guard"

describe("computeClerkCookieSuffix", () => {
	it("matches ClerkJS's suffix for the production publishable key", async () => {
		// Observed in the wild: prod (`pk_live_Y2xlcmsubWFwbGUuZGV2JA`, FAPI
		// clerk.maple.dev) writes `__client_uat_Gu_OZvPU` on Domain=maple.dev.
		await expect(computeClerkCookieSuffix("pk_live_Y2xlcmsubWFwbGUuZGV2JA")).resolves.toBe(
			"Gu_OZvPU",
		)
	})
})

describe("foreignClientUatCookieNames", () => {
	it("keeps the own-instance suffixed cookie, drops foreign and legacy ones", () => {
		const names = [
			"__client_uat",
			"__client_uat_Gu_OZvPU",
			"__client_uat_lpBWIqOU",
			"__session",
			"__clerk_db_jwt",
			"clerk_active_context",
		]
		expect(foreignClientUatCookieNames(names, "lpBWIqOU")).toEqual([
			"__client_uat",
			"__client_uat_Gu_OZvPU",
		])
	})

	it("returns nothing when only own-instance cookies exist", () => {
		expect(foreignClientUatCookieNames(["__client_uat_lpBWIqOU", "__session"], "lpBWIqOU")).toEqual(
			[],
		)
	})
})

describe("cookieDomainCandidates", () => {
	it("walks from the host up to the two-label parent", () => {
		expect(cookieDomainCandidates("app-pr-246.maple.dev")).toEqual([
			"app-pr-246.maple.dev",
			"maple.dev",
		])
		expect(cookieDomainCandidates("app.maple.dev")).toEqual(["app.maple.dev", "maple.dev"])
	})

	it("handles single-label hosts", () => {
		expect(cookieDomainCandidates("localhost")).toEqual(["localhost"])
	})
})
