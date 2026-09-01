import { assert, describe, it } from "@effect/vitest"
import { renderCallbackPage } from "./integrations.http"

/**
 * The callback page is served from the API origin, so the stored `returnTo` is
 * the one attacker-influenced value that reaches an href here. HTML escaping
 * alone leaves `javascript:` intact — these pin the scheme/authority rules.
 */
const render = (returnTo: string | null, targetOrigin = "https://web.maple.dev") =>
	renderCallbackPage({
		status: "success",
		message: "Connected",
		returnTo,
		messageType: "maple:integration:hazel",
		label: "Hazel",
		targetOrigin,
	})

describe("renderCallbackPage returnTo sink", () => {
	it("renders a dashboard-origin link for a relative path", () => {
		const html = render("/integrations?connected=1")
		assert.include(html, `href="https://web.maple.dev/integrations?connected=1"`)
		assert.notInclude(html, "Return link blocked")
	})

	it.each([
		"javascript:alert(document.cookie)",
		"JaVaScRiPt:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"//evil.com/",
		"/\\evil.com",
		"https://evil.com/",
		"%6a%61vascript:alert(1)",
	])("drops the link for %j", (value) => {
		const html = render(value)
		assert.notInclude(html, `<a class="button"`)
		assert.notInclude(html, "javascript:")
		assert.notInclude(html, "evil.com")
		// Rejection is visible rather than a dead button.
		assert.include(html, "Return link blocked")
	})

	it("renders no link and no notice when there is no returnTo", () => {
		const html = render(null)
		assert.notInclude(html, `<a class="button"`)
		assert.notInclude(html, "Return link blocked")
	})

	it("drops the link when the dashboard origin is unknown", () => {
		const html = render("/integrations", "*")
		assert.notInclude(html, `<a class="button"`)
		assert.include(html, "Return link blocked")
	})
})
