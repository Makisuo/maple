import type { ReplayEngine, ReplayEngineCreateInput, ReplayEngineFactory } from "./replay-engine"

// The video engine — mobile recordings.
//
// The iOS SDK captures masked screenshots, encodes them to H.264, and wraps each
// segment in rrweb-*shaped* events so the existing chunk pipeline carries them
// with no gateway or storage changes. The MP4 itself rides inside the JSON as
// base64 (gzipped, that costs 0.6-1.0x the raw MP4).
//
// So a "recording" here is a sequence of independent MP4s, each opening with an
// IDR keyframe. That is what makes seeking cheap: every segment is its own
// checkpoint, so any offset resolves to (segment, offset-within-segment) with no
// decode from an earlier point. It also means playback is a src swap at each
// boundary rather than one continuous stream.

/** One H.264 segment, positioned on the session clock. */
export interface VideoSegment {
	readonly segmentId: string
	/** Offset from session start, ms — the same clock `getCurrentTimeMs` reports. */
	readonly startMs: number
	readonly durationMs: number
	/** The MP4, base64-encoded. Decoded to a Blob URL lazily. */
	readonly base64: string
	readonly width: number
	readonly height: number
}

/** Where an offset on the session clock lands within the segment list. */
export interface SegmentPosition {
	readonly index: number
	/** Seconds into that segment's own media clock. */
	readonly offsetSec: number
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined

const numberOr = (value: unknown, fallback: number): number =>
	typeof value === "number" && Number.isFinite(value) ? value : fallback

/**
 * True for the rrweb `custom` event (type 5) that carries an H.264 segment.
 *
 * Exported because idle-band derivation needs the same test: a video event
 * *spans* its duration, and treating it as an instant makes every quiet segment
 * look like a 30s idle gap.
 */
export function videoSegmentPayload(event: unknown): Record<string, unknown> | undefined {
	const ev = asRecord(event)
	if (ev?.type !== 5) return undefined
	const data = asRecord(ev.data)
	if (data?.tag !== "video") return undefined
	return asRecord(data.payload)
}

/**
 * Pull the ordered segment list out of a raw event stream.
 *
 * `startTime` is the stream's first event timestamp — the playhead's time-zero,
 * matching `DerivedMeta.startTime`. Segments without a usable payload are
 * skipped rather than failing the whole recording, the same way `decodeRange`
 * skips a malformed chunk.
 */
export function extractVideoSegments(events: ReadonlyArray<unknown>, startTime: number): VideoSegment[] {
	const segments: VideoSegment[] = []
	for (const raw of events) {
		const payload = videoSegmentPayload(raw)
		if (!payload) continue
		const base64 = payload.base64
		if (typeof base64 !== "string" || base64.length === 0) continue
		const timestamp = numberOr(asRecord(raw)?.timestamp, Number.NaN)
		if (!Number.isFinite(timestamp)) continue
		segments.push({
			segmentId: typeof payload.segmentId === "string" ? payload.segmentId : String(segments.length),
			startMs: Math.max(0, timestamp - startTime),
			durationMs: Math.max(0, numberOr(payload.duration, 0)),
			base64,
			width: numberOr(payload.width, 0),
			height: numberOr(payload.height, 0),
		})
	}
	segments.sort((a, b) => a.startMs - b.startMs)
	return segments
}

/** End of the last segment — the recording's length on the session clock. */
export function segmentsTotalMs(segments: ReadonlyArray<VideoSegment>): number {
	let end = 0
	for (const segment of segments) end = Math.max(end, segment.startMs + segment.durationMs)
	return end
}

/**
 * Map a session-clock offset onto (segment, offset-within-segment).
 *
 * The recorder pauses when the app is backgrounded, so segments are not
 * necessarily contiguous. An offset landing in a gap snaps *forward* to the next
 * segment — the same thing the provider's skip-idle jump does, and the only
 * choice that keeps playback moving instead of stalling on dead air.
 */
export function resolveSegment(
	segments: ReadonlyArray<VideoSegment>,
	offsetMs: number,
): SegmentPosition | undefined {
	if (segments.length === 0) return undefined
	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index]!
		if (offsetMs < segment.startMs) return { index, offsetSec: 0 }
		if (offsetMs < segment.startMs + segment.durationMs) {
			return { index, offsetSec: (offsetMs - segment.startMs) / 1000 }
		}
	}
	// Past the end of the recording — hold at the tail of the last segment so the
	// engine reports "finished" rather than silently restarting.
	const index = segments.length - 1
	return { index, offsetSec: segments[index]!.durationMs / 1000 }
}

/** Decode base64 to an MP4 object URL. Mirrors the idiom in `lib/log-key.ts`. */
function toObjectUrl(base64: string): string {
	const binary = atob(base64)
	const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
	return URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }))
}

class VideoEngine implements ReplayEngine {
	private readonly video: HTMLVideoElement
	private readonly onFinish: () => void
	private readonly onResize: () => void
	private segments: VideoSegment[]
	private index = -1
	/** Object URLs by segment index. Only the current and next are kept alive. */
	private readonly urls = new Map<number, string>()
	/** True while the engine should advance across segment boundaries on its own. */
	private playing = false
	private speed = 1
	private destroyed = false
	/** Applied once the swapped-in segment reports its metadata. */
	private pendingSeekSec: number | null = null
	/** Session-clock zero, kept so late segments rebase against the same origin. */
	private readonly streamStart: number

	constructor(input: ReplayEngineCreateInput) {
		this.onFinish = input.onFinish
		this.onResize = input.onResize
		this.streamStart = streamStartMs(input.events)
		this.segments = extractVideoSegments(input.events, this.streamStart)

		const video = document.createElement("video")
		// `object-fit: contain` *is* the letterbox-and-centre that the rrweb engine
		// has to compute by hand, so `fit()` has nothing left to do.
		video.style.width = "100%"
		video.style.height = "100%"
		video.style.objectFit = "contain"
		// Screen recordings carry no audio track; muted also keeps `play()` clear of
		// autoplay policy, which would otherwise reject the promise on first press.
		video.muted = true
		video.playsInline = true
		video.preload = "auto"
		input.mount.replaceChildren(video)
		this.video = video

		video.addEventListener("loadedmetadata", this.handleLoadedMetadata)
		video.addEventListener("ended", this.handleEnded)

		// Show the opening frame immediately, the way rrweb paints its first
		// snapshot on construction rather than waiting for play.
		if (this.segments.length > 0) this.select(0, 0)
	}

	private handleLoadedMetadata = (): void => {
		this.onResize()
		if (this.pendingSeekSec !== null) {
			this.video.currentTime = this.pendingSeekSec
			this.pendingSeekSec = null
		}
		if (this.playing) void this.video.play().catch(() => {})
	}

	private handleEnded = (): void => {
		if (!this.playing) return
		const next = this.index + 1
		if (next >= this.segments.length) {
			this.playing = false
			this.onFinish()
			return
		}
		this.select(next, 0)
	}

	/** Point the element at `index`, seeking to `offsetSec` once it is loadable. */
	private select(index: number, offsetSec: number): void {
		if (this.destroyed) return
		const segment = this.segments[index]
		if (!segment) return
		if (index === this.index) {
			// Same media — seek directly; no metadata round-trip needed.
			if (this.video.readyState >= 1) this.video.currentTime = offsetSec
			else this.pendingSeekSec = offsetSec
			return
		}
		this.index = index
		this.pendingSeekSec = offsetSec
		this.video.src = this.urlFor(index)
		this.video.playbackRate = this.speed
		this.retainAround(index)
		this.video.load()
	}

	private urlFor(index: number): string {
		const existing = this.urls.get(index)
		if (existing !== undefined) return existing
		const url = toObjectUrl(this.segments[index]!.base64)
		this.urls.set(index, url)
		return url
	}

	/**
	 * Hold object URLs for the current and next segment only.
	 *
	 * The base64 already sits in the loader's event array; a decoded Blob is a
	 * second copy. A 30-minute session is ~60 segments, so keeping them all alive
	 * would pin tens of MB to play two.
	 */
	private retainAround(index: number): void {
		// Warm the next segment so the boundary swap doesn't stall on a decode.
		if (index + 1 < this.segments.length) this.urlFor(index + 1)
		for (const [held, url] of this.urls) {
			if (held === index || held === index + 1) continue
			URL.revokeObjectURL(url)
			this.urls.delete(held)
		}
	}

	get totalTimeMs(): number {
		return segmentsTotalMs(this.segments)
	}

	getCurrentTimeMs(): number {
		const segment = this.segments[this.index]
		if (!segment) return 0
		const ms = segment.startMs + this.video.currentTime * 1000
		return Number.isFinite(ms) && ms > 0 ? ms : 0
	}

	play(offsetMs: number): void {
		const position = resolveSegment(this.segments, offsetMs)
		if (!position) return
		this.playing = true
		this.select(position.index, position.offsetSec)
		if (this.video.readyState >= 1 && this.pendingSeekSec === null) {
			void this.video.play().catch(() => {})
		}
	}

	pause(offsetMs?: number): void {
		this.playing = false
		this.video.pause()
		if (offsetMs === undefined) return
		const position = resolveSegment(this.segments, offsetMs)
		if (position) this.select(position.index, position.offsetSec)
	}

	setSpeed(speed: number): void {
		this.speed = speed
		this.video.playbackRate = speed
	}

	addEvent(event: unknown): void {
		const payload = videoSegmentPayload(event)
		if (!payload) return
		// Re-extract through the same path so a late segment is validated
		// identically to a seed one. `startMs` is already session-relative on the
		// existing list, so rebase the newcomer against the same zero.
		const appended = extractVideoSegments([event], this.streamStart)
		if (appended.length === 0) return
		for (const segment of appended) {
			if (this.segments.some((existing) => existing.segmentId === segment.segmentId)) continue
			this.segments.push(segment)
		}
		this.segments.sort((a, b) => a.startMs - b.startMs)
	}

	fit(): void {
		// `object-fit: contain` on a 100%/100% element already letterboxes and
		// centres against whatever box the surface gives us.
	}

	destroy(): void {
		this.destroyed = true
		this.video.removeEventListener("loadedmetadata", this.handleLoadedMetadata)
		this.video.removeEventListener("ended", this.handleEnded)
		this.video.pause()
		this.video.removeAttribute("src")
		this.video.load()
		for (const url of this.urls.values()) URL.revokeObjectURL(url)
		this.urls.clear()
		this.video.remove()
	}
}

/** First event timestamp — the playhead's time-zero, matching `deriveMeta`. */
function streamStartMs(events: ReadonlyArray<unknown>): number {
	const first = asRecord(events[0])
	return numberOr(first?.timestamp, 0)
}

export const videoEngineFactory: ReplayEngineFactory = {
	create: (input) => new VideoEngine(input),
}
