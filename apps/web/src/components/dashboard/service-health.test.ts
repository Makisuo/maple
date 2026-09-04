import { describe, expect, it } from "vitest"

import {
	anomalyDirection,
	baselineKey,
	buildBaselineMap,
	deriveServiceHealthFromCauses,
	healthRank,
} from "./service-health"

describe("anomalyDirection", () => {
	it("shows throughput drops as down and upward-only detectors as up", () => {
		expect(anomalyDirection("throughput")).toBe("down")
		expect(anomalyDirection("error_rate")).toBe("up")
		expect(anomalyDirection("latency_p95")).toBe("up")
		expect(anomalyDirection("error_spike")).toBe("up")
		expect(anomalyDirection("log_volume")).toBe("up")
	})
})

describe("deriveServiceHealthFromCauses", () => {
	it("only degrades for validated warning or critical incidents", () => {
		expect(deriveServiceHealthFromCauses([])).toBe("healthy")
		expect(deriveServiceHealthFromCauses([{ severity: "warning", label: "Latency anomaly" }])).toBe(
			"degraded",
		)
		expect(deriveServiceHealthFromCauses([{ severity: "critical", label: "Alert firing" }])).toBe(
			"unhealthy",
		)
	})

	it("lets a critical cause outrank warnings", () => {
		expect(
			deriveServiceHealthFromCauses([
				{ severity: "warning", label: "Traffic anomaly" },
				{ severity: "critical", label: "Error rate anomaly" },
			]),
		).toBe("unhealthy")
	})
})

describe("buildBaselineMap", () => {
	it("keys rows by service::namespace::environment", () => {
		const map = buildBaselineMap([
			{
				serviceName: "checkout",
				serviceNamespace: "shop",
				environment: "production",
				baselineP95LatencyMs: 120,
				baselineSpanCount: 4_000,
			},
		])
		expect(map.get(baselineKey("checkout", "shop", "production"))).toEqual({
			p95LatencyMs: 120,
			spanCount: 4_000,
		})
		expect(map.get(baselineKey("checkout", "shop", "staging"))).toBeUndefined()
	})
})

describe("healthRank", () => {
	it("ranks worse health higher so it sorts first", () => {
		expect(healthRank("unhealthy")).toBeGreaterThan(healthRank("degraded"))
		expect(healthRank("degraded")).toBeGreaterThan(healthRank("healthy"))
	})
})
