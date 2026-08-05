import { describe, expect, it } from "vitest"

import { Schema } from "effect"
import { ScrapeTargetId } from "@maple/domain/http"
import type { V2PlanetScaleIntegration, V2PlanetScaleScrapeTarget } from "@maple/domain/http/v2"
import { derivePlanetScaleSetup, metricsHealthState, type SetupStepId } from "./planetscale-setup-steps"

const NOW = Date.parse("2026-08-04T12:00:00Z")

/** The v2 wire format is ISO-8601, so fixtures build timestamps the same way. */
const iso = (epochMs: number) => new Date(epochMs).toISOString()

const target = (over: Partial<V2PlanetScaleScrapeTarget> = {}): V2PlanetScaleScrapeTarget => ({
	id: Schema.decodeUnknownSync(ScrapeTargetId)("11111111-1111-4111-8111-111111111111"),
	object: "planetscale_integration.scrape_target",
	enabled: true,
	scrape_interval_seconds: 30,
	include_branches: [],
	exclude_branches: [],
	last_scrape_at: iso(NOW - 10_000),
	last_scrape_error: null,
	...over,
})

const status = (over: Partial<V2PlanetScaleIntegration> = {}): V2PlanetScaleIntegration => ({
	object: "planetscale_integration",
	connected: true,
	pending_org_selection: false,
	organization: "acme",
	connected_by_user_id: null,
	detected_permissions: { readDatabases: true, readMetricsEndpoints: false },
	metrics_auth: "service_token",
	scrape_target: target(),
	last_inventory_at: iso(NOW - 60_000),
	last_inventory_error: null,
	revoked_at: null,
	expires_at: iso(NOW + 3_600_000),
	...over,
})

const stateOf = (s: V2PlanetScaleIntegration, id: SetupStepId) =>
	derivePlanetScaleSetup(s, NOW).steps.find((step) => step.id === id)?.state

describe("metricsHealthState", () => {
	it("is unconfigured when no token has been added", () => {
		expect(metricsHealthState(target(), "missing", NOW)).toBe("unconfigured")
	})

	it("is unconfigured when the managed target row is missing", () => {
		expect(metricsHealthState(null, "service_token", NOW)).toBe("unconfigured")
	})

	it("prefers the scrape error over every other signal", () => {
		expect(
			metricsHealthState(target({ last_scrape_error: "401 Unauthorized" }), "service_token", NOW),
		).toBe("degraded")
	})

	it("waits before the first scrape lands", () => {
		expect(metricsHealthState(target({ last_scrape_at: null }), "service_token", NOW)).toBe("waiting")
	})

	it("stalls after three missed intervals, not one", () => {
		// 30s interval: 2 intervals of silence is still healthy, 4 is stalled.
		expect(metricsHealthState(target({ last_scrape_at: iso(NOW - 60_000) }), "service_token", NOW)).toBe(
			"healthy",
		)
		expect(metricsHealthState(target({ last_scrape_at: iso(NOW - 120_000) }), "service_token", NOW)).toBe(
			"stalled",
		)
	})
})

describe("derivePlanetScaleSetup", () => {
	it("completes when the grant, permissions, token, and first scrape are all settled", () => {
		const setup = derivePlanetScaleSetup(status(), NOW)
		expect(setup.complete).toBe(true)
		expect(setup.activeStepNumber).toBeNull()
		expect(setup.awaitingFirstScrape).toBe(false)
		expect(setup.steps.map((s) => s.state)).toEqual(["done", "done", "done", "done"])
	})

	it("makes the token the current step on a fresh OAuth-only connection", () => {
		const setup = derivePlanetScaleSetup(
			status({ metrics_auth: "missing", scrape_target: target({ last_scrape_at: null }) }),
			NOW,
		)
		expect(setup.activeStepNumber).toBe(3)
		expect(setup.steps[2]!.state).toBe("current")
		expect(setup.steps[3]!.state).toBe("pending")
		// Nothing is scraping yet, so there is nothing to poll for.
		expect(setup.awaitingFirstScrape).toBe(false)
	})

	it("polls only once a token exists and the first scrape hasn't landed", () => {
		const setup = derivePlanetScaleSetup(status({ scrape_target: target({ last_scrape_at: null }) }), NOW)
		expect(setup.awaitingFirstScrape).toBe(true)
		expect(setup.activeStepNumber).toBe(4)
		expect(setup.steps[3]!.state).toBe("current")
	})

	it("stops polling once the scrape degrades — waiting forever would be a lie", () => {
		const setup = derivePlanetScaleSetup(
			status({ scrape_target: target({ last_scrape_error: "403 Forbidden" }) }),
			NOW,
		)
		expect(setup.awaitingFirstScrape).toBe(false)
		expect(setup.steps[3]!.state).toBe("blocked")
	})

	it("blocks on a revoked grant and does not ask for a token underneath it", () => {
		const s = status({ revoked_at: iso(NOW - 1000), metrics_auth: "missing" })
		expect(stateOf(s, "connected")).toBe("blocked")
		expect(stateOf(s, "permissions")).toBe("pending")
		// The token step must not be `current` while the grant itself is dead.
		expect(stateOf(s, "metrics-token")).toBe("pending")
		expect(derivePlanetScaleSetup(s, NOW).activeStepNumber).toBe(1)
	})

	it("blocks on an explicitly denied read_databases scope", () => {
		const s = status({ detected_permissions: { readDatabases: false } })
		expect(stateOf(s, "permissions")).toBe("blocked")
	})

	it("treats unknown permissions as not-denied", () => {
		// Null before the org is bound, and an absent key is not a denial.
		expect(stateOf(status({ detected_permissions: null }), "permissions")).toBe("done")
		expect(stateOf(status({ detected_permissions: {} }), "permissions")).toBe("done")
	})

	it("reports an oauth-capable grant as needing no token at all", () => {
		const setup = derivePlanetScaleSetup(status({ metrics_auth: "oauth" }), NOW)
		expect(setup.complete).toBe(true)
		expect(setup.steps[2]!.detail).toContain("no token needed")
	})
})
