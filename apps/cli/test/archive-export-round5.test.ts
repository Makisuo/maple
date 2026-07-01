import { describe, it } from "@effect/vitest"
import { deepStrictEqual, throws } from "node:assert"
import { randomUUID } from "node:crypto"
import {
	normalizeType,
	planHourShards,
	COMPLEX_DIGEST_ALGORITHM,
	type ExportSettings,
} from "../src/server/archives/export"
import { parseArchiveGenerationManifest } from "../src/server/archives/manifest"
import { CHDB_VERSION, MAPLE_VERSION } from "../src/version"
import { SCHEMA_FINGERPRINT } from "../src/server/serve"

// Pure-logic tests for the round-5 fixes. The end-to-end adversarial coverage
// (column swap, row reassociation, byte refinement, timezone, recovery) lives
// in apps/cli/test/probes/ and the matrix in archive-adversarial-matrix.md.

const settings = (overrides: Partial<ExportSettings> = {}): ExportSettings => ({
	writerThreads: 1,
	rowGroupRows: 10_000,
	maxShardRows: 500_000,
	maxShardBytes: 256 * 1024 * 1024,
	...overrides,
})

describe("schema normalizeType (measured chDB Parquet mapping)", () => {
	it("does NOT collapse parameterized array element types", () => {
		if (normalizeType("Array(UInt64)") === normalizeType("Array(String)")) {
			throw new Error("Array(UInt64) collapsed to Array(String)")
		}
	})

	it("applies the measured LowCardinality/DateTime/DateTime64/Map transforms", () => {
		deepStrictEqual(normalizeType("LowCardinality(String)"), "String")
		deepStrictEqual(normalizeType("LowCardinality(LowCardinality(String))"), "String")
		deepStrictEqual(normalizeType("Map(LowCardinality(String), String)"), "Map(String, String)")
		deepStrictEqual(normalizeType("DateTime"), "DateTime64(3, 'UTC')")
		deepStrictEqual(normalizeType("DateTime64(9)"), "DateTime64(9, 'UTC')")
		deepStrictEqual(normalizeType("Array(DateTime64(9))"), "Array(DateTime64(9, 'UTC'))")
		deepStrictEqual(
			normalizeType("Array(Map(LowCardinality(String), String))"),
			"Array(Map(String, String))",
		)
		deepStrictEqual(normalizeType("Nullable(Float64)"), "Nullable(Float64)")
	})

	it("leaves simple leaf types untouched", () => {
		for (const t of ["String", "UInt8", "UInt64", "Int32", "Float64", "Bool"]) {
			deepStrictEqual(normalizeType(t), t)
		}
	})

	it("makes source vs Parquet normalized forms equal for every measured round-trip", () => {
		const pairs: ReadonlyArray<[string, string]> = [
			["LowCardinality(String)", "String"],
			["DateTime", "DateTime64(3, 'UTC')"],
			["DateTime64(9)", "DateTime64(9, 'UTC')"],
			["Map(LowCardinality(String), String)", "Map(String, String)"],
			["Array(UInt64)", "Array(UInt64)"],
			["Array(String)", "Array(String)"],
		]
		for (const [src, par] of pairs) {
			if (normalizeType(src) !== normalizeType(par)) {
				throw new Error(`normalized source ${src} must equal normalized parquet ${par}`)
			}
		}
	})
})

describe("planHourShards — per-part physical offset ranges (no ORDER BY)", () => {
	it("splits a part's offset domain into maxShardRows-width half-open ranges", () => {
		// One part, offset domain [0, 1199], maxShardRows 500 -> 3 ranges.
		const parts = [{ part: "p1", offsetMin: 0, offsetMax: 1199, matchingRows: 1200 }]
		const plans = planHourShards(12, parts, settings({ maxShardRows: 500 }))
		deepStrictEqual(plans.length, 3)
		// Half-open ranges covering [0, 1200): [0,500),[500,1000),[1000,1200)
		deepStrictEqual(
			plans.map((p) => [p.range.offsetLo, p.range.offsetHiExclusive]),
			[
				[0, 500],
				[500, 1000],
				[1000, 1200],
			],
		)
		deepStrictEqual(
			plans.map((p) => p.range.part),
			["p1", "p1", "p1"],
		)
		// Each range's physical width <= maxShardRows.
		for (const p of plans) {
			if (p.range.offsetHiExclusive - p.range.offsetLo > 500) {
				throw new Error(`range exceeds maxShardRows: ${JSON.stringify(p.range)}`)
			}
		}
	})

	it("produces one range when the part fits in one shard", () => {
		const parts = [{ part: "p1", offsetMin: 0, offsetMax: 99, matchingRows: 100 }]
		const plans = planHourShards(12, parts, settings())
		deepStrictEqual(plans.length, 1)
		deepStrictEqual([plans[0]!.range.offsetLo, plans[0]!.range.offsetHiExclusive], [0, 100])
	})

	it("handles multiple parts, paging each independently", () => {
		const parts = [
			{ part: "a", offsetMin: 0, offsetMax: 999, matchingRows: 1000 },
			{ part: "b", offsetMin: 0, offsetMax: 499, matchingRows: 500 },
		]
		const plans = planHourShards(12, parts, settings({ maxShardRows: 500 }))
		// part a -> [0,500),[500,1000); part b -> [0,500)
		deepStrictEqual(
			plans.map((p) => [p.range.part, p.range.offsetLo, p.range.offsetHiExclusive]),
			[
				["a", 0, 500],
				["a", 500, 1000],
				["b", 0, 500],
			],
		)
	})
})

// Build a minimal valid v2 manifest with one shard, for the time-evidence tests.
const nano = (iso: string): string => `${BigInt(Date.parse(iso)) * 1_000_000n}`
const manifestWith = (
	overrides: Record<string, unknown>,
	shardOverrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
	formatVersion: 3,
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
	tuningConfig: null,
	shards: [
		{
			name: "12-0000.parquet",
			rowCount: 1,
			minEventTimeUnixNano: nano("2026-06-29T12:00:00.000Z"),
			maxEventTimeUnixNano: nano("2026-06-29T12:30:00.000Z"),
			sha256: "a".repeat(64),
			bytes: 4096,
			columns: ["Timestamp"],
			complexDigest: "123456789",
			complexDigestAlgorithm: COMPLEX_DIGEST_ALGORITHM,
			...shardOverrides,
		},
	],
	...overrides,
})

describe("shard time evidence — UTC nanoseconds, host-timezone-independent (round 5)", () => {
	it("accepts a valid in-range shard bound", () => {
		parseArchiveGenerationManifest(manifestWith({}), "traces", "2026-06-29") // must not throw
	})

	it("accepts a valid 23:30 UTC late-day bound (the round-4 timezone defect)", () => {
		// Under any host timezone this must parse, because bounds are epoch nanos.
		parseArchiveGenerationManifest(
			manifestWith(
				{},
				{
					minEventTimeUnixNano: nano("2026-06-29T23:30:00.000Z"),
					maxEventTimeUnixNano: nano("2026-06-29T23:30:00.000Z"),
				},
			),
			"traces",
			"2026-06-29",
		)
	})

	it("rejects an out-of-range (2027) shard bound", () => {
		throws(
			() =>
				parseArchiveGenerationManifest(
					manifestWith(
						{},
						{
							minEventTimeUnixNano: nano("2027-01-01T00:00:00.000Z"),
							maxEventTimeUnixNano: nano("2027-01-01T00:00:00.000Z"),
						},
					),
					"traces",
					"2026-06-29",
				),
			/outside sealed range/,
		)
	})

	it("rejects a shard reaching the exclusive range end (next midnight)", () => {
		throws(
			() =>
				parseArchiveGenerationManifest(
					manifestWith({}, { maxEventTimeUnixNano: nano("2026-06-30T00:00:00.000Z") }),
					"traces",
					"2026-06-29",
				),
			/outside sealed range/,
		)
	})

	it("rejects a missing complexDigestAlgorithm (round 5 manifest field)", () => {
		const m = manifestWith({})
		delete (m.shards as Array<Record<string, unknown>>)[0]!.complexDigestAlgorithm
		throws(() => parseArchiveGenerationManifest(m, "traces", "2026-06-29"), /complexDigestAlgorithm/)
	})

	it("rejects an unknown complexDigestAlgorithm fail-closed (round 5)", () => {
		// v2 made digest semantics versioned; an unknown algorithm must not be
		// silently re-interpreted (a v1 digest, a future v3, or a bogus string).
		throws(
			() =>
				parseArchiveGenerationManifest(
					manifestWith({}, { complexDigestAlgorithm: "bogus-digest" }),
					"traces",
					"2026-06-29",
				),
			/invalid archive shard complexDigestAlgorithm: bogus-digest/,
		)
	})

	it("rejects a v1 manifest fail-closed (round 5 version bump)", () => {
		throws(
			() =>
				parseArchiveGenerationManifest(
					{ ...manifestWith({}), formatVersion: 1 },
					"traces",
					"2026-06-29",
				),
			/unsupported archive manifest formatVersion 1/,
		)
	})
})
