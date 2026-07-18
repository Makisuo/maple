import { record } from "rrweb"
import { markActivity, nextChunkSeq } from "../session"
import type { ReplayEngineConfig } from "./transport"
import { gzip, postSessionBlob, type ChunkMeta } from "./transport"

// rrweb event shape — typed loosely to avoid coupling to @rrweb/types across
// alpha releases. We only read `type`, `timestamp`, and incremental `data`.
interface RrwebEvent {
	type: number
	timestamp: number
	data?: { source?: number; type?: number }
}

// rrweb enum values we rely on (stable across rrweb 1.x/2.x):
const FULL_SNAPSHOT = 2 // EventType.FullSnapshot
const INCREMENTAL = 3 // EventType.IncrementalSnapshot
const SOURCE_MOUSE_INTERACTION = 2 // IncrementalSource.MouseInteraction
const MOUSE_CLICK = 2 // MouseInteractions.Click

const FLUSH_INTERVAL_MS = 5_000
const FLUSH_BYTES = 100 * 1024
// Full DOM checkouts are synchronous rrweb work proportional to DOM size — on a
// dense dashboard a checkout is a main-thread stall, so they must stay rare.
// Playback seeks from the nearest full snapshot, so this only bounds seek cost.
const CHECKOUT_EVERY_MS = 300_000
// Hard ceiling on buffered (already-serialized) event bytes. If flushes can't
// keep up (network stall, burst), drop the batch instead of growing without
// bound — a gap in a replay beats an OOM-crashed tab.
const MAX_BUFFER_BYTES = 4 * 1024 * 1024

// Dropped-batch warnings are rate-limited like transport failures.
let lastDropWarnAt = 0
function warnBufferDropped(bytes: number): void {
	const now = Date.now()
	if (now - lastDropWarnAt < 30_000) return
	lastDropWarnAt = now
	console.warn(
		`[maple] session replay buffer exceeded ${MAX_BUFFER_BYTES} bytes (dropping ${bytes} buffered bytes; recording continues from the next full snapshot)`,
	)
}

export interface Recorder {
	stop: () => void
	flush: (keepalive?: boolean) => Promise<void>
	getClickCount: () => number
}

export function startRecording(config: ReplayEngineConfig, sessionId: string): Recorder {
	// Events are serialized once at emit time and buffered as JSON strings, so
	// flushing is a cheap `join` instead of re-stringifying the whole buffer
	// (which stalls the main thread for hundreds of ms on full snapshots).
	let parts: string[] = []
	let bufferBytes = 0
	let bufferHasCheckpoint = false
	let firstTimestamp = 0
	let lastTimestamp = 0
	let droppedChunk = false
	let clickCount = 0

	const resetBuffer = () => {
		parts = []
		bufferBytes = 0
		bufferHasCheckpoint = false
		firstTimestamp = 0
		lastTimestamp = 0
	}

	const flush = async (keepalive = false): Promise<void> => {
		if (parts.length === 0) return
		// A recording that's still emitting is activity — keep the session alive so
		// it isn't rotated out from under us mid-stream.
		markActivity()
		const body = `[${parts.join(",")}]`
		const isCheckpoint = bufferHasCheckpoint
		const eventCount = parts.length
		const durationMs = Math.max(0, lastTimestamp - firstTimestamp)
		// Monotonic across reloads (persisted on the session record), so a refresh
		// continues the sequence instead of overwriting the previous load's blobs.
		const seq = nextChunkSeq()
		resetBuffer()

		const gzipped = await gzip(new TextEncoder().encode(body))
		const meta: ChunkMeta = {
			sessionId,
			chunkSeq: seq,
			isCheckpoint,
			eventCount,
			durationMs,
		}
		await postSessionBlob(config, meta, gzipped, keepalive)
	}

	const stop = record({
		emit: (event: unknown, isCheckpoint?: boolean) => {
			const e = event as RrwebEvent
			const isFullSnapshot = isCheckpoint === true || e.type === FULL_SNAPSHOT
			if (
				e.type === INCREMENTAL &&
				e.data?.source === SOURCE_MOUSE_INTERACTION &&
				e.data.type === MOUSE_CLICK
			) {
				clickCount++
			}

			let json: string
			try {
				json = JSON.stringify(e)
			} catch {
				// Unserializable event (cycles) — playback can't use it anyway.
				return
			}

			// After a dropped batch the stream has a gap; incremental events are
			// useless until the next full snapshot re-establishes a base.
			if (droppedChunk && !isFullSnapshot) return
			droppedChunk = false

			// Flushing at FLUSH_BYTES resets the buffer synchronously, so only a
			// single pathological event (a multi-MB snapshot of a huge DOM) can trip
			// this. Deliberately NO takeFullSnapshot recovery here: re-snapshotting
			// the same DOM would emit another over-cap event and loop the stall.
			// The next periodic checkout re-establishes the base instead.
			if (bufferBytes + json.length > MAX_BUFFER_BYTES) {
				warnBufferDropped(bufferBytes + json.length)
				resetBuffer()
				droppedChunk = true
				return
			}

			if (isFullSnapshot) bufferHasCheckpoint = true
			if (parts.length === 0) firstTimestamp = e.timestamp
			lastTimestamp = e.timestamp
			parts.push(json)
			bufferBytes += json.length
			if (bufferBytes >= FLUSH_BYTES) void flush()
		},
		maskAllInputs: config.maskAllInputs,
		// rrweb has no `maskAllText` flag; selecting all elements masks every text node.
		...(config.maskAllText ? { maskTextSelector: "*" } : {}),
		checkoutEveryNms: CHECKOUT_EVERY_MS,
	})

	// The periodic flush yields to idle time so it never competes with an
	// in-progress interaction; the timeout bounds staleness. Explicit flushes
	// (pagehide/unload) bypass this and run immediately.
	const scheduleFlush = () => {
		if (typeof requestIdleCallback === "function") {
			requestIdleCallback(() => void flush(), { timeout: 2_000 })
		} else {
			void flush()
		}
	}
	const flushTimer = setInterval(scheduleFlush, FLUSH_INTERVAL_MS)

	return {
		stop: () => {
			clearInterval(flushTimer)
			stop?.()
		},
		flush,
		getClickCount: () => clickCount,
	}
}
