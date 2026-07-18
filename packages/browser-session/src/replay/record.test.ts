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

vi.mock("../session", () => ({
	markActivity: vi.fn(),
	nextChunkSeq: vi.fn(() => 1),
}))

interface PostedChunk {
	meta: { isCheckpoint: boolean; eventCount: number; durationMs: number }
	body: string
}
const posted: PostedChunk[] = []

vi.mock("./transport", () => ({
	// Identity "gzip" so tests can read the serialized payload directly.
	gzip: vi.fn(async (bytes: Uint8Array) => bytes),
	postSessionBlob: vi.fn(async (_config: unknown, meta: PostedChunk["meta"], bytes: Uint8Array) => {
		posted.push({ meta, body: new TextDecoder().decode(bytes) })
	}),
}))

const { startRecording } = await import("./record")

const CONFIG = {
	endpoint: "https://ingest.example",
	ingestKey: "key",
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

	it("skips unserializable events without breaking the stream", async () => {
		const recorder = startRecording(CONFIG, "session-1")
		const cyclic: Record<string, unknown> = { type: INCREMENTAL, timestamp: 1_000 }
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
})
