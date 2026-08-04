import { describe, expect, it } from "vitest"

import { snapMarkersToBuckets, type ChartEventMarker } from "./chart-event-markers"

// Hourly buckets across a day boundary, so the labels deliberately repeat —
// that repetition is the whole reason snapping is by index, not by label.
const BUCKETS = [
	"2026-08-03T22:00:00Z",
	"2026-08-03T23:00:00Z",
	"2026-08-04T00:00:00Z",
	"2026-08-04T01:00:00Z",
]

const labelFor = (iso: string) => `${new Date(iso).getUTCHours()}:00`

const marker = (at: string, over: Partial<ChartEventMarker> = {}): ChartEventMarker => ({
	id: `m-${at}`,
	at,
	label: "Deploy",
	tone: "neutral",
	...over,
})

describe("snapMarkersToBuckets", () => {
	it("snaps an event to the bucket that contains it", () => {
		const [snapped] = snapMarkersToBuckets([marker("2026-08-03T23:34:00Z")], BUCKETS, labelFor)
		expect(snapped?.x).toBe("23:00")
	})

	it("keeps an event exactly on a bucket boundary in that bucket", () => {
		const [snapped] = snapMarkersToBuckets([marker("2026-08-04T00:00:00Z")], BUCKETS, labelFor)
		expect(snapped?.x).toBe("0:00")
	})

	it("keeps an event inside the final bucket's interval", () => {
		// The last bucket is an hour wide, not an instant.
		const [snapped] = snapMarkersToBuckets([marker("2026-08-04T01:45:00Z")], BUCKETS, labelFor)
		expect(snapped?.x).toBe("1:00")
	})

	it("drops events before the window rather than clamping them to the first bucket", () => {
		// Clamping would read as "this deploy caused the thing at the window edge".
		expect(snapMarkersToBuckets([marker("2026-08-03T20:00:00Z")], BUCKETS, labelFor)).toEqual([])
	})

	it("drops events after the window", () => {
		expect(snapMarkersToBuckets([marker("2026-08-04T09:00:00Z")], BUCKETS, labelFor)).toEqual([])
	})

	it("distinguishes repeated labels by index", () => {
		// "23:00" only exists once here, but "0:00" and "1:00" would repeat on a
		// two-day window — snapping resolves to a distinct bucket regardless.
		const snapped = snapMarkersToBuckets(
			[marker("2026-08-03T22:10:00Z"), marker("2026-08-04T00:10:00Z")],
			BUCKETS,
			labelFor,
		)
		expect(snapped.map((s) => s.x)).toEqual(["22:00", "0:00"])
	})

	it("returns a band when the marker has a resolvable end", () => {
		const [snapped] = snapMarkersToBuckets(
			[marker("2026-08-03T22:10:00Z", { endsAt: "2026-08-04T00:30:00Z" })],
			BUCKETS,
			labelFor,
		)
		expect(snapped?.x).toBe("22:00")
		expect(snapped?.x2).toBe("0:00")
	})

	it("degrades a band to a line when the end is unresolvable or not after the start", () => {
		// Still-running maintenance, or an end past the window: a band that
		// silently stopped early would understate the outage.
		const [running] = snapMarkersToBuckets(
			[marker("2026-08-04T00:10:00Z", { endsAt: "2026-08-05T00:00:00Z" })],
			BUCKETS,
			labelFor,
		)
		expect(running?.x2).toBeUndefined()

		const [sameBucket] = snapMarkersToBuckets(
			[marker("2026-08-04T00:10:00Z", { endsAt: "2026-08-04T00:20:00Z" })],
			BUCKETS,
			labelFor,
		)
		expect(sameBucket?.x2).toBeUndefined()
	})

	it("is empty for no markers or no buckets", () => {
		expect(snapMarkersToBuckets([], BUCKETS, labelFor)).toEqual([])
		expect(snapMarkersToBuckets([marker("2026-08-04T00:00:00Z")], [], labelFor)).toEqual([])
	})

	it("drops markers with an unparseable timestamp", () => {
		expect(snapMarkersToBuckets([marker("not-a-date")], BUCKETS, labelFor)).toEqual([])
	})

	it("handles a single-bucket window", () => {
		const single = ["2026-08-04T00:00:00Z"]
		// Width is unknown with one bucket, so only the instant itself lands.
		expect(snapMarkersToBuckets([marker("2026-08-04T00:00:00Z")], single, labelFor)[0]?.x).toBe("0:00")
		expect(snapMarkersToBuckets([marker("2026-08-04T00:30:00Z")], single, labelFor)).toEqual([])
	})
})
