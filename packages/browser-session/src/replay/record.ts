import { record } from "rrweb"
import { markActivity, nextChunkSeq } from "../session"
import type { ReplayEngineConfig } from "./transport"
import { gzip, postSessionBlob, type ChunkMeta } from "./transport"
import { approximateSize } from "./util"

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
const CHECKOUT_EVERY_MS = 30_000

export interface Recorder {
	stop: () => void
	flush: (keepalive?: boolean) => Promise<void>
	getClickCount: () => number
}

export function startRecording(config: ReplayEngineConfig, sessionId: string): Recorder {
	let buffer: RrwebEvent[] = []
	let bufferBytes = 0
	let bufferHasCheckpoint = false
	let clickCount = 0

	const flush = async (keepalive = false): Promise<void> => {
		if (buffer.length === 0) return
		// A recording that's still emitting is activity — keep the session alive so
		// it isn't rotated out from under us mid-stream.
		markActivity()
		const events = buffer
		const isCheckpoint = bufferHasCheckpoint
		// Monotonic across reloads (persisted on the session record), so a refresh
		// continues the sequence instead of overwriting the previous load's blobs.
		const seq = nextChunkSeq()
		const first = events[0]!.timestamp
		const last = events[events.length - 1]!.timestamp
		buffer = []
		bufferBytes = 0
		bufferHasCheckpoint = false

		const json = new TextEncoder().encode(JSON.stringify(events))
		const gzipped = await gzip(json)
		const meta: ChunkMeta = {
			sessionId,
			chunkSeq: seq,
			isCheckpoint,
			eventCount: events.length,
			durationMs: Math.max(0, last - first),
		}
		await postSessionBlob(config, meta, gzipped, keepalive)
	}

	const stop = record({
		emit: (event: unknown, isCheckpoint?: boolean) => {
			const e = event as RrwebEvent
			if (isCheckpoint === true || e.type === FULL_SNAPSHOT) bufferHasCheckpoint = true
			if (
				e.type === INCREMENTAL &&
				e.data?.source === SOURCE_MOUSE_INTERACTION &&
				e.data.type === MOUSE_CLICK
			) {
				clickCount++
			}
			buffer.push(e)
			bufferBytes += approximateSize(e)
			if (bufferBytes >= FLUSH_BYTES) void flush()
		},
		maskAllInputs: config.maskAllInputs,
		// rrweb has no `maskAllText` flag; selecting all elements masks every text node.
		...(config.maskAllText ? { maskTextSelector: "*" } : {}),
		checkoutEveryNms: CHECKOUT_EVERY_MS,
	})

	const flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS)

	return {
		stop: () => {
			clearInterval(flushTimer)
			stop?.()
		},
		flush,
		getClickCount: () => clickCount,
	}
}
