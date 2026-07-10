import { assert, describe, it } from "@effect/vitest"
import {
	enqueueLogEntry,
	MAX_BUFFERED_ENTRIES,
	reconnectDelayMs,
	type LogStreamState,
} from "./LogStream"
import type { RailwayLogEntry } from "./otlp/logs"

const entry = (timestampMs: number, message = "line"): RailwayLogEntry => ({
	timestampMs,
	message,
	severity: null,
	serviceId: null,
	deploymentId: null,
	attributes: [],
})

describe("enqueueLogEntry", () => {
	it("drops entries at or below the watermark (reconnect replay overlap)", () => {
		const state: LogStreamState = { buffer: [], droppedSinceLastReport: 0, watermarkMs: 5_000 }
		enqueueLogEntry(state, entry(4_000))
		enqueueLogEntry(state, entry(5_000))
		enqueueLogEntry(state, entry(6_000))
		assert.strictEqual(state.buffer.length, 1)
		assert.strictEqual(state.buffer[0]!.timestampMs, 6_000)
	})

	it("accepts everything when no watermark is set", () => {
		const state: LogStreamState = { buffer: [], droppedSinceLastReport: 0, watermarkMs: null }
		enqueueLogEntry(state, entry(1))
		enqueueLogEntry(state, entry(2))
		assert.strictEqual(state.buffer.length, 2)
	})

	it("evicts the oldest entry on overflow and counts the drop", () => {
		const state: LogStreamState = {
			buffer: Array.from({ length: MAX_BUFFERED_ENTRIES }, (_, index) => entry(index)),
			droppedSinceLastReport: 0,
			watermarkMs: null,
		}
		enqueueLogEntry(state, entry(MAX_BUFFERED_ENTRIES + 1, "newest"))
		assert.strictEqual(state.buffer.length, MAX_BUFFERED_ENTRIES)
		assert.strictEqual(state.droppedSinceLastReport, 1)
		assert.strictEqual(state.buffer.at(-1)!.message, "newest")
		assert.strictEqual(state.buffer[0]!.timestampMs, 1)
	})
})

describe("reconnectDelayMs", () => {
	it("escalates exponentially and caps at five minutes", () => {
		assert.strictEqual(reconnectDelayMs(1), 2_000)
		assert.strictEqual(reconnectDelayMs(3), 8_000)
		assert.strictEqual(reconnectDelayMs(20), 300_000)
	})
})
