import { describe, expect, it } from "vitest"
import { recordedMarker, replayPartitionWindow } from "./replay-format"

// The session-detail warehouse queries are PARTITION BY toDate(...) over a 30-day
// TTL; `replayPartitionWindow` turns a session's start (and optional end) into the
// TinybirdDateTime window that prunes those daily partitions. The strings it emits
// MUST match the `YYYY-MM-DD HH:mm:ss` shape the domain `TinybirdDateTime` schema
// accepts, or the request would be rejected before it leaves the browser.
describe("replayPartitionWindow", () => {
	it("derives a [start - 1h, start + 24h] window from a start-only hint", () => {
		const w = replayPartitionWindow("2026-06-24 05:16:41.023800000")
		expect(w).toEqual({
			windowStart: "2026-06-24 04:16:41",
			windowEnd: "2026-06-25 05:16:41",
		})
	})

	it("uses the session end (+1h margin) for the upper bound when provided", () => {
		const w = replayPartitionWindow("2026-06-24 05:16:41", "2026-06-24 05:40:00")
		expect(w).toEqual({
			windowStart: "2026-06-24 04:16:41",
			windowEnd: "2026-06-24 06:40:00",
		})
	})

	it("emits `YYYY-MM-DD HH:mm:ss` strings (no fractional seconds, space-separated)", () => {
		const w = replayPartitionWindow("2026-06-24 05:16:41.5")
		expect(w?.windowStart).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
		expect(w?.windowEnd).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
	})

	it("returns undefined for a missing or unparseable hint (deep-link full-scan fallback)", () => {
		expect(replayPartitionWindow(undefined)).toBeUndefined()
		expect(replayPartitionWindow(null)).toBeUndefined()
		expect(replayPartitionWindow("")).toBeUndefined()
		expect(replayPartitionWindow("not-a-timestamp")).toBeUndefined()
	})
})

// The player picks between "not recorded" and "still uploading" from this
// marker. Anything it can't read must come back `undefined` (unknown) rather
// than `false`, or a session mid-upload would be declared unrecorded.
describe("recordedMarker", () => {
	it("reads the SDK's marker in both directions", () => {
		expect(recordedMarker(JSON.stringify({ "maple.session.recorded": "true" }))).toBe(true)
		expect(recordedMarker(JSON.stringify({ "maple.session.recorded": "false" }))).toBe(false)
	})

	it("is undefined when the marker is absent (pre-marker sessions)", () => {
		expect(recordedMarker(JSON.stringify({ "deployment.environment": "production" }))).toBeUndefined()
		expect(recordedMarker("{}")).toBeUndefined()
	})

	it("is undefined for empty, unparseable, or non-object attributes", () => {
		expect(recordedMarker(undefined)).toBeUndefined()
		expect(recordedMarker(null)).toBeUndefined()
		expect(recordedMarker("")).toBeUndefined()
		expect(recordedMarker("{not json")).toBeUndefined()
		expect(recordedMarker("null")).toBeUndefined()
		expect(recordedMarker('"a string"')).toBeUndefined()
	})

	it("is undefined for an unexpected marker value rather than guessing", () => {
		expect(recordedMarker(JSON.stringify({ "maple.session.recorded": "1" }))).toBeUndefined()
	})
})
