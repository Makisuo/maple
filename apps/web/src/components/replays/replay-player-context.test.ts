import { describe, expect, it } from "vitest"
import { classifyUnplayable, deriveMeta } from "./replay-player-context"

// When a session has no playable frames, the player must say *why*. Getting
// this wrong is user-visible in both directions: calling a live upload
// "not recorded" is a lie for the whole time someone watches a live session,
// and calling a metadata-only session "still recording" leaves them waiting on
// frames that are never coming.

describe("classifyUnplayable", () => {
	describe("with the SDK marker present", () => {
		it("trusts a false marker over everything else", () => {
			expect(classifyUnplayable({ recorded: false, chunkCount: 0, sessionActive: false })).toBe(
				"unrecorded",
			)
			// Even while the session is open: the SDK already told us no recorder
			// is running, so no chunks are coming no matter how long we wait.
			expect(classifyUnplayable({ recorded: false, chunkCount: 0, sessionActive: true })).toBe(
				"unrecorded",
			)
		})

		it("keeps a marked-recorded session in the still-arriving state", () => {
			// A recorder ran, so chunks exist or are in flight — never "unrecorded",
			// however few frames decoded.
			expect(classifyUnplayable({ recorded: true, chunkCount: 0, sessionActive: true })).toBe("empty")
			expect(classifyUnplayable({ recorded: true, chunkCount: 1, sessionActive: false })).toBe("empty")
		})
	})

	// Sessions written before the SDK stamped the marker. The only safe
	// inference is "closed and never wrote a chunk".
	describe("without the marker (legacy sessions)", () => {
		it("calls a closed, chunkless session unrecorded", () => {
			expect(classifyUnplayable({ recorded: undefined, chunkCount: 0, sessionActive: false })).toBe(
				"unrecorded",
			)
		})

		it("does not guess while the session is still open", () => {
			expect(classifyUnplayable({ recorded: undefined, chunkCount: 0, sessionActive: true })).toBe(
				"empty",
			)
		})

		it("does not guess when chunks exist but decoded too short to play", () => {
			expect(classifyUnplayable({ recorded: undefined, chunkCount: 3, sessionActive: false })).toBe(
				"empty",
			)
		})
	})
})

// Marker and idle-band derivation runs over the raw event stream, which is now
// two different shapes: rrweb DOM events from a browser, and H.264 segments from
// a phone. Both have to land on the same timeline.

const T0 = 1_700_000_000_000

const videoEvent = (offsetMs: number, durationMs: number) => ({
	type: 5,
	timestamp: T0 + offsetMs,
	data: {
		tag: "video",
		payload: {
			segmentId: `seg-${offsetMs}`,
			duration: durationMs,
			width: 390,
			height: 844,
			base64: "AA==",
		},
	},
})

const metaEvent = (offsetMs: number, href = "app://main") => ({
	type: 4,
	timestamp: T0 + offsetMs,
	data: { href, width: 390, height: 844 },
})

/** rrweb mouseInteraction; `type` 2 is Click, 7 is TouchStart. */
const interaction = (offsetMs: number, type: number) => ({
	type: 3,
	timestamp: T0 + offsetMs,
	data: { source: 2, type },
})

describe("deriveMeta idle bands", () => {
	it("does not call continuous video segments idle", () => {
		// THE trap for video sessions. Segments are ~30s apart and a quiet one
		// emits a single event, so measuring idle from timestamps alone marks every
		// segment as a 30s gap — and skip-idle (on by default) then collapses the
		// entire recording to nothing. A segment stays active for its duration.
		const events = [
			metaEvent(0),
			videoEvent(0, 30_000),
			videoEvent(30_000, 30_000),
			videoEvent(60_000, 30_000),
		]
		expect(deriveMeta(events).inactiveIntervals).toEqual([])
	})

	it("survives the sibling events the SDK emits on the same timestamp", () => {
		// Modelled on a real recording (9 chunks, 5-6s segments): each chunk is
		// `meta`, `video` and `breadcrumb` all stamped with the SAME ms, breadcrumb
		// last. A plain assignment would rewind the watermark from (ts + duration)
		// back to ts when the breadcrumb lands, and every segment would register as
		// a gap again — so the watermark has to be monotonic.
		const chunk = (atMs: number, durationMs: number) => [
			metaEvent(atMs),
			videoEvent(atMs, durationMs),
			{ type: 5, timestamp: T0 + atMs, data: { tag: "breadcrumb", payload: { name: "tap" } } },
		]
		const events = [...chunk(0, 5_000), ...chunk(5_001, 6_000), ...chunk(11_007, 6_000)]
		expect(deriveMeta(events).inactiveIntervals).toEqual([])
	})

	it("still reports a real gap between segments", () => {
		// The recorder stops while the app is backgrounded. That hole is genuine
		// idle and must stay collapsible, or skip-idle stops being useful.
		const events = [metaEvent(0), videoEvent(0, 30_000), videoEvent(90_000, 30_000)]
		expect(deriveMeta(events).inactiveIntervals).toEqual([{ start: 30_000, end: 90_000 }])
	})

	it("keeps treating ordinary rrweb events as instants", () => {
		const events = [metaEvent(0), interaction(1_000, 2), interaction(20_000, 2)]
		expect(deriveMeta(events).inactiveIntervals).toEqual([{ start: 1_000, end: 20_000 }])
	})
})

describe("deriveMeta markers", () => {
	it("marks a touch as a click", () => {
		// Mobile sessions only ever emit TouchStart (7). rrweb records touch on
		// mobile *web* too, so before this a phone session of either kind produced
		// no click markers at all.
		const markers = deriveMeta([metaEvent(0), interaction(5_000, 7)]).actionMarkers
		expect(markers).toEqual([{ ms: 5_000, kind: "click" }])
	})

	it("still marks a mouse click", () => {
		const markers = deriveMeta([metaEvent(0), interaction(5_000, 2)]).actionMarkers
		expect(markers).toEqual([{ ms: 5_000, kind: "click" }])
	})

	it("ignores touch-move and touch-end", () => {
		// 8 is TouchMove_Departed, 9 is TouchEnd — a drag is one interaction, not
		// three markers stacked on the scrubber.
		const markers = deriveMeta([metaEvent(0), interaction(5_000, 8), interaction(5_100, 9)]).actionMarkers
		expect(markers).toEqual([])
	})

	it("takes the recorded viewport from a mobile meta event", () => {
		const meta = deriveMeta([metaEvent(0), videoEvent(0, 30_000)])
		expect(meta).toMatchObject({ recordedWidth: 390, recordedHeight: 844, startTime: T0 })
	})

	it("marks navigation on a genuine screen change", () => {
		const markers = deriveMeta([
			metaEvent(0, "app://main"),
			metaEvent(4_000, "app://main"),
			metaEvent(8_000, "app://settings"),
		]).actionMarkers
		expect(markers).toEqual([{ ms: 8_000, kind: "nav" }])
	})
})
