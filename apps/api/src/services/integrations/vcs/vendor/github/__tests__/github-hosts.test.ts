import { describe, expect, it } from "vitest"

import { githubWebBaseUrl } from "../github-hosts"

/**
 * The OAuth code exchange posts the App's client secret to this host, so a wrong
 * answer for an Enterprise deployment is a credential sent to a third party —
 * which is what a hardcoded `https://github.com` did.
 */
describe("githubWebBaseUrl", () => {
	it("maps the public API host to the public web host", () => {
		expect(githubWebBaseUrl("https://api.github.com")).toBe("https://github.com")
		expect(githubWebBaseUrl("https://api.github.com/")).toBe("https://github.com")
	})

	it("strips the Enterprise Server API suffix", () => {
		expect(githubWebBaseUrl("https://github.acme.internal/api/v3")).toBe("https://github.acme.internal")
		expect(githubWebBaseUrl("https://github.acme.internal/api/v3/")).toBe("https://github.acme.internal")
	})

	it("keeps a path prefix that is not the API suffix", () => {
		expect(githubWebBaseUrl("https://intranet.acme.internal/github/api/v3")).toBe(
			"https://intranet.acme.internal/github",
		)
	})

	it("falls back to public GitHub when the configured value is unusable", () => {
		expect(githubWebBaseUrl("not a url")).toBe("https://github.com")
		expect(githubWebBaseUrl("")).toBe("https://github.com")
	})
})
