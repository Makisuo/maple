import { describe, expect, it } from "@effect/vitest"
import type { TimeseriesPoint } from "@maple/domain/query-engine"
import { decodeEvalPoints, encodeEvalPoints, type BucketGroupObs } from "./evaluate-bucket-codec"

const B0 = "2026-06-01T00:00:00.000Z"
const B1 = "2026-06-01T00:01:00.000Z"

/** Simulate the EdgeCache JSON round-trip so tests catch NaN/serialization drift. */
const roundTrip = (points: ReadonlyArray<TimeseriesPoint>): TimeseriesPoint[] =>
	JSON.parse(JSON.stringify(points))

describe("encode/decode eval points", () => {
	it("round-trips a single group across buckets", () => {
		const obs: BucketGroupObs[] = [
			{ bucket: B0, groupKey: "all", value: 10, sampleCount: 3 },
			{ bucket: B1, groupKey: "all", value: 20, sampleCount: 5 },
		]
		const decoded = decodeEvalPoints(roundTrip(encodeEvalPoints(obs)))
		expect(decoded.get("all")).toEqual([
			{ value: 10, sampleCount: 3, hasData: true },
			{ value: 20, sampleCount: 5, hasData: true },
		])
	})

	it("keeps groups separate and preserves multi-group buckets", () => {
		const obs: BucketGroupObs[] = [
			{ bucket: B0, groupKey: "api", value: 1, sampleCount: 2 },
			{ bucket: B0, groupKey: "web", value: 4, sampleCount: 8 },
			{ bucket: B1, groupKey: "api", value: 3, sampleCount: 6 },
		]
		const decoded = decodeEvalPoints(roundTrip(encodeEvalPoints(obs)))
		expect(decoded.get("api")).toEqual([
			{ value: 1, sampleCount: 2, hasData: true },
			{ value: 3, sampleCount: 6, hasData: true },
		])
		expect(decoded.get("web")).toEqual([{ value: 4, sampleCount: 8, hasData: true }])
	})

	it("represents a zero-sample bucket as no-data (value null, hasData false)", () => {
		const obs: BucketGroupObs[] = [
			{ bucket: B0, groupKey: "all", value: null, sampleCount: 0 },
			{ bucket: B1, groupKey: "all", value: 7, sampleCount: 4 },
		]
		const decoded = decodeEvalPoints(roundTrip(encodeEvalPoints(obs)))
		expect(decoded.get("all")).toEqual([
			{ value: null, sampleCount: 0, hasData: false },
			{ value: 7, sampleCount: 4, hasData: true },
		])
	})

	it("normalizes non-finite values to null (survives JSON round-trip)", () => {
		const obs: BucketGroupObs[] = [{ bucket: B0, groupKey: "all", value: Number.NaN, sampleCount: 9 }]
		const decoded = decodeEvalPoints(roundTrip(encodeEvalPoints(obs)))
		// sampleCount is preserved; the NaN value becomes null rather than a
		// JSON-coerced surprise.
		expect(decoded.get("all")).toEqual([{ value: null, sampleCount: 9, hasData: true }])
	})

	it("preserves group keys containing the metric composite separator", () => {
		const key = "api · us-east"
		const obs: BucketGroupObs[] = [{ bucket: B0, groupKey: key, value: 2, sampleCount: 1 }]
		const decoded = decodeEvalPoints(roundTrip(encodeEvalPoints(obs)))
		expect([...decoded.keys()]).toEqual([key])
		expect(decoded.get(key)).toEqual([{ value: 2, sampleCount: 1, hasData: true }])
	})

	it("decodes an empty point list to an empty map", () => {
		expect(decodeEvalPoints([]).size).toBe(0)
	})
})
