import { describe, expect, it } from "vitest"
import {
	CURRENT_LOCAL_SCHEMA,
	CURRENT_SCHEMA_PROJECT_REVISION,
	ISSUE_297_TARGET_SCHEMA_PROJECT_REVISION,
	LEGACY_LOCAL_SCHEMA,
	LEGACY_SCHEMA_FINGERPRINT,
	LOCAL_SCHEMA_MANIFEST,
	SCHEMA_DIGEST,
	SCHEMA_FINGERPRINT,
} from "../src/server/schema-identity"
import {
	abandonLocalStoreMigration,
	identityFromMarker,
	migrationJournalPath,
	planMigration,
	reconcileLocalStorePromotion,
	readMigrationJournal,
	resolveMigrationChain,
	validateMigrationRegistry,
	type LocalStoreMigration,
	type MigrationJournal,
} from "../src/server/local-store-migrations"
import { comparePhysicalSchema, type LocalSchemaManifest } from "../src/server/schema-manifest"
import { ensureStoreMarkerDurable, readMarker, storeMarkerPath } from "../src/server/store-version"
import { durableJson } from "../src/server/durable-files"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("current local schema identity", () => {
	it("matches the generated revision and the known issue-297 fingerprint", () => {
		expect(SCHEMA_FINGERPRINT).toBe("06ac009495b54395")
		expect(SCHEMA_DIGEST).toBe("06ac009495b543953779fb91ed3ac1692607d274c34fab4b169bd5674ef8220a")
		expect(ISSUE_297_TARGET_SCHEMA_PROJECT_REVISION).toBe(
			"506bc745f7a7eca202ec905a6403a6815e86413faf0cd3cbbf73881023edce91",
		)
		expect(CURRENT_SCHEMA_PROJECT_REVISION).toMatch(/^[0-9a-f]{64}$/)
		expect(LOCAL_SCHEMA_MANIFEST.objects.length).toBeGreaterThan(60)
		expect(CURRENT_LOCAL_SCHEMA.version).toBe(1)
		const logs = LOCAL_SCHEMA_MANIFEST.objects.find((object) => object.name === "logs")
		expect(logs?.columns.some((column) => column.name.startsWith("idx_"))).toBe(false)
		expect(logs?.indexes).toContain("idx_lower_body")
		const materializedView = LOCAL_SCHEMA_MANIFEST.objects.find(
			(object) => object.kind === "materialized_view",
		)
		expect(materializedView?.columns).toHaveLength(0)
	})
})

describe("local migration registry", () => {
	it("resolves the known fingerprint-only legacy store to current", () => {
		const chain = resolveMigrationChain(LEGACY_LOCAL_SCHEMA, CURRENT_LOCAL_SCHEMA)
		expect(chain.map((migration) => migration.id)).toEqual(["local-0000-to-0001-raw-replay"])
		expect(chain[0]?.fromFingerprint).toBe(LEGACY_SCHEMA_FINGERPRINT)
	})

	it("recognizes legacy and current markers without treating the fingerprint as physical proof", () => {
		expect(
			identityFromMarker({
				formatVersion: 1,
				chdb: "dev",
				maple: "dev",
				createdAt: "unknown",
				schema: LEGACY_SCHEMA_FINGERPRINT,
			}),
		).toEqual(LEGACY_LOCAL_SCHEMA)
		expect(
			identityFromMarker({
				formatVersion: 2,
				storeId: "store-1",
				chdb: "dev",
				maple: "dev",
				createdAt: "2026-01-01T00:00:00.000Z",
				createdByMaple: "dev",
				schemaVersion: 1,
				schemaDigest: SCHEMA_DIGEST,
				schema: SCHEMA_FINGERPRINT,
				activation: "active",
			}),
		).toMatchObject({ version: 1, fingerprint: SCHEMA_FINGERPRINT, digest: SCHEMA_DIGEST })
	})

	it("rejects unknown, future, downgrade, and ambiguous paths", () => {
		expect(() =>
			resolveMigrationChain({ ...LEGACY_LOCAL_SCHEMA, fingerprint: "not-known" }, CURRENT_LOCAL_SCHEMA),
		).toThrow(/no registered/)
		expect(() =>
			resolveMigrationChain(
				{ ...CURRENT_LOCAL_SCHEMA, version: 2, fingerprint: "future", digest: SCHEMA_DIGEST },
				CURRENT_LOCAL_SCHEMA,
			),
		).toThrow(/newer than this build/)
		expect(() =>
			resolveMigrationChain({ ...CURRENT_LOCAL_SCHEMA, digest: "f".repeat(64) }, CURRENT_LOCAL_SCHEMA),
		).toThrow(/unknown fingerprint/)
		const duplicate: LocalStoreMigration = {
			id: "duplicate",
			moduleVersion: 1,
			description: "duplicate",
			fromVersion: 0,
			toVersion: 1,
			toFingerprint: SCHEMA_FINGERPRINT,
			operations: [{ id: "x", description: "x", requiresQuiescence: true, phase: "copying" }],
			dispositions: [],
		}
		expect(() =>
			validateMigrationRegistry([{ ...duplicate }, { ...duplicate, id: "duplicate-2" }]),
		).toThrow(/ambiguous/)
	})

	it("exposes retention-aware dispositions and rollback limits", () => {
		const plan = planMigration(LEGACY_LOCAL_SCHEMA)
		expect(plan.dispositions.find((entry) => entry.name === "logs")?.disposition).toBe("preserve-exact")
		expect(
			plan.dispositions.some((entry) => entry.disposition === "rebuild-within-retention-horizon"),
		).toBe(true)
		expect(plan.rollbackBoundary).toMatch(/pre-cutover/)
		expect(plan.checkpointDisposition).toMatch(/not claimed restorable/)
	})
})

describe("marker v2 durability", () => {
	it("preserves store id and creation provenance across restart", async () => {
		const root = await mkdtemp(join(tmpdir(), "maple-migration-marker-"))
		const dataDir = join(root, "data")
		await mkdir(dataDir, { recursive: true })
		try {
			const first = await ensureStoreMarkerDurable(
				dataDir,
				CURRENT_LOCAL_SCHEMA,
				"first",
				"2026-01-01T00:00:00.000Z",
			)
			const second = await ensureStoreMarkerDurable(
				dataDir,
				CURRENT_LOCAL_SCHEMA,
				"second",
				"2027-01-01T00:00:00.000Z",
			)
			expect(second.formatVersion).toBe(2)
			expect(second.storeId).toBe(first.storeId)
			expect(second.createdAt).toBe(first.createdAt)
			expect(readMarker(dataDir)).toMatchObject({ storeId: first.storeId, createdAt: first.createdAt })
			expect(storeMarkerPath(dataDir)).toContain("maple-store-version.json")
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})

describe("durable migration recovery", () => {
	it("preserves an abandoned transaction and finishes an interrupted promotion", async () => {
		const root = await mkdtemp(join(tmpdir(), "maple-migration-recovery-"))
		const dataDir = join(root, "data")
		const migrationId = "local-0000-to-0001-raw-replay-recovery"
		const migrationRoot = join(root, ".maple-migrations", migrationId)
		const sourceDataDir = join(migrationRoot, "source", "data")
		const targetDataDir = join(migrationRoot, "target", "data")
		const targetStoreId = "target-store-recovery"
		const journal: MigrationJournal = {
			formatVersion: 1,
			migrationId,
			moduleDigest: "a".repeat(64),
			phase: "promotion-started",
			sourceDataDir: dataDir,
			sourceStoreId: "source-store",
			sourceChdb: CURRENT_LOCAL_SCHEMA.chdb,
			sourceFingerprint: LEGACY_SCHEMA_FINGERPRINT,
			sourceDigest: "",
			sourceVersion: 0,
			targetDataDir,
			targetStoreId,
			targetChdb: CURRENT_LOCAL_SCHEMA.chdb,
			targetFingerprint: SCHEMA_FINGERPRINT,
			targetDigest: SCHEMA_DIGEST,
			targetVersion: 1,
			cutoffAt: "2026-01-01T00:00:00.000Z",
			createdAt: "2026-01-01T00:00:00.000Z",
		}
		try {
			await mkdir(join(dataDir, "store"), { recursive: true })
			await mkdir(sourceDataDir, { recursive: true })
			await ensureStoreMarkerDurable(dataDir, CURRENT_LOCAL_SCHEMA, "test", journal.createdAt, {
				activation: "staging",
				storeId: targetStoreId,
			})
			await durableJson(migrationJournalPath(dataDir), journal)

			const abandoned = await abandonLocalStoreMigration(dataDir)
			expect(abandoned).not.toBeNull()
			expect(await readMigrationJournal(dataDir)).toBeNull()

			// Restore the canonical journal to model an operator choosing resume
			// instead of reset. The target data has already been promoted; only the
			// final active marker write was interrupted.
			await durableJson(migrationJournalPath(dataDir), journal)
			const recovered = await reconcileLocalStorePromotion(dataDir, journal)
			expect(recovered.phase).toBe("promoted")
			expect(readMarker(dataDir)).toMatchObject({
				formatVersion: 2,
				storeId: targetStoreId,
				activation: "active",
			})
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})

describe("physical-schema comparison", () => {
	it("fails closed for a missing column and a changed sorting key", () => {
		const expected: LocalSchemaManifest = {
			objects: [
				{
					name: "logs",
					kind: "table",
					columns: [{ name: "OrgId", type: "String" }],
					engine: "MergeTree",
					orderBy: "(OrgId, Timestamp)",
					indexes: ["idx_expected"],
					definition: "CREATE TABLE logs",
				},
			],
			digest: "test",
		}
		const mismatches = comparePhysicalSchema(expected, {
			objects: [
				{
					name: "logs",
					kind: "table",
					columns: [],
					engine: "MergeTree",
					orderBy: "(OrgId, ServiceName, Timestamp)",
					indexes: ["idx_unexpected"],
				},
			],
		})
		expect(mismatches.map((mismatch) => mismatch.reason)).toEqual(
			expect.arrayContaining([
				"missing column OrgId",
				"sorting key differs ((OrgId, ServiceName, Timestamp) vs (OrgId, Timestamp))",
				"missing index idx_expected",
				"unexpected index idx_unexpected",
			]),
		)
	})
})
