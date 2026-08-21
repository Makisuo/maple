// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
// BOUNDARY: Test doubles mirror intentionally untyped external callbacks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// rrweb touches the DOM at import time in a real browser; here we only need the
// emit callback and the takeFullSnapshot recovery hook.
type EmitFn = (event: unknown, isCheckout?: boolean) => void
let emitRef: EmitFn | undefined
const takeFullSnapshot = vi.fn()
const stopFn = vi.fn()

vi.mock("rrweb", () => {
	const record = (options: { emit: EmitFn }) => {
		emitRef = options.emit
		return stopFn
	}
	record.takeFullSnapshot = takeFullSnapshot
	return { record }
})

vi.mock("../session/session", () => ({
	markActivity: vi.fn(),
	nextChunkSeq: vi.fn(() => 1),
}))

interface PostedChunk {
	meta: { isCheckpoint: boolean; eventCount: number; durationMs: number }
	body: string
}
const posted: PostedChunk[] = []
// What the mocked ingest answers the next uploads with; defaults to accepted.
const outcomes: Array<"accepted" | "rejected" | "exhausted" | "failed"> = []

vi.mock("../platform/transport", () => ({
	// Identity "gzip" so tests can read the serialized payload directly.
	gzip: vi.fn(async (bytes: Uint8Array) => bytes),
	postSessionBlob: vi.fn(async (_config: unknown, meta: PostedChunk["meta"], bytes: Uint8Array) => {
		posted.push({ meta, body: new TextDecoder().decode(bytes) })
		return outcomes.shift() ?? "accepted"
	}),
}))

const { startRecording } = await import("./record")

const CONFIG = {
	endpoint: "https://ingest.example",
	ingestKey: "key",
	sdk: "maple-test/0.0.0",
	maskAllInputs: true,
	maskAllText: false,
}

const FULL_SNAPSHOT = 2
const INCREMENTAL = 3

const fullSnapshot = (timestamp: number) => ({ type: FULL_SNAPSHOT, timestamp, data: {} })
const incremental = (timestamp: number, payload = "x") => ({
	type: INCREMENTAL,
	timestamp,
	data: { source: 0, payload },
})

describe("startRecording", () => {
	beforeEach(() => {
		posted.length = 0
		outcomes.length = 0
		stopFn.mockClear()
		emitRef = undefined
		takeFullSnapshot.mockClear()
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("flushes buffered events as one JSON array without re-stringifying", async () => {
		const recorder = startRecording(CONFIG, "session-1")
		emitRef!(fullSnapshot(1_000), true)
		emitRef!(incremental(2_500))

		await recorder.flush()

		expect(posted).toHaveLength(1)
		const chunk = posted[0]!
		expect(chunk.meta.isCheckpoint).toBe(true)
		expect(chunk.meta.eventCount).toBe(2)
		expect(chunk.meta.durationMs).toBe(1_500)
		const events = JSON.parse(chunk.body) as Array<{ type: number; timestamp: number }>
		expect(events.map((e) => e.type)).toEqual([FULL_SNAPSHOT, INCREMENTAL])
		recorder.stop()
	})

	it("stops recording and uploading once ingest answers 413 for the session", async () => {
		// Ingest returns 413 for every chunk after a session's byte ceiling; a
		// recorder that kept flushing posted a rejected chunk every 5s for the
		// rest of the page's life.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const recorder = startRecording(CONFIG, "session-1")
		emitRef!(fullSnapshot(1_000), true)
		outcomes.push("exhausted")
		await recorder.flush()
		expect(posted).toHaveLength(1)
		expect(stopFn).toHaveBeenCalledTimes(1)
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("maximum recorded size"))

		// Anything still emitted (rrweb is stopped, but be defensive) and every
		// later flush — periodic or explicit — uploads nothing.
		emitRef!(incremental(2_000))
		await recorder.flush()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(posted).toHaveLength(1)
		// A later revoke must not tear rrweb down a second time.
		recorder.stop()
		expect(stopFn).toHaveBeenCalledTimes(1)
	})

	it("skips unserializable events without breaking the stream", async () => {
		const recorder = startRecording(CONFIG, "session-1")
		interface CyclicEvent extends Record<string, unknown> {
			data?: CyclicEvent
		}
		const cyclic: CyclicEvent = { type: INCREMENTAL, timestamp: 1_000 }
		cyclic.data = cyclic
		emitRef!(cyclic)
		emitRef!(fullSnapshot(2_000), true)

		await recorder.flush()

		expect(posted).toHaveLength(1)
		expect(posted[0]!.meta.eventCount).toBe(1)
		recorder.stop()
	})

	it("drops over-cap events and reopens the stream at the next full snapshot", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const recorder = startRecording(CONFIG, "session-1")

		// A single event larger than MAX_BUFFER_BYTES (4MB) — e.g. a full snapshot
		// of a huge DOM — is dropped rather than buffered.
		emitRef!({ type: FULL_SNAPSHOT, timestamp: 1_000, data: { blob: "m".repeat(5 * 1024 * 1024) } }, true)
		expect(warn).toHaveBeenCalled()

		// Incremental events after a drop are useless until a new base snapshot.
		emitRef!(incremental(6_000))
		await recorder.flush()
		expect(posted).toHaveLength(0)
		// No snapshot-recovery loop: re-snapshotting the same DOM would emit
		// another over-cap event.
		expect(takeFullSnapshot).not.toHaveBeenCalled()

		// A new (normal-sized) full snapshot re-opens the stream.
		emitRef!(fullSnapshot(7_000), true)
		emitRef!(incremental(8_000))
		await recorder.flush()
		const recovered = posted.at(-1)!
		expect(recovered.meta.isCheckpoint).toBe(true)
		expect(recovered.meta.eventCount).toBe(2)

		warn.mockRestore()
		recorder.stop()
	})

	it("uploads nothing once stopped, so a consent revoke discards the buffer", async () => {
		const recorder = startRecording(CONFIG, "session-1")
		emitRef!(fullSnapshot(1_000), true)
		emitRef!(incremental(2_000))

		// A revoke stops the recorder without flushing. Anything still buffered is
		// recorded user data that consent was just withdrawn for.
		recorder.stop()
		await recorder.flush()

		expect(posted).toEqual([])
	})

	it("cancels a scheduled idle flush on stop", async () => {
		const idleCallbacks: Array<() => void> = []
		let nextHandle = 1
		const cancelIdleCallback = vi.fn()
		vi.stubGlobal("requestIdleCallback", (cb: () => void) => {
			idleCallbacks.push(cb)
			return nextHandle++
		})
		vi.stubGlobal("cancelIdleCallback", cancelIdleCallback)

		try {
			const recorder = startRecording(CONFIG, "session-1")
			emitRef!(fullSnapshot(1_000), true)

			// The periodic timer queues an idle flush; the revoke lands before the
			// browser gets round to running it.
			await vi.advanceTimersByTimeAsync(5_000)
			expect(idleCallbacks).toHaveLength(1)

			recorder.stop()
			expect(cancelIdleCallback).toHaveBeenCalledWith(1)

			// Belt and braces: even a callback the browser ran anyway must not post.
			idleCallbacks[0]!()
			await vi.advanceTimersByTimeAsync(0)
			expect(posted).toEqual([])
		} finally {
			vi.unstubAllGlobals()
		}
	})
})
