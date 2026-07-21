import { describe, expect, it } from "vitest"

import {
	anomalyDirection,
	baselineKey,
	buildBaselineMap,
	deriveServiceHealth,
	deriveServiceHealthFromCauses,
	errorRateTone,
	healthRank,
	healthToTone,
	incidentMatchesService,
	latencySeverity,
	latencyTone,
} from "./service-health"

// A current window busy enough that the latency signal is trusted.
const SPANS = 10_000

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

describe("deriveServiceHealth (absolute fallback — no baseline)", () => {
	it("is healthy when error rate and latency are low", () => {
		expect(deriveServiceHealth({ errorRate: 0.002, p95LatencyMs: 120, spanCount: SPANS }, false)).toBe(
			"healthy",
		)
	})

	it("is degraded at the error-rate warn threshold", () => {
		expect(deriveServiceHealth({ errorRate: 0.01, p95LatencyMs: 120, spanCount: SPANS }, false)).toBe(
			"degraded",
		)
	})

	it("is degraded at the p95 warn threshold", () => {
		expect(deriveServiceHealth({ errorRate: 0, p95LatencyMs: 1_000, spanCount: SPANS }, false)).toBe(
			"degraded",
		)
	})

	it("is unhealthy at the error-rate crit threshold", () => {
		expect(deriveServiceHealth({ errorRate: 0.05, p95LatencyMs: 120, spanCount: SPANS }, false)).toBe(
			"unhealthy",
		)
	})

	it("is unhealthy at the p95 crit threshold", () => {
		expect(deriveServiceHealth({ errorRate: 0, p95LatencyMs: 3_000, spanCount: SPANS }, false)).toBe(
			"unhealthy",
		)
	})

	it("forces unhealthy when an incident is open, regardless of metrics", () => {
		expect(deriveServiceHealth({ errorRate: 0, p95LatencyMs: 1, spanCount: SPANS }, true)).toBe(
			"unhealthy",
		)
	})
})

describe("deriveServiceHealth (baseline-relative latency)", () => {
	it("keeps a slow-by-design service healthy when latency matches its own baseline", () => {
		// Batch worker: baseline p95 of 60s, currently at 90s (1.5×) — would be
		// "unhealthy" under the absolute 3s threshold, but is normal for it.
		const baseline = { p95LatencyMs: 60_000, spanCount: 5_000 }
		expect(
			deriveServiceHealth({ errorRate: 0, p95LatencyMs: 90_000, spanCount: SPANS, baseline }, false),
		).toBe("healthy")
	})

	it("flags a genuine regression relative to the service's own baseline", () => {
		const baseline = { p95LatencyMs: 200, spanCount: 5_000 }
		expect(
			deriveServiceHealth({ errorRate: 0, p95LatencyMs: 450, spanCount: SPANS, baseline }, false),
		).toBe("degraded") // 2.25× baseline, above the 250ms floor
		expect(
			deriveServiceHealth({ errorRate: 0, p95LatencyMs: 900, spanCount: SPANS, baseline }, false),
		).toBe("unhealthy") // 4.5× baseline
	})

	it("never flags sub-floor latency even at a large ratio", () => {
		// 5ms → 15ms is 3× but harmless; the absolute floor keeps it ok.
		const baseline = { p95LatencyMs: 5, spanCount: 5_000 }
		expect(
			deriveServiceHealth({ errorRate: 0, p95LatencyMs: 15, spanCount: SPANS, baseline }, false),
		).toBe("healthy")
	})

	it("falls back to absolute thresholds when the baseline is too sparse", () => {
		const baseline = { p95LatencyMs: 60_000, spanCount: 40 }
		expect(
			deriveServiceHealth({ errorRate: 0, p95LatencyMs: 3_000, spanCount: SPANS, baseline }, false),
		).toBe("unhealthy")
	})

	it("does not flag latency in a sparse current window, but error rate still applies", () => {
		const baseline = { p95LatencyMs: 100, spanCount: 5_000 }
		expect(
			deriveServiceHealth({ errorRate: 0, p95LatencyMs: 9_000, spanCount: 10, baseline }, false),
		).toBe("healthy")
		expect(
			deriveServiceHealth({ errorRate: 0.5, p95LatencyMs: 9_000, spanCount: 10, baseline }, false),
		).toBe("unhealthy")
	})

	it("incident override outranks a healthy baseline comparison", () => {
		const baseline = { p95LatencyMs: 60_000, spanCount: 5_000 }
		expect(
			deriveServiceHealth({ errorRate: 0, p95LatencyMs: 60_000, spanCount: SPANS, baseline }, true),
		).toBe("unhealthy")
	})
})

describe("latencySeverity", () => {
	it("uses ratio thresholds against the baseline", () => {
		const baseline = { p95LatencyMs: 1_000, spanCount: 5_000 }
		expect(latencySeverity(1_500, SPANS, baseline)).toBe("ok")
		expect(latencySeverity(2_000, SPANS, baseline)).toBe("warn")
		expect(latencySeverity(4_000, SPANS, baseline)).toBe("crit")
	})

	it("ignores a zero-valued baseline", () => {
		expect(latencySeverity(3_000, SPANS, { p95LatencyMs: 0, spanCount: 5_000 })).toBe("crit")
	})
})

describe("healthToTone", () => {
	it("maps health levels onto severity tones", () => {
		expect(healthToTone("healthy")).toBe("ok")
		expect(healthToTone("degraded")).toBe("warn")
		expect(healthToTone("unhealthy")).toBe("crit")
	})
})

describe("per-metric tones", () => {
	it("tones error rate by its own thresholds", () => {
		expect(errorRateTone(0.005)).toBe("ok")
		expect(errorRateTone(0.01)).toBe("warn")
		expect(errorRateTone(0.05)).toBe("crit")
	})

	it("tones p95 latency by absolute thresholds when no baseline is given", () => {
		expect(latencyTone(500)).toBe("ok")
		expect(latencyTone(1_000)).toBe("warn")
		expect(latencyTone(3_000)).toBe("crit")
	})

	it("tones p95 latency relative to the baseline when given", () => {
		expect(latencyTone(90_000, SPANS, { p95LatencyMs: 60_000, spanCount: 5_000 })).toBe("ok")
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

describe("incidentMatchesService", () => {
	it("matches an open incident whose groupKey is the service name", () => {
		expect(incidentMatchesService({ status: "open", groupKey: "checkout" }, "checkout")).toBe(true)
	})

	it("does not match a resolved incident", () => {
		expect(incidentMatchesService({ status: "resolved", groupKey: "checkout" }, "checkout")).toBe(false)
	})

	it("does not match an incident for a different service", () => {
		expect(incidentMatchesService({ status: "open", groupKey: "billing" }, "checkout")).toBe(false)
	})

	it("does not match an incident without a group key", () => {
		expect(incidentMatchesService({ status: "open", groupKey: null }, "checkout")).toBe(false)
	})
})
