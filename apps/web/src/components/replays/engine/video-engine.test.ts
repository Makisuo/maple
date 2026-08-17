import { describe, expect, it } from "vitest"
import {
	extractVideoSegments,
	resolveSegment,
	segmentsTotalMs,
	videoSegmentPayload,
	type VideoSegment,
} from "./video-engine"

// A mobile recording is a sequence of independent MP4s, each opening on an IDR
// keyframe. The segment math below is what turns a playhead offset into
// (which file, how far into it) — the whole reason seeking is exact here.
//
// The DOM side (<video>, Blob URLs) is deliberately not tested: jsdom implements
// neither URL.createObjectURL nor HTMLMediaElement.play/pause, so a test of it
// would only exercise its own stubs.

const T0 = 1_700_000_000_000

/** An rrweb-shaped custom event carrying one H.264 segment, as the iOS SDK emits. */
const videoEvent = (offsetMs: number, durationMs: number, overrides: Record<string, unknown> = {}) => ({
	type: 5,
	timestamp: T0 + offsetMs,
	data: {
		tag: "video",
		payload: {
			segmentId: `seg-${offsetMs}`,
			size: 12_800,
			duration: durationMs,
			encoding: "h264",
			container: "mp4",
			width: 390,
			height: 844,
			frameCount: 60,
			frameRateType: "constant",
			frameRate: 2,
			left: 0,
			top: 0,
			base64: "AAAAIGZ0eXA=",
			...overrides,
		},
	},
})

const metaEvent = (offsetMs: number) => ({
	type: 4,
	timestamp: T0 + offsetMs,
	data: { href: "app://main", width: 390, height: 844 },
})

const touchEvent = (offsetMs: number) => ({
	type: 3,
	timestamp: T0 + offsetMs,
	data: { source: 2, type: 7, pointerType: 2 },
})

describe("videoSegmentPayload", () => {
	it("recognises the SDK's video custom event", () => {
		expect(videoSegmentPayload(videoEvent(0, 30_000))).toMatchObject({ encoding: "h264" })
	})

	it("rejects everything that is not one", () => {
		// Type 5 but a different tag, right type/tag but wrong event type, and the
		// ordinary rrweb events a browser session is made of.
		expect(videoSegmentPayload({ type: 5, timestamp: T0, data: { tag: "breadcrumb" } })).toBeUndefined()
		expect(videoSegmentPayload(metaEvent(0))).toBeUndefined()
		expect(videoSegmentPayload(touchEvent(0))).toBeUndefined()
		expect(videoSegmentPayload(null)).toBeUndefined()
		expect(videoSegmentPayload(undefined)).toBeUndefined()
	})
})

describe("extractVideoSegments", () => {
	it("positions segments against the stream's first event, not the epoch", () => {
		// The meta event opens the chunk, so time-zero is it — the first video
		// segment lands 5ms later, not 1.7 trillion ms later.
		const events = [metaEvent(0), videoEvent(5, 30_000), touchEvent(1_200), videoEvent(30_005, 30_000)]
		const segments = extractVideoSegments(events, T0)
		expect(segments).toHaveLength(2)
		expect(segments[0]).toMatchObject({ startMs: 5, durationMs: 30_000, width: 390, height: 844 })
		expect(segments[1]).toMatchObject({ startMs: 30_005, durationMs: 30_000 })
	})

	it("orders segments by start time regardless of arrival order", () => {
		const segments = extractVideoSegments([videoEvent(60_000, 30_000), videoEvent(0, 30_000)], T0)
		expect(segments.map((s) => s.startMs)).toEqual([0, 60_000])
	})

	it("skips unusable segments rather than failing the recording", () => {
		// A chunk missing its payload must not take the surrounding footage down
		// with it — same posture as `decodeRange` skipping a malformed chunk.
		const events = [
			videoEvent(0, 30_000),
			videoEvent(30_000, 30_000, { base64: "" }),
			{ type: 5, timestamp: T0 + 60_000, data: { tag: "video" } },
			videoEvent(90_000, 30_000),
		]
		expect(extractVideoSegments(events, T0).map((s) => s.startMs)).toEqual([0, 90_000])
	})

	it("returns nothing for a browser recording", () => {
		expect(extractVideoSegments([metaEvent(0), touchEvent(10)], T0)).toEqual([])
	})
})

describe("segmentsTotalMs", () => {
	it("measures to the end of the last segment, not its start", () => {
		expect(segmentsTotalMs(extractVideoSegments([videoEvent(0, 30_000)], T0))).toBe(30_000)
	})

	it("is zero for an empty recording", () => {
		expect(segmentsTotalMs([])).toBe(0)
	})
})

describe("resolveSegment", () => {
	// Two 30s segments with a 10s hole between them — the recorder stopped while
	// the app was backgrounded.
	const segments: ReadonlyArray<VideoSegment> = extractVideoSegments(
		[videoEvent(0, 30_000), videoEvent(40_000, 30_000)],
		T0,
	)

	it("maps an offset inside a segment to that segment's own clock", () => {
		expect(resolveSegment(segments, 0)).toEqual({ index: 0, offsetSec: 0 })
		expect(resolveSegment(segments, 12_500)).toEqual({ index: 0, offsetSec: 12.5 })
		// Second segment starts at 40s, so 45s is 5s into its own media clock —
		// not 45s, which is what a naive global-timeline seek would use.
		expect(resolveSegment(segments, 45_000)).toEqual({ index: 1, offsetSec: 5 })
	})

	it("snaps a seek landing in a gap forward to the next segment", () => {
		// 35s is dead air. Stalling there would look like frozen playback, so the
		// playhead moves to the start of the next real footage.
		expect(resolveSegment(segments, 35_000)).toEqual({ index: 1, offsetSec: 0 })
	})

	it("treats a segment boundary as the start of the next segment", () => {
		expect(resolveSegment(segments, 30_000)).toEqual({ index: 1, offsetSec: 0 })
	})

	it("holds at the tail of the last segment past the end", () => {
		// Reporting the end (rather than wrapping to 0) is what lets the engine
		// fire `onFinish` instead of silently restarting the recording.
		expect(resolveSegment(segments, 999_999)).toEqual({ index: 1, offsetSec: 30 })
	})

	it("clamps a negative offset to the first segment", () => {
		expect(resolveSegment(segments, -5_000)).toEqual({ index: 0, offsetSec: 0 })
	})

	it("has nothing to resolve on an empty recording", () => {
		expect(resolveSegment([], 1_000)).toBeUndefined()
	})
})
