// Golden decode tests for the on-disk store marker.
//
// Both fixtures are literal copies of markers shipped builds have written. A
// marker that stops decoding is a store that stops opening, so the accepted
// form is pinned here rather than left implicit in the schema.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { makeStoreMarker, readMarkerState, storeMarkerPath } from "../src/server/store-version"
import { CHDB_VERSION } from "../src/version"

const goldenV1 = {
	chdb: "1.4.0",
	maple: "0.1.7",
	createdAt: "2026-01-14T09:30:00.000Z",
	schema: "428701854f9fd30e",
}

const goldenV2 = {
	formatVersion: 2,
	storeId: "8b7d9f1e-0000-4000-8000-000000000001",
	chdb: "3.6.0",
	maple: "0.4.2",
	createdAt: "2026-08-19T10:15:00.000Z",
	createdByMaple: "0.3.9",
	schemaVersion: 8,
	schemaDigest: "a".repeat(64),
	schema: "51081e951066442a",
	activation: "active",
	lastMigration: {
		id: "local-0007-to-0008-apple-crash-frames",
		completedAt: "2026-08-19T10:20:00.000Z",
		fromVersion: 7,
		toVersion: 8,
	},
}

const readAs = (value: unknown) => {
	const root = mkdtempSync(join(tmpdir(), "maple-marker-"))
	const dataDir = join(root, "data")
	mkdirSync(dataDir, { recursive: true })
	writeFileSync(storeMarkerPath(dataDir), JSON.stringify(value))
	return readMarkerState(dataDir)
}

describe("store marker", () => {
	it("accepts a v1 marker written before the format was versioned", () => {
		const state = readAs(goldenV1)
		expect(state).toEqual({ kind: "valid", marker: { formatVersion: 1, ...goldenV1 } })
	})

	it("accepts a v2 marker written by a shipped build, unchanged", () => {
		const state = readAs(goldenV2)
		expect(state.kind === "valid" && state.marker).toEqual(goldenV2)
	})

	it("degrades unusable provenance rather than refusing to open the store", () => {
		// Who made the store is not something the loader acts on. Identity is.
		const state = readAs({ ...goldenV2, maple: 42, createdAt: null })
		expect(state.kind === "valid" && state.marker.maple).toBe("unknown")
		expect(state.kind === "valid" && state.marker.createdAt).toBe("unknown")
	})

	it("falls back to the recorded maple version when no creator was stamped", () => {
		const { createdByMaple: _dropped, ...withoutCreator } = goldenV2
		const state = readAs(withoutCreator)
		expect(state.kind === "valid" && state.marker.createdByMaple).toBe(goldenV2.maple)
	})

	it("reports a malformed identity instead of guessing at it", () => {
		for (const patch of [
			{ schema: "not-hex" },
			{ schema: "51081e951066442" },
			{ schemaDigest: "a".repeat(63) },
			{ schemaVersion: -1 },
			{ schemaVersion: 1.5 },
			{ storeId: "" },
			{ activation: "somewhere-else" },
			{ chdb: "" },
			{ lastMigration: { id: "x", completedAt: "nope", fromVersion: 7, toVersion: 8 } },
		]) {
			expect(readAs({ ...goldenV2, ...patch }).kind).toBe("malformed")
		}
		expect(readAs({ ...goldenV2, formatVersion: 3 }).kind).toBe("malformed")
		expect(readAs({ maple: "0.1.0" }).kind).toBe("malformed")
		expect(readAs([]).kind).toBe("malformed")
	})

	it("constructs a marker through the same rules it reads one with", () => {
		const marker = makeStoreMarker("0.4.2", "2026-08-19T10:15:00.000Z", "51081e951066442a", {
			storeId: goldenV2.storeId,
			schemaVersion: 8,
			schemaDigest: "a".repeat(64),
		})
		expect(marker).toEqual({
			formatVersion: 2,
			storeId: goldenV2.storeId,
			chdb: CHDB_VERSION,
			maple: "0.4.2",
			createdAt: "2026-08-19T10:15:00.000Z",
			createdByMaple: "0.4.2",
			schemaVersion: 8,
			schemaDigest: "a".repeat(64),
			schema: "51081e951066442a",
			activation: "active",
		})
		expect(readAs(marker).kind).toBe("valid")
	})

	it("refuses to construct a marker without a full identity", () => {
		const now = "2026-08-19T10:15:00.000Z"
		expect(() =>
			makeStoreMarker("0.4.2", now, "not-hex", { schemaVersion: 8, schemaDigest: "a".repeat(64) }),
		).toThrow()
		expect(() => makeStoreMarker("0.4.2", now, "51081e951066442a", { schemaVersion: 8 })).toThrow()
		expect(() =>
			makeStoreMarker("0.4.2", now, "51081e951066442a", { schemaDigest: "a".repeat(64) }),
		).toThrow(/schemaVersion/)
	})
})
