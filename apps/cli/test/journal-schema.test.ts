// Golden decode tests for the coordinator journal envelope.
//
// The fixture below is a literal copy of what a shipped build writes to
// `maple-store-migration.json`. Its purpose is to fail loudly if the schema
// ever stops accepting a journal an installed store already holds — the
// declaration is only safe because this pins the accepted form.
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
	decodeMigrationJournal,
	MigrationJournalSchema,
} from "../src/server/local-store-migrations/journal-schema"

const golden = {
	formatVersion: 2,
	migrationId: "local-0007-to-0008-apple-crash-frames-20260819T101500000Z",
	phase: "copying",
	chain: [
		{
			id: "local-0007-to-0008-apple-crash-frames",
			moduleVersion: 1,
			from: {
				version: 7,
				fingerprint: "0123456789abcdef",
				digest: "a".repeat(64),
				manifestDigest: "b".repeat(64),
				chdb: "3.6.0",
				projectRevision: "c".repeat(64),
			},
			to: {
				version: 8,
				fingerprint: "51081e951066442a",
				digest: "d".repeat(64),
				manifestDigest: "e".repeat(64),
				chdb: "3.6.0",
				projectRevision: "f".repeat(64),
			},
			status: "running",
			state: { module: "local-0007-to-0008-apple-crash-frames", version: 1, rawRows: {} },
			progress: { installed: true },
		},
	],
	currentStepIndex: 0,
	sourceDataDir: "/var/lib/maple/data",
	sourceStoreId: "8b7d9f1e-0000-4000-8000-000000000001",
	sourceChdb: "3.6.0",
	sourceFingerprint: "0123456789abcdef",
	sourceDigest: "a".repeat(64),
	sourceVersion: 7,
	targetDataDir: "/var/lib/maple/.maple-migrations/m/target/data",
	targetStoreId: "8b7d9f1e-0000-4000-8000-000000000002",
	targetChdb: "3.6.0",
	targetFingerprint: "51081e951066442a",
	targetDigest: "d".repeat(64),
	targetVersion: 8,
	cutoffAt: "2026-08-19T10:15:00.000Z",
	createdAt: "2026-08-19T10:15:00.000Z",
}

describe("migration journal envelope", () => {
	it("accepts a journal written by a shipped build, unchanged", () => {
		expect(decodeMigrationJournal(structuredClone(golden))).toEqual(golden)
	})

	it("normalizes data directories so an unnormalized journal still matches its store", () => {
		const decoded = decodeMigrationJournal({
			...structuredClone(golden),
			sourceDataDir: "/var/lib/maple/./data",
			targetDataDir: "/var/lib/maple/.maple-migrations/m/target/../target/data",
		})
		expect(decoded.sourceDataDir).toBe("/var/lib/maple/data")
		expect(decoded.targetDataDir).toBe("/var/lib/maple/.maple-migrations/m/target/data")
	})

	it("defaults a missing source digest, because the v0 legacy identity has none", () => {
		const { sourceDigest: _dropped, ...withoutSourceDigest } = structuredClone(golden)
		expect(decodeMigrationJournal(withoutSourceDigest).sourceDigest).toBe("")
	})

	it("keeps absent optional identity fields absent rather than present-undefined", () => {
		const journal = structuredClone(golden)
		const { manifestDigest: _m, projectRevision: _p, ...leanFrom } = journal.chain[0]!.from
		const decoded = decodeMigrationJournal({
			...journal,
			chain: [{ ...journal.chain[0]!, from: leanFrom }],
		})
		expect("manifestDigest" in decoded.chain[0]!.from).toBe(false)
		expect(Object.keys(decoded.chain[0]!.from)).not.toContain("projectRevision")
	})

	it("rejects a journal written by a build this one does not know", () => {
		expect(() => decodeMigrationJournal({ ...structuredClone(golden), somethingElse: 1 })).toThrow()
		expect(() => decodeMigrationJournal({ ...structuredClone(golden), formatVersion: 3 })).toThrow()
	})

	it("rejects the shapes the hand-rolled parser rejected", () => {
		const bad: ReadonlyArray<Record<string, unknown>> = [
			{ migrationId: "" },
			{ migrationId: "../escape" },
			{ phase: "somewhere-else" },
			{ currentStepIndex: -1 },
			{ currentStepIndex: 1.5 },
			{ chain: [] },
			{ sourceVersion: "7" },
			{ targetDigest: "" },
			{ sourceStoreId: "" },
			{ failure: 42 },
		]
		for (const patch of bad) {
			expect(() => decodeMigrationJournal({ ...structuredClone(golden), ...patch })).toThrow()
		}
		for (const value of [null, [], "x", 1, undefined]) {
			expect(() => decodeMigrationJournal(value)).toThrow()
		}
	})

	it("rejects a malformed step without interpreting module state", () => {
		const step = golden.chain[0]!
		for (const patch of [
			{ status: "halfway" },
			{ moduleVersion: 0 },
			{ id: "" },
			{ from: { ...step.from, version: -1 } },
			{ to: { ...step.to, chdb: "" } },
		]) {
			expect(() =>
				decodeMigrationJournal({ ...structuredClone(golden), chain: [{ ...step, ...patch }] }),
			).toThrow()
		}
		// Opaque module state is the module's business, not the coordinator's.
		expect(() =>
			decodeMigrationJournal({
				...structuredClone(golden),
				chain: [{ ...step, state: { anything: [1, 2, 3] } }],
			}),
		).not.toThrow()
	})

	it("round-trips through the schema without changing the persisted form", () => {
		const journal = decodeMigrationJournal(structuredClone(golden))
		expect(Schema.encodeSync(MigrationJournalSchema)(journal)).toEqual(golden)
	})
})
