import { describe, expect, it } from "vitest"

import { placeMarkersInWindow, type ChartEventMarker } from "./chart-event-markers"

// Hourly buckets across a day boundary. The axis is a time scale now, so a
// marker sits at its own instant; what these pin down is the WINDOW — which
// events are drawn at all, and when a band degrades to a line.
const BUCKETS = [
	"2026-08-03T22:00:00Z",
	"2026-08-03T23:00:00Z",
	"2026-08-04T00:00:00Z",
	"2026-08-04T01:00:00Z",
]

const marker = (at: string, over: Partial<ChartEventMarker> = {}): ChartEventMarker => ({
	id: `m-${at}`,
	at,
	label: "Deploy",
	tone: "neutral",
	...over,
})

const iso = (date: Date | undefined) => date?.toISOString()

describe("placeMarkersInWindow", () => {
	it("places an event at its own instant, not on a bucket boundary", () => {
		const [placed] = placeMarkersInWindow([marker("2026-08-03T23:34:00Z")], BUCKETS)
		expect(iso(placed?.x)).toBe("2026-08-03T23:34:00.000Z")
	})

	it("keeps an event exactly on the first bucket", () => {
		const [placed] = placeMarkersInWindow([marker("2026-08-03T22:00:00Z")], BUCKETS)
		expect(iso(placed?.x)).toBe("2026-08-03T22:00:00.000Z")
	})

	it("keeps an event inside the final bucket's interval", () => {
		// The last bucket is an hour wide, not an instant.
		const [placed] = placeMarkersInWindow([marker("2026-08-04T01:45:00Z")], BUCKETS)
		expect(iso(placed?.x)).toBe("2026-08-04T01:45:00.000Z")
	})

	it("drops events before the window rather than clamping them to the first bucket", () => {
		// Clamping would read as "this deploy caused the thing at the window edge".
		expect(placeMarkersInWindow([marker("2026-08-03T20:00:00Z")], BUCKETS)).toEqual([])
	})

	it("drops events after the window", () => {
		expect(placeMarkersInWindow([marker("2026-08-04T09:00:00Z")], BUCKETS)).toEqual([])
	})

	it("reads tz-less warehouse buckets as UTC", () => {
		const warehouse = ["2026-08-03 22:00:00", "2026-08-03 23:00:00", "2026-08-04 00:00:00"]
		const [placed] = placeMarkersInWindow([marker("2026-08-03T23:30:00Z")], warehouse)
		expect(iso(placed?.x)).toBe("2026-08-03T23:30:00.000Z")
	})

	it("does not depend on bucket order", () => {
		const shuffled = [BUCKETS[2]!, BUCKETS[0]!, BUCKETS[3]!, BUCKETS[1]!]
		const [placed] = placeMarkersInWindow([marker("2026-08-04T01:45:00Z")], shuffled)
		expect(iso(placed?.x)).toBe("2026-08-04T01:45:00.000Z")
	})

	it("returns a band when the marker has a resolvable end", () => {
		const [placed] = placeMarkersInWindow(
			[marker("2026-08-03T22:10:00Z", { endsAt: "2026-08-04T00:30:00Z" })],
			BUCKETS,
		)
		expect(iso(placed?.x)).toBe("2026-08-03T22:10:00.000Z")
		expect(iso(placed?.x2)).toBe("2026-08-04T00:30:00.000Z")
	})

	it("degrades a band to a line when the end is unresolvable or not after the start", () => {
		// Still-running maintenance, or an end past the window: a band that
		// silently stopped early would understate the outage.
		const [running] = placeMarkersInWindow(
			[marker("2026-08-04T00:10:00Z", { endsAt: "2026-08-05T00:00:00Z" })],
			BUCKETS,
		)
		expect(running?.x2).toBeUndefined()

		const [inverted] = placeMarkersInWindow(
			[marker("2026-08-04T00:10:00Z", { endsAt: "2026-08-04T00:10:00Z" })],
			BUCKETS,
		)
		expect(inverted?.x2).toBeUndefined()
	})

	it("is empty for no markers or no buckets", () => {
		expect(placeMarkersInWindow([], BUCKETS)).toEqual([])
		expect(placeMarkersInWindow([marker("2026-08-04T00:00:00Z")], [])).toEqual([])
	})

	it("drops markers with an unparseable timestamp", () => {
		expect(placeMarkersInWindow([marker("not-a-date")], BUCKETS)).toEqual([])
	})

	it("handles a single-bucket window", () => {
		const single = ["2026-08-04T00:00:00Z"]
		// Width is unknown with one bucket, so only the instant itself lands.
		expect(iso(placeMarkersInWindow([marker("2026-08-04T00:00:00Z")], single)[0]?.x)).toBe(
			"2026-08-04T00:00:00.000Z",
		)
		expect(placeMarkersInWindow([marker("2026-08-04T00:30:00Z")], single)).toEqual([])
	})
})
