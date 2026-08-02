import { describe, expect, it } from "vitest"

import {
	chipPhrase,
	chipScope,
	investigationSuggestions,
	type InvestigationContext,
} from "./investigation-context"

const alert = (overrides: Partial<InvestigationContext> = {}): InvestigationContext => ({
	kind: "alert",
	id: "inc_1",
	title: "p99 latency breached",
	severity: "critical",
	status: "Firing",
	facts: [],
	...overrides,
})

/**
 * The paragraph a system-seeded investigation actually carried in `snapshot.scope`,
 * which `Diagnose ${scope}` rendered verbatim into a chip.
 */
const PARAGRAPH =
	"subscriptions-api public endpoints (GET /public/v1/users/:appUserIdOrDeviceId/entitlements " +
	"and POST /public/v1/redeem) are experiencing severe tail latency (p99 > 10 s) for a large " +
	"fraction of traffic (≈77 k samples in the 10-min alert window)."

describe("chipScope", () => {
	it("keeps a short scope untouched", () => {
		expect(chipScope("subscriptions-api")).toBe("subscriptions-api")
	})

	it("reduces a paragraph to its subject", () => {
		expect(chipScope(PARAGRAPH)).toBe("subscriptions-api")
	})

	it("keeps a multi-word clause that is short enough to be a real scope", () => {
		expect(chipScope("checkout-api /v1/orders")).toBe("checkout-api /v1/orders")
	})

	it("hard-caps a single token with nowhere to cut", () => {
		const scope = chipScope("a".repeat(200))
		expect(scope).toHaveLength(32)
		expect(scope.endsWith("…")).toBe(true)
	})

	it("falls back to the raw text when the head is empty", () => {
		expect(chipScope("(all)")).toBe("(all)")
	})
})

describe("chipPhrase", () => {
	it("keeps a short exception message whole", () => {
		expect(chipPhrase("The connection was closed.")).toBe("The connection was closed.")
	})

	it("truncates a message rather than lifting a word out of it", () => {
		const label = chipPhrase('{ "namespace": "config-api", "group": "v1-web-paywall-domain" }')
		expect(label).toHaveLength(36)
		expect(label.startsWith('{ "namespace"')).toBe(true)
	})

	it("stops at the first line", () => {
		expect(chipPhrase("Boom\n  at handler (app.ts:12)")).toBe("Boom")
	})
})

describe("investigationSuggestions", () => {
	it("uses the latency branch once the signal is known", () => {
		const suggestions = investigationSuggestions(
			alert({ signalType: "p99_latency", scope: "subscriptions-api" }),
		)
		expect(suggestions).toContain("Slowest operations in subscriptions-api right now")
		expect(suggestions.some((s) => s.startsWith("Diagnose "))).toBe(false)
	})

	it("keeps every suggestion short enough for a one-line chip", () => {
		const suggestions = investigationSuggestions(alert({ signalType: "p99_latency", scope: PARAGRAPH }))
		for (const suggestion of suggestions) {
			expect(suggestion.length).toBeLessThanOrEqual(72)
		}
	})

	it("offers follow-ups on the report instead of asking for a diagnosis it already has", () => {
		const suggestions = investigationSuggestions(
			alert({ scope: PARAGRAPH, aiSuspectedCause: "Vitess cluster degradation" }),
		)
		expect(suggestions).toContain("What would confirm this?")
		expect(suggestions.some((s) => s.includes("public endpoints"))).toBe(false)
	})

	it("clamps a JSON-blob exception message out of the error prompts", () => {
		const suggestions = investigationSuggestions(
			alert({
				kind: "error",
				title: '{ "namespace": "config-api", "group": "v1-web-paywall-domain", "groupKey": "superwall" }',
			}),
		)
		for (const suggestion of suggestions) {
			expect(suggestion.length).toBeLessThanOrEqual(72)
		}
	})

	it("still falls back to the generic branch when no signal is carried", () => {
		expect(investigationSuggestions(alert({ scope: "checkout-api" }))).toEqual([
			"Diagnose checkout-api",
			"Recent errors in checkout-api",
			"Slowest traces in checkout-api",
		])
	})
})
