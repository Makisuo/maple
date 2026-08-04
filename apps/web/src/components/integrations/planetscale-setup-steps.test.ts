import { describe, expect, it } from "vitest"

import { Schema } from "effect"
import {
	PlanetScaleIntegrationStatus,
	PlanetScaleScrapeTargetSummary,
	ScrapeTargetId,
} from "@maple/domain/http"
import { derivePlanetScaleSetup, metricsHealthState, type SetupStepId } from "./planetscale-setup-steps"

const NOW = Date.parse("2026-08-04T12:00:00Z")

type TargetFields = Schema.Schema.Type<typeof PlanetScaleScrapeTargetSummary>
type StatusFields = Schema.Schema.Type<typeof PlanetScaleIntegrationStatus>

const target = (over: Partial<TargetFields> = {}) =>
	new PlanetScaleScrapeTargetSummary({
		id: Schema.decodeUnknownSync(ScrapeTargetId)("11111111-1111-4111-8111-111111111111"),
		enabled: true,
		scrapeIntervalSeconds: 30,
		includeBranches: [],
		excludeBranches: [],
		lastScrapeAt: NOW - 10_000,
		lastScrapeError: null,
		...over,
	})

const status = (over: Partial<StatusFields> = {}) =>
	new PlanetScaleIntegrationStatus({
		connected: true,
		pendingOrgSelection: false,
		organization: "acme",
		connectedByUserId: null,
		detectedPermissions: { readDatabases: true, readMetricsEndpoints: false },
		metricsAuth: "service_token",
		scrapeTarget: target(),
		lastInventoryAt: NOW - 60_000,
		lastInventoryError: null,
		revokedAt: null,
		expiresAt: NOW + 3_600_000,
		...over,
	})

const stateOf = (s: PlanetScaleIntegrationStatus, id: SetupStepId) =>
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
			metricsHealthState(target({ lastScrapeError: "401 Unauthorized" }), "service_token", NOW),
		).toBe("degraded")
	})

	it("waits before the first scrape lands", () => {
		expect(metricsHealthState(target({ lastScrapeAt: null }), "service_token", NOW)).toBe("waiting")
	})

	it("stalls after three missed intervals, not one", () => {
		// 30s interval: 2 intervals of silence is still healthy, 4 is stalled.
		expect(metricsHealthState(target({ lastScrapeAt: NOW - 60_000 }), "service_token", NOW)).toBe(
			"healthy",
		)
		expect(metricsHealthState(target({ lastScrapeAt: NOW - 120_000 }), "service_token", NOW)).toBe(
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
			status({ metricsAuth: "missing", scrapeTarget: target({ lastScrapeAt: null }) }),
			NOW,
		)
		expect(setup.activeStepNumber).toBe(3)
		expect(setup.steps[2]!.state).toBe("current")
		expect(setup.steps[3]!.state).toBe("pending")
		// Nothing is scraping yet, so there is nothing to poll for.
		expect(setup.awaitingFirstScrape).toBe(false)
	})

	it("polls only once a token exists and the first scrape hasn't landed", () => {
		const setup = derivePlanetScaleSetup(status({ scrapeTarget: target({ lastScrapeAt: null }) }), NOW)
		expect(setup.awaitingFirstScrape).toBe(true)
		expect(setup.activeStepNumber).toBe(4)
		expect(setup.steps[3]!.state).toBe("current")
	})

	it("stops polling once the scrape degrades — waiting forever would be a lie", () => {
		const setup = derivePlanetScaleSetup(
			status({ scrapeTarget: target({ lastScrapeError: "403 Forbidden" }) }),
			NOW,
		)
		expect(setup.awaitingFirstScrape).toBe(false)
		expect(setup.steps[3]!.state).toBe("blocked")
	})

	it("blocks on a revoked grant and does not ask for a token underneath it", () => {
		const s = status({ revokedAt: NOW - 1000, metricsAuth: "missing" })
		expect(stateOf(s, "connected")).toBe("blocked")
		expect(stateOf(s, "permissions")).toBe("pending")
		// The token step must not be `current` while the grant itself is dead.
		expect(stateOf(s, "metrics-token")).toBe("pending")
		expect(derivePlanetScaleSetup(s, NOW).activeStepNumber).toBe(1)
	})

	it("blocks on an explicitly denied read_databases scope", () => {
		const s = status({ detectedPermissions: { readDatabases: false } })
		expect(stateOf(s, "permissions")).toBe("blocked")
	})

	it("treats unknown permissions as not-denied", () => {
		// Null before the org is bound, and an absent key is not a denial.
		expect(stateOf(status({ detectedPermissions: null }), "permissions")).toBe("done")
		expect(stateOf(status({ detectedPermissions: {} }), "permissions")).toBe("done")
	})

	it("reports an oauth-capable grant as needing no token at all", () => {
		const setup = derivePlanetScaleSetup(status({ metricsAuth: "oauth" }), NOW)
		expect(setup.complete).toBe(true)
		expect(setup.steps[2]!.detail).toContain("no token needed")
	})
})
