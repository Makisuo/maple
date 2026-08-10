import { describe, expect, it } from "vitest"

import { batchDetectorStates, DETECTOR_STATE_UPSERT_CHUNK } from "./detector-state-batch"

const row = (detectorKey: string, marker: number) => ({ detectorKey, marker })

describe("batchDetectorStates", () => {
	it("returns no statements for no rows", () => {
		expect(batchDetectorStates([])).toEqual([])
	})

	it("emits one chunk when under the cap", () => {
		expect(batchDetectorStates([row("a", 1), row("b", 2)])).toEqual([[row("a", 1), row("b", 2)]])
	})

	it("keeps the last write for a repeated detector key", () => {
		// Postgres rejects ON CONFLICT DO UPDATE touching a row twice in one
		// statement, so a duplicate key must collapse — and to the later value,
		// matching what the sequential per-row loop wrote.
		expect(batchDetectorStates([row("a", 1), row("b", 2), row("a", 3)])).toEqual([
			[row("a", 3), row("b", 2)],
		])
	})

	it("preserves first-seen order when deduping", () => {
		const chunks = batchDetectorStates([row("a", 1), row("b", 2), row("a", 3)])
		expect(chunks[0]?.map((r) => r.detectorKey)).toEqual(["a", "b"])
	})

	it("splits into chunks at the boundary", () => {
		const rows = Array.from({ length: 5 }, (_, i) => row(`k${i}`, i))
		expect(batchDetectorStates(rows, 2).map((chunk) => chunk.length)).toEqual([2, 2, 1])
	})

	it("does not split an exact multiple into a trailing empty chunk", () => {
		const rows = Array.from({ length: 4 }, (_, i) => row(`k${i}`, i))
		expect(batchDetectorStates(rows, 2).map((chunk) => chunk.length)).toEqual([2, 2])
	})

	it("chunks by deduped size, not input size", () => {
		// Three inputs, two distinct keys — one chunk of two, not two chunks.
		expect(batchDetectorStates([row("a", 1), row("a", 2), row("b", 3)], 2)).toEqual([
			[row("a", 2), row("b", 3)],
		])
	})

	it("keeps the default chunk under the 65535 bound-parameter cap at 17 columns", () => {
		expect(DETECTOR_STATE_UPSERT_CHUNK * 17).toBeLessThan(65535)
	})
})
