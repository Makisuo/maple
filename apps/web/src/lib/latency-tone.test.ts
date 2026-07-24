import { describe, expect, it } from "vitest"

import {
	LATENCY_TEXT_TONE,
	latencyLevel,
	latencyLevelLabel,
	latencyToneClass,
} from "@maple/ui/lib/latency-tone"

describe("latencyLevel", () => {
	it("walks the p95 ramp at 150ms / 500ms / 1s / 3s", () => {
		expect(latencyLevel(149, "p95")).toBe("quiet")
		expect(latencyLevel(150, "p95")).toBe("nominal")
		expect(latencyLevel(499, "p95")).toBe("nominal")
		expect(latencyLevel(500, "p95")).toBe("elevated")
		expect(latencyLevel(999, "p95")).toBe("elevated")
		expect(latencyLevel(1_000, "p95")).toBe("slow")
		expect(latencyLevel(2_999, "p95")).toBe("slow")
		expect(latencyLevel(3_000, "p95")).toBe("critical")
	})

	// The p95 slow/critical boundaries must stay pinned to the absolute health
	// thresholds in components/dashboard/service-health.ts, so a toned cell never
	// disagrees with the health badge on the same row.
	it("agrees with the service-health absolute p95 thresholds", () => {
		const P95_DEGRADED_MS = 1_000
		const P95_UNHEALTHY_MS = 3_000
		expect(latencyLevel(P95_DEGRADED_MS - 1, "p95")).toBe("elevated")
		expect(latencyLevel(P95_DEGRADED_MS, "p95")).toBe("slow")
		expect(latencyLevel(P95_UNHEALTHY_MS, "p95")).toBe("critical")
	})

	it("scales the ramp per percentile so a healthy service reads flat", () => {
		// A healthy service: none of these should advance past "nominal".
		expect(latencyLevel(42, "p50")).toBe("quiet")
		expect(latencyLevel(180, "p95")).toBe("nominal")
		expect(latencyLevel(410, "p99")).toBe("nominal")

		// A slow one: the same absolute values now tone by their own budget.
		expect(latencyLevel(310, "p50")).toBe("slow")
		expect(latencyLevel(2_400, "p95")).toBe("slow")
		expect(latencyLevel(7_100, "p99")).toBe("critical")
	})

	it("gives avg its own budget between p50 and p95", () => {
		expect(latencyLevel(74, "avg")).toBe("quiet")
		expect(latencyLevel(250, "avg")).toBe("elevated")
		expect(latencyLevel(500, "avg")).toBe("slow")
		expect(latencyLevel(1_500, "avg")).toBe("critical")
	})

	// Worker CPU time is ~20x tighter than wall-clock latency; on the p99 budget
	// every worker would collapse to "quiet".
	it("uses a tighter budget for cpu time", () => {
		expect(latencyLevel(12, "cpu")).toBe("nominal")
		expect(latencyLevel(12, "p99")).toBe("quiet")
		expect(latencyLevel(50, "cpu")).toBe("slow")
		expect(latencyLevel(150, "cpu")).toBe("critical")
	})

	it("defaults to the p95 scale", () => {
		expect(latencyLevel(2_400)).toBe(latencyLevel(2_400, "p95"))
	})

	it("honours a budgetMs override", () => {
		expect(latencyLevel(12, "p99", 50)).toBe("nominal")
		expect(latencyLevel(60, "p50", 50)).toBe("slow")
	})

	it("treats missing and non-finite values as quiet rather than fast", () => {
		expect(latencyLevel(0, "p95")).toBe("quiet")
		expect(latencyLevel(-1, "p95")).toBe("quiet")
		expect(latencyLevel(Number.NaN, "p95")).toBe("quiet")
		expect(latencyLevel(Number.POSITIVE_INFINITY, "p95")).toBe("quiet")
		expect(latencyLevel(500, "p95", 0)).toBe("quiet")
	})
})

describe("latencyToneClass", () => {
	it("resolves to the text tone for the level", () => {
		expect(latencyToneClass(42, "p50")).toBe(LATENCY_TEXT_TONE.quiet)
		expect(latencyToneClass(2_400, "p95")).toBe(LATENCY_TEXT_TONE.slow)
		expect(latencyToneClass(7_100, "p99")).toBe(LATENCY_TEXT_TONE.critical)
	})
})

describe("latencyLevelLabel", () => {
	it("gives every level a plain word, so tone is never color-only", () => {
		expect(latencyLevelLabel("quiet")).toBe("fast")
		expect(latencyLevelLabel("nominal")).toBe("normal")
		expect(latencyLevelLabel("elevated")).toBe("elevated")
		expect(latencyLevelLabel("slow")).toBe("slow")
		expect(latencyLevelLabel("critical")).toBe("very slow")
	})
})
