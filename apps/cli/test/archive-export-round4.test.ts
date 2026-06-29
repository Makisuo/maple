import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual, throws } from "node:assert"
import { randomUUID } from "node:crypto"
import { normalizeType, planHourShards, type ExportSettings } from "../src/server/archives/export"
import { parseArchiveGenerationManifest } from "../src/server/archives/manifest"
import { CHDB_VERSION, MAPLE_VERSION } from "../src/version"
import { SCHEMA_FINGERPRINT } from "../src/server/serve"

// Pure-logic tests for the round-4 fixes, grounded in measured chDB behavior
// (see gate2-round4-probes.md). These pin the adversarial invariants the
// round-3 review found: parameterized-type collapse, byte-agnostic planning,
// and unsealed shard timestamps. The native end-to-end coverage lives in the
// adversarial probe scripts.

const settings = (overrides: Partial<ExportSettings> = {}): ExportSettings => ({
	writerThreads: 1,
	rowGroupRows: 10_000,
	maxShardRows: 500_000,
	maxShardBytes: 256 * 1024 * 1024,
	...overrides,
})

describe("schema normalizeType (blocker #4, measured chDB Parquet mapping)", () => {
	it("does NOT collapse parameterized array element types (Array(UInt64) != Array(String))", () => {
		// The round-3 reviewer's exact attack: source Array(UInt64) vs injected
		// Array(String). The normalized forms must differ.
		strictNotEqual(normalizeType("Array(UInt64)"), normalizeType("Array(String)"))
		strictEqual(normalizeType("Array(UInt64)"), "Array(UInt64)")
		strictEqual(normalizeType("Array(String)"), "Array(String)")
	})

	it("unwraps LowCardinality to its inner type", () => {
		strictEqual(normalizeType("LowCardinality(String)"), "String")
		strictEqual(normalizeType("LowCardinality(LowCardinality(String))"), "String")
		// The measured Map(LowCardinality(String), String) -> Map(String, String).
		strictEqual(normalizeType("Map(LowCardinality(String), String)"), "Map(String, String)")
	})

	it("maps DateTime and DateTime64 to their Parquet round-trip forms", () => {
		// Measured: DateTime -> DateTime64(3, 'UTC'); DateTime64(9) -> DateTime64(9, 'UTC').
		strictEqual(normalizeType("DateTime"), "DateTime64(3, 'UTC')")
		strictEqual(normalizeType("DateTime64(9)"), "DateTime64(9, 'UTC')")
		strictEqual(normalizeType("DateTime64(3)"), "DateTime64(3, 'UTC')")
		// A DateTime already widened by Parquet stays stable under normalization.
		strictEqual(normalizeType("DateTime64(9, 'UTC')"), "DateTime64(9, 'UTC')")
	})

	it("recurses through Array, Map, Nullable, and nested combinations", () => {
		// Array(DateTime64(9)) -> Array(DateTime64(9, 'UTC'))  (measured)
		strictEqual(normalizeType("Array(DateTime64(9))"), "Array(DateTime64(9, 'UTC'))")
		// Array(Map(LowCardinality(String), String)) -> Array(Map(String, String))  (measured)
		strictEqual(normalizeType("Array(Map(LowCardinality(String), String))"), "Array(Map(String, String))")
		// Nullable(Float64) -> Nullable(Float64)  (unchanged, measured)
		strictEqual(normalizeType("Nullable(Float64)"), "Nullable(Float64)")
		// Array(LowCardinality(String)) -> Array(String)  (measured)
		strictEqual(normalizeType("Array(LowCardinality(String))"), "Array(String)")
	})

	it("leaves simple leaf types untouched", () => {
		for (const t of ["String", "UInt8", "UInt16", "UInt32", "UInt64", "Int32", "Float64", "Bool"]) {
			strictEqual(normalizeType(t), t)
		}
	})

	it("makes source vs Parquet normalized forms equal for every measured round-trip type", () => {
		// For each (source, parquet) pair measured in probe 1, the normalized forms
		// must be equal — otherwise a valid export would fail validation.
		const pairs: ReadonlyArray<[string, string]> = [
			["LowCardinality(String)", "String"],
			["DateTime", "DateTime64(3, 'UTC')"],
			["DateTime64(9)", "DateTime64(9, 'UTC')"],
			["Map(LowCardinality(String), String)", "Map(String, String)"],
			["Array(DateTime64(9))", "Array(DateTime64(9, 'UTC'))"],
			["Array(LowCardinality(String))", "Array(String)"],
			["Array(Map(LowCardinality(String), String))", "Array(Map(String, String))"],
			["Array(String)", "Array(String)"],
			["Array(UInt64)", "Array(UInt64)"],
			["Nullable(Float64)", "Nullable(Float64)"],
			["String", "String"],
		]
		for (const [src, par] of pairs) {
			strictEqual(
				normalizeType(src),
				normalizeType(par),
				`normalized source ${src} must equal normalized parquet ${par}`,
			)
		}
	})
})

describe("planHourShards byte-aware planning (blocker #5)", () => {
	it("produces a single shard when the hour is well under both bounds", () => {
		const plans = planHourShards(12, 1000, 100, settings())
		strictEqual(plans.length, 1)
		strictEqual(plans[0]!.limit, 1000)
		strictEqual(plans[0]!.offset, 0)
		strictEqual(plans[0]!.expectedRows, 1000)
	})

	it("splits by rows when only the row limit binds", () => {
		// 1200 rows, maxShardRows 500 -> 3 shards (500, 500, 200) distributed evenly.
		const plans = planHourShards(12, 1200, 0, settings({ maxShardRows: 500 }))
		strictEqual(plans.length, 3)
		deepStrictEqual(
			plans.map((p) => p.limit),
			[400, 400, 400],
		)
		// offsets are contiguous and cover the hour.
		deepStrictEqual(
			plans.map((p) => p.offset),
			[0, 400, 800],
		)
		strictEqual(
			plans.reduce((s, p) => s + p.expectedRows, 0),
			1200,
		)
	})

	it("splits by bytes even when under the row limit (the reviewer's wide-row case)", () => {
		// 1000 rows but each ~1 MiB uncompressed, maxShardBytes 256 MiB.
		// 256 MiB / 1 MiB = 256 rows per shard -> 4 shards of 250.
		const oneMiB = 1024 * 1024
		const plans = planHourShards(
			12,
			1000,
			oneMiB,
			settings({ maxShardRows: 500_000, maxShardBytes: 256 * oneMiB }),
		)
		strictEqual(plans.length, 4, "should split by bytes, not stay at one row-limited shard")
		deepStrictEqual(
			plans.map((p) => p.limit),
			[250, 250, 250, 250],
		)
		strictEqual(
			plans.reduce((s, p) => s + p.expectedRows, 0),
			1000,
		)
	})

	it("never produces zero-row shards", () => {
		const plans = planHourShards(12, 7, 0, settings({ maxShardRows: 3 }))
		for (const p of plans) {
			if (p.limit <= 0) throw new Error(`zero-row shard: ${JSON.stringify(p)}`)
		}
		strictEqual(
			plans.reduce((s, p) => s + p.expectedRows, 0),
			7,
		)
	})
})

// Build a minimal valid manifest with one shard, for the range-bound tests.
const manifestWith = (
	overrides: Record<string, unknown>,
	shardOverrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
	formatVersion: 1,
	generationId: randomUUID(),
	signal: "traces",
	rangeStart: "2026-06-29",
	rangeEndExclusive: "2026-06-30T00:00:00.000Z",
	checkpointId: randomUUID(),
	checkpointManifestFingerprint: "fp",
	createdAt: "2026-06-29T12:00:00.000Z",
	mapleVersion: MAPLE_VERSION,
	chdbVersion: CHDB_VERSION,
	schemaFingerprint: SCHEMA_FINGERPRINT,
	sourceRowCount: 1,
	archivedRowCount: 1,
	tuning: {
		writerThreads: 1,
		rowGroupRows: 10_000,
		maxShardRows: 500_000,
		maxShardBytes: 256 * 1024 * 1024,
		targetChunkBytes: 1024 * 1024 * 1024,
		minFreeSpaceReserve: 512 * 1024 * 1024,
	},
	tuningConfigName: null,
	shards: [
		{
			name: "12-0000.parquet",
			rowCount: 1,
			minEventTime: "2026-06-29T12:00:00.000Z",
			maxEventTime: "2026-06-29T12:30:00.000Z",
			sha256: "a".repeat(64),
			bytes: 4096,
			columns: ["Timestamp"],
			complexDigest: "123456789",
			...shardOverrides,
		},
	],
	...overrides,
})

describe("shard timestamps bound to sealed range (blocker #6)", () => {
	it("accepts shard times within the sealed range", () => {
		const parsed = parseArchiveGenerationManifest(manifestWith({}), "traces", "2026-06-29")
		strictEqual(parsed.shards[0]!.complexDigest, "123456789")
	})

	it("rejects shard times from 2027 for a 2026 sealed range (reviewer's exact scenario)", () => {
		throws(
			() =>
				parseArchiveGenerationManifest(
					manifestWith(
						{},
						{
							minEventTime: "2027-01-01T00:00:00.000Z",
							maxEventTime: "2027-01-01T00:00:00.000Z",
						},
					),
					"traces",
					"2026-06-29",
				),
			/outside sealed range/,
		)
	})

	it("rejects a shard whose max time reaches the exclusive range end", () => {
		// Half-open range: the exclusive end (next midnight) is not part of the day.
		throws(
			() =>
				parseArchiveGenerationManifest(
					manifestWith({}, { maxEventTime: "2026-06-30T00:00:00.000Z" }),
					"traces",
					"2026-06-29",
				),
			/outside sealed range/,
		)
	})

	it("rejects a shard time before the range start", () => {
		throws(
			() =>
				parseArchiveGenerationManifest(
					manifestWith(
						{},
						{
							minEventTime: "2026-06-28T23:00:00.000Z",
							maxEventTime: "2026-06-28T23:00:00.000Z",
						},
					),
					"traces",
					"2026-06-29",
				),
			/outside sealed range/,
		)
	})

	it("rejects a missing complexDigest", () => {
		const m = manifestWith({})
		delete (m.shards as Array<Record<string, unknown>>)[0]!.complexDigest
		throws(() => parseArchiveGenerationManifest(m, "traces", "2026-06-29"), /complexDigest/)
	})

	it("rejects a non-numeric complexDigest", () => {
		throws(
			() =>
				parseArchiveGenerationManifest(
					manifestWith({}, { complexDigest: "not-a-number" }),
					"traces",
					"2026-06-29",
				),
			/complexDigest/,
		)
	})
})

// node:assert has no strictNotEqual on some runtimes; provide it.
function strictNotEqual(actual: unknown, expected: unknown): void {
	if (actual === expected) {
		throw new Error(`expected ${String(actual)} to be different from ${String(expected)}`)
	}
}
