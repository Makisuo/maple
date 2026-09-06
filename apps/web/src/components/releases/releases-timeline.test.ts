import { describe, expect, it } from "vitest"
import type { ReleaseServiceImpact } from "./release-model"
import { clusterMarkers } from "./releases-timeline"

const START = Date.parse("2026-09-01T00:00:00.000Z")
const END = Date.parse("2026-09-08T00:00:00.000Z")

function impact(firstSeen: string, health: ReleaseServiceImpact["health"] = "healthy"): ReleaseServiceImpact {
	return {
		serviceName: "api",
		environment: "production",
		commitSha: firstSeen,
		firstSeen,
		spanCount: 100,
		errorCount: 0,
		errorRate: 0,
		p50LatencyMs: 1,
		p95LatencyMs: 1,
		p99LatencyMs: 1,
		apdexScore: 1,
		baseline: undefined,
		errorRatio: undefined,
		p95Delta: undefined,
		share: undefined,
		isNewest: false,
		health,
	}
}

describe("clusterMarkers", () => {
	it("merges deploys closer than a dot's width and keeps the worst health", () => {
		const markers = clusterMarkers(
			[
				impact("2026-09-03T12:00:00.000Z"),
				impact("2026-09-03T12:40:00.000Z", "regressed"),
				impact("2026-09-03T13:20:00.000Z"),
				impact("2026-09-06T00:00:00.000Z", "watch"),
			],
			START,
			END,
			0.016,
		)
		expect(markers.map((m) => m.members.length)).toEqual([3, 1])
		expect(markers[0]?.health).toBe("regressed")
		// Newest first inside a marker, so the link opens the latest deploy.
		expect(markers[0]?.members[0]?.firstSeen).toBe("2026-09-03T13:20:00.000Z")
		expect(markers[1]?.health).toBe("watch")
	})

	it("anchors a cluster on its first member rather than chaining", () => {
		// Four deploys 1% apart: the second fits within 1.6% of the first,
		// the third opens a new marker instead of stretching the first forever.
		const week = END - START
		const at = (ratio: number) => new Date(START + ratio * week).toISOString()
		const markers = clusterMarkers(
			[impact(at(0.1)), impact(at(0.11)), impact(at(0.12)), impact(at(0.13))],
			START,
			END,
			0.016,
		)
		expect(markers.map((m) => m.members.length)).toEqual([2, 2])
	})

	it("merges more on a narrow track", () => {
		const week = END - START
		const at = (ratio: number) => new Date(START + ratio * week).toISOString()
		const dots = [impact(at(0.1)), impact(at(0.13)), impact(at(0.16))]
		expect(clusterMarkers(dots, START, END, 0.016).map((m) => m.members.length)).toEqual([1, 1, 1])
		// A 300px track: 18px is 6% of it, so the three collapse pairwise.
		expect(clusterMarkers(dots, START, END, 18 / 300).map((m) => m.members.length)).toEqual([2, 1])
	})

	it("clamps deploys outside the window onto its edges", () => {
		const markers = clusterMarkers(
			[impact("2026-08-01T00:00:00.000Z"), impact("2026-09-09T00:00:00.000Z")],
			START,
			END,
			0.016,
		)
		expect(markers.map((m) => m.ratio)).toEqual([0, 1])
	})
})
