import { describe, expect, it } from "vitest"
import { parseSamplingWeight } from "./QueryEngineService"

/**
 * TS mirror of the ClickHouse `SampleRate` MATERIALIZED expression on the
 * `traces` datasource. If the SQL math diverges from this function (or from
 * `parseSamplingWeight`), the materialized column will return values that
 * disagree with the runtime sampling-weight logic — this test catches that.
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

describe("SampleRate materialization parity", () => {
	it("th:8 → weight 2.0 (matches parseSamplingWeight)", () => {
		expect(sampleRateFromTraceState("th:8")).toBeCloseTo(parseSamplingWeight("8"))
		expect(sampleRateFromTraceState("th:8")).toBeCloseTo(2.0)
	})

	it("th:c → weight 4.0", () => {
		expect(sampleRateFromTraceState("th:c")).toBeCloseTo(parseSamplingWeight("c"))
		expect(sampleRateFromTraceState("th:c")).toBeCloseTo(4.0)
	})

	it("th:80 (multi-char hex) → weight 2.0", () => {
		expect(sampleRateFromTraceState("th:80")).toBeCloseTo(parseSamplingWeight("80"))
		expect(sampleRateFromTraceState("th:80")).toBeCloseTo(2.0)
	})

	it("th:f (15/16 reject) → weight 16.0", () => {
		expect(sampleRateFromTraceState("th:f")).toBeCloseTo(parseSamplingWeight("f"))
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

	it("matches parseSamplingWeight for known thresholds across the range", () => {
		const cases = ["1", "4", "8", "c", "f", "80", "c0", "f0"]
		for (const hex of cases) {
			const fromMaterializedSql = sampleRateFromTraceState(`th:${hex}`)
			const fromRuntime = parseSamplingWeight(hex)
			expect(fromMaterializedSql).toBeCloseTo(fromRuntime)
		}
	})

	it("clamps near-100% rejection to 1/0.0001 = 10000", () => {
		// hex 'fffffffffffffffe' is essentially full rejection; SQL clamps via greatest(..., 0.0001)
		const result = sampleRateFromTraceState("th:fffffffffffffffe")
		expect(result).toBeLessThanOrEqual(10000)
		expect(result).toBeGreaterThan(1)
	})
})
