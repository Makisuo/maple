// RED-BASELINE probe (round 5): a valid late-UTC shard bound (23:30 UTC) must be
// accepted regardless of host timezone. Round 4 persists timezone-less chDB
// strings and parses them with Date.parse, which is host-timezone-dependent; a
// valid 23:30 UTC bound is rejected as next-day under America/New_York.
// Contract: exit 0 (PASS) when the manifest parser ACCEPTS the valid 23:30 UTC
// bound; exit nonzero (FAIL) when it rejects it.
//
// This probe parses a manifest shard record directly (no chDB needed) under
// TZ=America/New_York to reproduce the host-timezone dependence deterministically.
//
// Run: TZ=America/New_York MAPLE_LIBCHDB=<bundle>/libchdb.so bun apps/cli/test/probes/archive-probe-timezone-bound.ts

import { ArchiveProbe } from "../archive-probe-helpers"
import { parseArchiveGenerationManifest } from "../../src/server/archives/manifest"
import { randomUUID } from "node:crypto"
import { CHDB_VERSION, MAPLE_VERSION } from "../../src/version"
import { SCHEMA_FINGERPRINT } from "../../src/server/serve"

const h = ArchiveProbe.create("timezone-bound")

// Force the host timezone to a non-UTC zone so any host-tz-dependent parse is
// exposed. The probe runner sets TZ; assert it here too.
if (process.env.TZ !== "America/New_York") {
	process.env.TZ = "America/New_York"
}

const manifest = {
	formatVersion: 3,
	generationId: randomUUID(),
	signal: "traces",
	rangeStart: "2026-06-29",
	// 23:30 UTC is a VALID bound within the 2026-06-29 sealed range.
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
			name: "23-0000.parquet",
			rowCount: 1,
			// 2026-06-29 23:30:00 UTC as epoch nanoseconds. Computed from the UTC
			// instant, so parsing it is host-timezone-independent by construction.
			minEventTimeUnixNano: `${BigInt(Date.parse("2026-06-29T23:30:00.000Z")) * 1_000_000n}`,
			maxEventTimeUnixNano: `${BigInt(Date.parse("2026-06-29T23:30:00.000Z")) * 1_000_000n}`,
			sha256: "a".repeat(64),
			bytes: 4096,
			columns: ["Timestamp"],
			complexDigest: "123456789",
			complexDigestAlgorithm: "cityhash64-multiset-v3",
		},
	],
}

try {
	parseArchiveGenerationManifest(manifest, "traces", "2026-06-29")
	h.ok("valid 23:30 UTC bound accepted under America/New_York")
} catch (e) {
	const msg = e instanceof Error ? e.message : String(e)
	if (/outside sealed range/i.test(msg)) {
		h.fail(
			`VALID_UTC_2330_REJECTED under ${process.env.TZ}: ${msg.slice(0, 160)} (host-timezone-dependent parse)`,
		)
	}
	h.fail(msg)
}
