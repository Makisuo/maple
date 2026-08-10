import { describe, expect, it } from "vitest"

import {
	batchDetectorStates,
	DETECTOR_STATE_UPSERT_CHUNK,
	effectiveOtherStates,
} from "./detector-state-batch"

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

describe("effectiveOtherStates", () => {
	const persistedRow = (detectorKey: string) => ({
		detectorKey,
		fingerprintHash: `fp_${detectorKey}`,
		lastSampleCount: 10,
	})

	it("counts a sibling that has not changed this tick", () => {
		const others = effectiveOtherStates({
			persisted: [persistedRow("b")],
			pending: [],
			currentDetectorKey: "a",
			incidentId: "inc_1",
		})
		expect(others.map((r) => r.detectorKey)).toEqual(["b"])
	})

	it("drops a sibling whose buffered write already released the incident", () => {
		// The regression: under the old per-row writes, b's `openIncidentId = null`
		// was already persisted by the time a resolved. With the flush deferred, the
		// database still lists b, so without this overlay a would see a live sibling
		// that has in fact recovered.
		const others = effectiveOtherStates({
			persisted: [persistedRow("b")],
			pending: [{ detectorKey: "b", openIncidentId: null }],
			currentDetectorKey: "a",
			incidentId: "inc_1",
		})
		expect(others).toEqual([])
	})

	it("lets both siblings of a consolidated incident resolve in one tick", () => {
		// a resolves first and buffers its release; b must then see a refcount of
		// zero and close the incident, rather than promoting a recovered series.
		const pending: Array<{ detectorKey: string; openIncidentId: string | null }> = []

		const forA = effectiveOtherStates({
			persisted: [persistedRow("b")],
			pending,
			currentDetectorKey: "a",
			incidentId: "inc_1",
		})
		expect(forA.map((r) => r.detectorKey)).toEqual(["b"])
		pending.push({ detectorKey: "a", openIncidentId: null })

		const forB = effectiveOtherStates({
			persisted: [persistedRow("a")],
			pending,
			currentDetectorKey: "b",
			incidentId: "inc_1",
		})
		expect(forB).toEqual([])
	})

	it("counts a sibling that only attached during this tick", () => {
		// Not in the database yet, so the raw query would miss it and the incident
		// would resolve out from under a series that just joined it.
		const others = effectiveOtherStates({
			persisted: [],
			pending: [
				{ detectorKey: "b", openIncidentId: "inc_1", fingerprintHash: "fp_b", lastSampleCount: 7 },
			],
			currentDetectorKey: "a",
			incidentId: "inc_1",
		})
		expect(others).toEqual([{ detectorKey: "b", fingerprintHash: "fp_b", lastSampleCount: 7 }])
	})

	it("ignores buffered writes pointing at a different incident", () => {
		const others = effectiveOtherStates({
			persisted: [],
			pending: [{ detectorKey: "b", openIncidentId: "inc_2" }],
			currentDetectorKey: "a",
			incidentId: "inc_1",
		})
		expect(others).toEqual([])
	})

	it("never counts the resolving detector itself", () => {
		const others = effectiveOtherStates({
			persisted: [persistedRow("a")],
			pending: [{ detectorKey: "a", openIncidentId: "inc_1" }],
			currentDetectorKey: "a",
			incidentId: "inc_1",
		})
		expect(others).toEqual([])
	})
})
