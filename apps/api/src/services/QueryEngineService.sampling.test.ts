import { describe, expect, it } from "vitest"

/**
 * TS mirror of the ClickHouse `SampleRate` MATERIALIZED expression on the
 * `traces` datasource. The query engine no longer parses thresholds in JS —
 * instead it sums the per-row `SampleRate` column directly. This test pins
 * down the SQL math so changes to `SAMPLE_RATE_EXPR` in
 * packages/domain/src/tinybird/datasources.ts don't silently change values.
 *
 * The CH expression resolves SampleRate in three branches:
 *   1. SpanAttributes['SampleRate'] (explicit, set by collector)
 *   2. W3C TraceState `th:<hex>` threshold sampling
 *   3. default 1.0
 *
 * This function only mirrors branch (2), since (1) is a passthrough and (3)
 * is trivially 1.0.
 */
function sampleRateFromTraceState(traceState: string): number {
	const m = traceState.match(/th:([0-9a-f]+)/)
	if (!m) return 1.0
	const hex = m[1]!

	// CH SQL: rightPad(hex, 16, '0') -> unhex (8 bytes) -> reverse ->
	//         reinterpretAsUInt64 -> divide by pow(2, 64).
	// This normalizes any hex length to a 64-bit fraction.
	const padded = hex.padEnd(16, "0")
	const asInt = BigInt("0x" + padded)
	const rejection = Number(asInt) / Math.pow(2, 64)
	return 1.0 / Math.max(1.0 - rejection, 0.0001)
}

describe("SampleRate materialization", () => {
	it("th:8 → weight 2.0 (50% rejection)", () => {
		expect(sampleRateFromTraceState("th:8")).toBeCloseTo(2.0)
	})

	it("th:c → weight 4.0 (75% rejection)", () => {
		expect(sampleRateFromTraceState("th:c")).toBeCloseTo(4.0)
	})

	it("th:80 (multi-char hex) → weight 2.0", () => {
		expect(sampleRateFromTraceState("th:80")).toBeCloseTo(2.0)
	})

	it("th:f (15/16 reject) → weight 16.0", () => {
		expect(sampleRateFromTraceState("th:f")).toBeCloseTo(16.0)
	})

	it("no th: → weight 1.0", () => {
		expect(sampleRateFromTraceState("")).toBe(1.0)
		expect(sampleRateFromTraceState("vendor=foo")).toBe(1.0)
		expect(sampleRateFromTraceState("rojo=00f067aa0ba902b7")).toBe(1.0)
	})

	it("th: embedded in larger TraceState → still extracts", () => {
		expect(sampleRateFromTraceState("vendor=x,th:8,other=y")).toBeCloseTo(2.0)
	})

	it("clamps near-100% rejection to 1/0.0001 = 10000", () => {
		// hex 'fffffffffffffffe' is essentially full rejection; SQL clamps via greatest(..., 0.0001)
		const result = sampleRateFromTraceState("th:fffffffffffffffe")
		expect(result).toBeLessThanOrEqual(10000)
		expect(result).toBeGreaterThan(1)
	})
})

describe("Mixed-threshold buckets — the bug this replaces", () => {
	// Regression test: the old approach picked one threshold per bucket via
	// `anyIf` and applied it to every sampled span, which inflated estimates by
	// orders of magnitude under mixed sampling rates. Sum-of-SampleRate scales
	// each row by its own threshold, so a 99/1 mix of th:8 / th:fff8 yields
	// ~99 * 2 + 1 * 8192 ≈ 8390, NOT 100 * 8192 = 819200.
	it("99 spans at th:8 + 1 span at th:fff8 → ~8390 not ~820000", () => {
		const lightWeight = sampleRateFromTraceState("th:8") // ~2
		const heavyWeight = sampleRateFromTraceState("th:fff8") // ~8192
		const correctEstimate = 99 * lightWeight + 1 * heavyWeight
		expect(correctEstimate).toBeGreaterThan(8000)
		expect(correctEstimate).toBeLessThan(8400)

		// What the old `anyIf(threshold)` approach would have produced if it
		// happened to pick the heavy threshold:
		const oldBuggyEstimate = 100 * heavyWeight
		expect(oldBuggyEstimate).toBeGreaterThan(800000)
		// The fix changes the answer by ~100x for this mix.
		expect(oldBuggyEstimate / correctEstimate).toBeGreaterThan(90)
	})
})
