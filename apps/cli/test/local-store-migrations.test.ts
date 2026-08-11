import { describe, expect, it } from "vitest"
import {
	CURRENT_LOCAL_SCHEMA,
	CURRENT_SCHEMA_PROJECT_REVISION,
	ISSUE_297_TARGET_SCHEMA_PROJECT_REVISION,
	LEGACY_LOCAL_SCHEMA,
	LEGACY_SCHEMA_FINGERPRINT,
	LOCAL_SCHEMA_MANIFEST,
	LOCAL_SCHEMA_V1,
	LOCAL_SCHEMA_V2,
	LOCAL_SCHEMA_V2_MANIFEST,
	LOCAL_SCHEMA_V3,
	LOCAL_SCHEMA_V3_MANIFEST,
	LOCAL_SCHEMA_V4,
	LOCAL_SCHEMA_V4_MANIFEST,
	LOCAL_SCHEMA_V5,
	SCHEMA_DIGEST,
	SCHEMA_FINGERPRINT,
} from "../src/server/schema-identity"
import {
	abandonLocalStoreMigration,
	abandonLocalStoreMigrationPreservingSource,
	executeMigrationModule,
	executeMigrationChain,
	identityFromMarker,
	legacyToCurrentModule,
	migrationJournalPath,
	migrationHistoryPath,
	migrationRootPath,
	planMigration,
	readMigrationJournal,
	readMigrationJournalStructure,
	resolveMigrationChain,
	runLocalStoreMigration,
	promoteLocalStoreMigration,
	validateMigrationRegistry,
	type LocalStoreMigration,
	type MigrationModuleContext,
	type MigrationJournal,
} from "../src/server/local-store-migrations"
import {
	comparePhysicalSchema,
	type LocalSchemaManifest,
	withRawTelemetryRetentionFloor,
} from "../src/server/schema-manifest"
import { ensureStoreMarkerDurable, readMarker, storeMarkerPath } from "../src/server/store-version"
import { durableJson } from "../src/server/durable-files"
import {
	advanceDuplicateKeyProgress,
	duplicateCursorContinuation,
	type CopyProgress,
} from "../src/server/local-store-migrations/legacy-to-current"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("current local schema identity", () => {
	it("matches the generated v5 revision and keeps the issue-297 identity frozen", () => {
		expect(SCHEMA_FINGERPRINT).toBe("3099929d42b2ce8b")
		expect(SCHEMA_DIGEST).toBe("3099929d42b2ce8b18c06a428a8e32a51ce9724300138241110e08a3f09e8193")
		expect(ISSUE_297_TARGET_SCHEMA_PROJECT_REVISION).toBe(
			"506bc745f7a7eca202ec905a6403a6815e86413faf0cd3cbbf73881023edce91",
		)
		expect(CURRENT_SCHEMA_PROJECT_REVISION).toMatch(/^[0-9a-f]{64}$/)
		expect(LOCAL_SCHEMA_MANIFEST.objects.length).toBeGreaterThan(60)
		expect(CURRENT_LOCAL_SCHEMA.version).toBe(5)
		expect(CURRENT_LOCAL_SCHEMA).toEqual(LOCAL_SCHEMA_V5)
		const logs = LOCAL_SCHEMA_MANIFEST.objects.find((object) => object.name === "logs")
		expect(logs?.columns.some((column) => column.name.startsWith("idx_"))).toBe(false)
		expect(logs?.indexes).toContain("idx_lower_body")
		const serviceMapIngress = LOCAL_SCHEMA_MANIFEST.objects.find(
			(object) => object.name === "service_map_edges_hourly_ingest",
		)
		expect(serviceMapIngress?.engine).toBe("Null")
		expect(serviceMapIngress?.orderBy).toBeUndefined()
		const materializedView = LOCAL_SCHEMA_MANIFEST.objects.find(
			(object) => object.kind === "materialized_view",
		)
		expect(materializedView?.columns).toHaveLength(0)
		const timeOrderedErrors = LOCAL_SCHEMA_MANIFEST.objects.find(
			(object) => object.name === "error_events_by_time_mv",
		)
		expect(timeOrderedErrors?.definition).toContain("FROM traces")
		expect(timeOrderedErrors?.definition).not.toContain("FROM error_events")
		const v2TimeOrderedErrors = LOCAL_SCHEMA_V2_MANIFEST.objects.find(
			(object) => object.name === "error_events_by_time_mv",
		)
		expect(v2TimeOrderedErrors?.definition).toContain("FROM error_events")

		// v4 was exactly v3 plus the web analytics fact table and its view. Asserted
		// against the frozen v3 manifest rather than the diff so a later structural
		// change can't quietly ride along on this version.
		const webEvents = LOCAL_SCHEMA_MANIFEST.objects.find((object) => object.name === "web_events")
		expect(webEvents?.engine).toBe("MergeTree")
		expect(webEvents?.orderBy).toBe("(OrgId, Timestamp, SessionId, Seq)")
		expect(webEvents?.indexes).toContain("idx_event_name")
		const webEventsView = LOCAL_SCHEMA_MANIFEST.objects.find((object) => object.name === "web_events_mv")
		expect(webEventsView?.definition).toContain("FROM session_events")
		const v3Names = new Set(LOCAL_SCHEMA_V3_MANIFEST.objects.map((object) => object.name))
		expect(v3Names.has("web_events")).toBe(false)
		expect(
			LOCAL_SCHEMA_MANIFEST.objects.map((object) => object.name).filter((name) => !v3Names.has(name)),
		).toEqual(["web_events", "web_events_mv"])

		// v5 adds no objects at all — only three app-kind signal columns on an
		// existing table. Asserting the object sets are identical is what stops a
		// structural change riding along on a column-only version.
		expect(LOCAL_SCHEMA_MANIFEST.objects.map((object) => object.name)).toEqual(
			LOCAL_SCHEMA_V4_MANIFEST.objects.map((object) => object.name),
		)
		const appKindColumns = ["TelemetrySdkLanguage", "BrowserPlatform", "DeviceType"]
		const platformsColumnsOf = (manifest: LocalSchemaManifest) =>
			manifest.objects
				.find((object) => object.name === "service_platforms_hourly")
				?.columns.map((column) => column.name) ?? []
		expect(platformsColumnsOf(LOCAL_SCHEMA_MANIFEST)).toEqual(expect.arrayContaining(appKindColumns))
		expect(platformsColumnsOf(LOCAL_SCHEMA_V4_MANIFEST)).not.toEqual(
			expect.arrayContaining(appKindColumns),
		)
	})
})

describe("local migration registry", () => {
	it("resolves the known fingerprint-only legacy store to current", () => {
		const chain = resolveMigrationChain(LEGACY_LOCAL_SCHEMA, CURRENT_LOCAL_SCHEMA)
		expect(chain.map((migration) => migration.id)).toEqual([
			"local-0000-to-0001-raw-replay",
			"local-0001-to-0002-error-rollup",
			"local-0002-to-0003-service-map-ingest-bridge",
			"local-0003-to-0004-web-events",
			"local-0004-to-0005-service-app-kind",
		])
		expect(chain[0]?.from.fingerprint).toBe(LEGACY_SCHEMA_FINGERPRINT)
		expect(chain[0]?.to).toEqual(LOCAL_SCHEMA_V1)
		expect(chain[1]?.to).toEqual(LOCAL_SCHEMA_V2)
		expect(chain[2]?.to).toEqual(LOCAL_SCHEMA_V3)
		expect(chain[3]?.to).toEqual(LOCAL_SCHEMA_V4)
		expect(chain[4]?.to).toEqual(LOCAL_SCHEMA_V5)
		expect(typeof chain[0]?.apply).toBe("function")
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
				schemaVersion: 4,
				schemaDigest: SCHEMA_DIGEST,
				schema: SCHEMA_FINGERPRINT,
				activation: "active",
			}),
		).toMatchObject({ version: 4, fingerprint: SCHEMA_FINGERPRINT, digest: SCHEMA_DIGEST })
	})

	it("rejects unknown, future, downgrade, and ambiguous paths", () => {
		expect(() =>
			resolveMigrationChain({ ...LEGACY_LOCAL_SCHEMA, fingerprint: "not-known" }, CURRENT_LOCAL_SCHEMA),
		).toThrow(/no registered/)
		expect(() =>
			resolveMigrationChain(
				{ ...CURRENT_LOCAL_SCHEMA, version: 6, fingerprint: "future", digest: SCHEMA_DIGEST },
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
			from: LEGACY_LOCAL_SCHEMA,
			to: LOCAL_SCHEMA_V1,
			operations: [{ id: "x", description: "x", requiresQuiescence: true, phase: "copying" }],
			dispositions: [],
			decodeState: (value) => value,
			decodeProgress: (value) => value,
			preflight: async () => undefined,
			prepareTarget: async (_context, state) => state,
			apply: async (_context, _state, progress) => progress,
			verify: async () => undefined,
			recover: async () => ({}),
		}
		expect(() =>
			validateMigrationRegistry([{ ...duplicate }, { ...duplicate, id: "duplicate-2" }]),
		).toThrow(/ambiguous/)
	})

	it("supports a later executable edge without changing the registry coordinator", async () => {
		const events: string[] = []
		const v2: LocalStoreMigration = {
			id: "local-0001-to-0002-fixture",
			moduleVersion: 1,
			description: "fixture-only second edge",
			from: LOCAL_SCHEMA_V1,
			to: { ...LOCAL_SCHEMA_V1, version: 2, fingerprint: "2222222222222222", digest: "2".repeat(64) },
			operations: [{ id: "fixture", description: "fixture transform", requiresQuiescence: true }],
			dispositions: [],
			decodeState: (value) => value,
			decodeProgress: (value) => value,
			preflight: async () => {
				events.push("preflight")
				return { state: "prepared" }
			},
			prepareTarget: async (_context, state) => {
				events.push("prepareTarget")
				return state
			},
			apply: async (_context, _state, _progress) => {
				events.push("apply")
				return { rows: 1 }
			},
			verify: async () => {
				events.push("verify")
			},
			recover: async () => ({}),
		}
		const chain = resolveMigrationChain(LEGACY_LOCAL_SCHEMA, v2.to, [legacyToCurrentModule, v2])
		expect(chain.map((migration) => migration.id)).toEqual([
			"local-0000-to-0001-raw-replay",
			"local-0001-to-0002-fixture",
		])
		expect(validateMigrationRegistry([legacyToCurrentModule, v2])).toHaveLength(2)
		const context = {
			dataDir: "/tmp/source",
			sourceDataDir: "/tmp/source",
			targetDataDir: "/tmp/target",
			source: LOCAL_SCHEMA_V1,
			target: v2.to,
			cutoffAt: "2026-01-01T00:00:00.000Z",
			step: {
				id: v2.id,
				moduleVersion: v2.moduleVersion,
				from: v2.from,
				to: v2.to,
				status: "pending" as const,
			},
			openSource: async () => undefined,
			openTarget: async () => undefined,
			ensureCapacity: async () => undefined,
			saveStep: async () => undefined,
		} as unknown as MigrationModuleContext
		await executeMigrationModule(v2, context, context.step, { prepareTarget: true })
		expect(events).toEqual(["preflight", "prepareTarget", "apply", "verify"])

		const verifiedEvents: string[] = []
		const verifiedModule: LocalStoreMigration = {
			...v2,
			prepareTarget: async () => {
				verifiedEvents.push("prepareTarget")
				return { state: "unexpected" }
			},
			apply: async () => {
				verifiedEvents.push("apply")
				return { rows: 2 }
			},
			verify: async () => {
				verifiedEvents.push("verify")
			},
			recover: async () => {
				verifiedEvents.push("recover")
				return {}
			},
		}
		const verifiedStep = {
			...context.step,
			status: "verified" as const,
			state: { state: "prepared" },
			progress: { rows: 1 },
		}
		await executeMigrationModule(verifiedModule, { ...context, step: verifiedStep }, verifiedStep, {
			prepareTarget: true,
		})
		expect(verifiedEvents).toEqual([])
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
	it("fails closed on malformed journal topology and typed progress", async () => {
		const root = await mkdtemp(join(tmpdir(), "maple-migration-journal-invariants-"))
		const dataDir = join(root, "data")
		const base: MigrationJournal = {
			formatVersion: 2,
			migrationId: "journal-invariant",
			phase: "copying",
			chain: [
				{
					id: legacyToCurrentModule.id,
					moduleVersion: legacyToCurrentModule.moduleVersion,
					from: LEGACY_LOCAL_SCHEMA,
					to: LOCAL_SCHEMA_V1,
					status: "running",
					state: { module: legacyToCurrentModule.id, version: 1 },
					progress: { sourceInventory: {}, copied: {} },
				},
			],
			currentStepIndex: 0,
			sourceDataDir: dataDir,
			sourceStoreId: "source",
			sourceChdb: LEGACY_LOCAL_SCHEMA.chdb,
			sourceFingerprint: LEGACY_LOCAL_SCHEMA.fingerprint,
			sourceDigest: LEGACY_LOCAL_SCHEMA.digest,
			sourceVersion: LEGACY_LOCAL_SCHEMA.version,
			targetDataDir: join(root, ".maple-migrations", "journal-invariant", "target", "data"),
			targetStoreId: "target",
			targetChdb: LOCAL_SCHEMA_V1.chdb,
			targetFingerprint: LOCAL_SCHEMA_V1.fingerprint,
			targetDigest: LOCAL_SCHEMA_V1.digest,
			targetVersion: LOCAL_SCHEMA_V1.version,
			cutoffAt: "2026-01-01T00:00:00.000Z",
			createdAt: "2026-01-01T00:00:00.000Z",
		}
		try {
			const {
				state: _verifiedState,
				progress: _verifiedProgress,
				...verifiedWithoutStateAndProgress
			} = base.chain[0]!
			const { progress: _missingProgress, ...verifiedWithoutProgress } = base.chain[0]!
			await durableJson(migrationJournalPath(dataDir), {
				...base,
				chain: [{ ...verifiedWithoutStateAndProgress, status: "verified" }],
			})
			await expect(readMigrationJournal(dataDir)).rejects.toThrow(/no persisted state/)
			await durableJson(migrationJournalPath(dataDir), {
				...base,
				chain: [{ ...verifiedWithoutProgress, status: "verified" }],
			})
			await expect(readMigrationJournal(dataDir)).rejects.toThrow(/no persisted progress/)
			await durableJson(migrationJournalPath(dataDir), {
				...base,
				chain: [{ ...base.chain[0]!, progress: { sourceInventory: [], copied: {} } }],
			})
			await expect(readMigrationJournal(dataDir)).rejects.toThrow(/sourceInventory must be an object/)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it("preserves an abandoned transaction and finishes an interrupted promotion", async () => {
		const root = await mkdtemp(join(tmpdir(), "maple-migration-recovery-"))
		const dataDir = join(root, "data")
		const migrationId = "local-0000-to-0001-raw-replay-recovery"
		const migrationRoot = join(root, ".maple-migrations", migrationId)
		const sourceDataDir = join(migrationRoot, "source", "data")
		const targetDataDir = join(migrationRoot, "target", "data")
		const targetStoreId = "target-store-recovery"
		const journal: MigrationJournal = {
			formatVersion: 2,
			migrationId,
			phase: "promotion-started",
			chain: [
				{
					id: migrationId.slice(0, migrationId.lastIndexOf("-recovery")),
					moduleVersion: 1,
					from: LEGACY_LOCAL_SCHEMA,
					to: LOCAL_SCHEMA_V1,
					status: "completed",
					state: { module: "local-0000-to-0001-raw-replay", version: 1 },
					progress: { sourceInventory: {}, copied: {} },
				},
			],
			currentStepIndex: 1,
			sourceDataDir: dataDir,
			sourceStoreId: "source-store",
			sourceChdb: CURRENT_LOCAL_SCHEMA.chdb,
			sourceFingerprint: LEGACY_SCHEMA_FINGERPRINT,
			sourceDigest: "",
			sourceVersion: 0,
			targetDataDir,
			targetStoreId,
			targetChdb: CURRENT_LOCAL_SCHEMA.chdb,
			targetFingerprint: LOCAL_SCHEMA_V1.fingerprint,
			targetDigest: LOCAL_SCHEMA_V1.digest,
			targetVersion: 1,
			cutoffAt: "2026-01-01T00:00:00.000Z",
			createdAt: "2026-01-01T00:00:00.000Z",
		}
		try {
			await mkdir(join(dataDir, "store"), { recursive: true })
			await mkdir(sourceDataDir, { recursive: true })
			await durableJson(storeMarkerPath(sourceDataDir), {
				chdb: CURRENT_LOCAL_SCHEMA.chdb,
				maple: "test",
				createdAt: journal.createdAt,
				schema: LEGACY_SCHEMA_FINGERPRINT,
			})
			await ensureStoreMarkerDurable(dataDir, LOCAL_SCHEMA_V1, "test", journal.createdAt, {
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
			const preview = await runLocalStoreMigration({ dataDir, dryRun: true })
			expect("chain" in preview && preview.chain.map((step) => step.id)).toEqual([
				"local-0000-to-0001-raw-replay",
			])
			const recovered = await runLocalStoreMigration({ dataDir })
			expect(recovered.phase).toBe("promoted")
			expect(await readMigrationJournal(dataDir)).toBeNull()
			expect(await Bun.file(migrationHistoryPath(dataDir, migrationId)).exists()).toBe(true)
			expect(readMarker(dataDir)).toMatchObject({
				formatVersion: 2,
				storeId: targetStoreId,
				activation: "active",
			})
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it("runs a genuine two-step coordinator chain, resumes a verified step, and promotes once", async () => {
		const root = await mkdtemp(join(tmpdir(), "maple-migration-chain-"))
		const v2 = {
			...LOCAL_SCHEMA_V1,
			version: 2,
			fingerprint: "2222222222222222",
			digest: "2".repeat(64),
		} as const
		const makeFixtureModule = (
			id: string,
			from: typeof LEGACY_LOCAL_SCHEMA | typeof LOCAL_SCHEMA_V1,
			to: typeof LOCAL_SCHEMA_V1 | typeof v2,
			events: string[],
		): LocalStoreMigration => ({
			id,
			moduleVersion: 1,
			description: `fixture ${id}`,
			from,
			to,
			operations: [{ id: `${id}-operation`, description: id, requiresQuiescence: true }],
			dispositions: [],
			decodeState: (value) => {
				if (
					typeof value !== "object" ||
					value === null ||
					Array.isArray(value) ||
					(value as Record<string, unknown>).module !== id ||
					(value as Record<string, unknown>).version !== 1
				)
					throw new Error(`${id} state is invalid`)
				return value
			},
			decodeProgress: (value) => {
				if (value === undefined) return undefined
				if (typeof value !== "object" || value === null || Array.isArray(value))
					throw new Error(`${id} progress is invalid`)
				return value
			},
			preflight: async (context) => {
				events.push(
					`${id}:preflight:${context.sourceDataDir === context.targetDataDir ? "shared" : "separate"}`,
				)
				return { module: id, version: 1 }
			},
			prepareTarget: async (context, state) => {
				events.push(`${id}:prepareTarget`)
				await mkdir(context.targetDataDir, { recursive: true })
				return state
			},
			apply: async (_context, _state, _progress) => {
				events.push(`${id}:apply`)
				return { rows: 1 }
			},
			verify: async () => {
				events.push(`${id}:verify`)
			},
			recover: async () => {
				events.push(`${id}:recover`)
				return {}
			},
		})

		const runScenario = async (scenarioRoot: string, resumeSecondStep: boolean): Promise<string[]> => {
			const dataDir = join(scenarioRoot, "data")
			const migrationId = resumeSecondStep ? "fixture-resume" : "fixture-two-step"
			const targetDataDir = join(migrationRootPath(dataDir, migrationId), "target", "data")
			const events: string[] = []
			const first = makeFixtureModule("fixture-v0-v1", LEGACY_LOCAL_SCHEMA, LOCAL_SCHEMA_V1, events)
			const second = makeFixtureModule("fixture-v1-v2", LOCAL_SCHEMA_V1, v2, events)
			const journal: MigrationJournal = {
				formatVersion: 2,
				migrationId,
				phase: resumeSecondStep ? "copy-verified" : "planned",
				chain: [
					{
						id: first.id,
						moduleVersion: 1,
						from: first.from,
						to: first.to,
						status: resumeSecondStep ? "completed" : "pending",
						...(resumeSecondStep ? { state: { module: first.id, version: 1 } } : {}),
					},
					{
						id: second.id,
						moduleVersion: 1,
						from: second.from,
						to: second.to,
						status: resumeSecondStep ? "verified" : "pending",
						...(resumeSecondStep
							? { state: { module: second.id, version: 1 }, progress: { rows: 1 } }
							: {}),
					},
				],
				currentStepIndex: resumeSecondStep ? 1 : 0,
				sourceDataDir: dataDir,
				sourceStoreId: `${migrationId}-source`,
				sourceChdb: CURRENT_LOCAL_SCHEMA.chdb,
				sourceFingerprint: LEGACY_LOCAL_SCHEMA.fingerprint,
				sourceDigest: LEGACY_LOCAL_SCHEMA.digest,
				sourceVersion: LEGACY_LOCAL_SCHEMA.version,
				targetDataDir,
				targetStoreId: `${migrationId}-target`,
				targetChdb: v2.chdb,
				targetFingerprint: v2.fingerprint,
				targetDigest: v2.digest,
				targetVersion: v2.version,
				cutoffAt: "2026-01-01T00:00:00.000Z",
				createdAt: "2026-01-01T00:00:00.000Z",
			}
			await mkdir(join(dataDir, "store"), { recursive: true })
			await durableJson(storeMarkerPath(dataDir), {
				chdb: CURRENT_LOCAL_SCHEMA.chdb,
				maple: "test",
				createdAt: journal.createdAt,
				schema: LEGACY_SCHEMA_FINGERPRINT,
			})
			if (resumeSecondStep) {
				await mkdir(targetDataDir, { recursive: true })
				await ensureStoreMarkerDurable(targetDataDir, LOCAL_SCHEMA_V1, "test", journal.createdAt, {
					activation: "staging",
					storeId: journal.targetStoreId,
				})
			}
			await durableJson(migrationJournalPath(dataDir), journal)
			const completed = await executeMigrationChain(dataDir, journal, [first, second])
			if (resumeSecondStep) {
				expect(events).toEqual([])
			} else {
				expect(events).toEqual([
					"fixture-v0-v1:preflight:separate",
					"fixture-v0-v1:prepareTarget",
					"fixture-v0-v1:apply",
					"fixture-v0-v1:verify",
					"fixture-v1-v2:preflight:shared",
					"fixture-v1-v2:prepareTarget",
					"fixture-v1-v2:apply",
					"fixture-v1-v2:verify",
				])
			}
			expect(completed.currentStepIndex).toBe(2)
			expect(completed.chain.every((step) => step.status === "completed")).toBe(true)
			const result = await promoteLocalStoreMigration(dataDir, completed)
			expect(result.phase).toBe("promoted")
			expect(readMarker(dataDir)).toMatchObject({
				formatVersion: 2,
				storeId: journal.targetStoreId,
				schemaVersion: 2,
				activation: "active",
			})
			expect(await Bun.file(migrationHistoryPath(dataDir, migrationId)).exists()).toBe(true)
			return events
		}

		try {
			await runScenario(join(root, "normal"), false)
			await runScenario(join(root, "resume"), true)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it("quarantines only a staged target and rejects promotion-started abandonment", async () => {
		const root = await mkdtemp(join(tmpdir(), "maple-migration-abandon-target-"))
		const dataDir = join(root, "data")
		const migrationId = "fixture-target-abandon"
		const targetDataDir = join(migrationRootPath(dataDir, migrationId), "target", "data")
		const journal: MigrationJournal = {
			formatVersion: 2,
			migrationId,
			phase: "copying",
			chain: [
				{
					id: legacyToCurrentModule.id,
					moduleVersion: legacyToCurrentModule.moduleVersion,
					from: LEGACY_LOCAL_SCHEMA,
					to: LOCAL_SCHEMA_V1,
					status: "running",
					state: { module: legacyToCurrentModule.id, version: 1 },
					progress: { sourceInventory: {}, copied: {} },
				},
			],
			currentStepIndex: 0,
			sourceDataDir: dataDir,
			sourceStoreId: "source-id",
			sourceChdb: CURRENT_LOCAL_SCHEMA.chdb,
			sourceFingerprint: LEGACY_LOCAL_SCHEMA.fingerprint,
			sourceDigest: LEGACY_LOCAL_SCHEMA.digest,
			sourceVersion: LEGACY_LOCAL_SCHEMA.version,
			targetDataDir,
			targetStoreId: "target-id",
			targetChdb: LOCAL_SCHEMA_V1.chdb,
			targetFingerprint: LOCAL_SCHEMA_V1.fingerprint,
			targetDigest: LOCAL_SCHEMA_V1.digest,
			targetVersion: LOCAL_SCHEMA_V1.version,
			cutoffAt: "2026-01-01T00:00:00.000Z",
			createdAt: "2026-01-01T00:00:00.000Z",
		}
		try {
			await mkdir(join(dataDir, "store"), { recursive: true })
			await durableJson(storeMarkerPath(dataDir), {
				chdb: CURRENT_LOCAL_SCHEMA.chdb,
				maple: "test",
				createdAt: journal.createdAt,
				schema: LEGACY_SCHEMA_FINGERPRINT,
			})
			await mkdir(targetDataDir, { recursive: true })
			await ensureStoreMarkerDurable(targetDataDir, LOCAL_SCHEMA_V1, "test", journal.createdAt, {
				activation: "staging",
				storeId: journal.targetStoreId,
			})
			await durableJson(migrationJournalPath(dataDir), journal)
			const quarantine = await abandonLocalStoreMigrationPreservingSource(dataDir)
			expect(quarantine).not.toBeNull()
			expect(await Bun.file(migrationJournalPath(dataDir)).exists()).toBe(false)
			expect(await Bun.file(storeMarkerPath(dataDir)).exists()).toBe(true)
			expect(await Bun.file(join(dataDir, "store", "placeholder")).exists()).toBe(false)
			expect(await Bun.file(join(quarantine!, "journal.json")).exists()).toBe(true)
			expect(
				await Bun.file(join(quarantine!, "target", "data", "../maple-store-version.json")).exists(),
			).toBe(true)

			const promotionJournal = {
				...journal,
				phase: "promotion-started" as const,
				currentStepIndex: 1,
				chain: journal.chain.map((step) => ({ ...step, status: "completed" as const })),
			}
			await durableJson(migrationJournalPath(dataDir), promotionJournal)
			await expect(abandonLocalStoreMigrationPreservingSource(dataDir)).rejects.toThrow(
				/promotion started/,
			)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it("quarantines a structurally safe target without binding its old module", async () => {
		const root = await mkdtemp(join(tmpdir(), "maple-migration-abandon-unbound-"))
		const dataDir = join(root, "data")
		const migrationId = "fixture-unbound-abandon"
		const targetDataDir = join(migrationRootPath(dataDir, migrationId), "target", "data")
		const journal: MigrationJournal = {
			formatVersion: 2,
			migrationId,
			phase: "copying",
			chain: [
				{
					id: "removed-module",
					moduleVersion: 99,
					from: LEGACY_LOCAL_SCHEMA,
					to: LOCAL_SCHEMA_V1,
					status: "running",
					state: { corrupt: true },
					progress: { corrupt: true },
				},
			],
			currentStepIndex: 0,
			sourceDataDir: dataDir,
			sourceStoreId: "source-id",
			sourceChdb: CURRENT_LOCAL_SCHEMA.chdb,
			sourceFingerprint: LEGACY_LOCAL_SCHEMA.fingerprint,
			sourceDigest: LEGACY_LOCAL_SCHEMA.digest,
			sourceVersion: LEGACY_LOCAL_SCHEMA.version,
			targetDataDir,
			targetStoreId: "target-id",
			targetChdb: LOCAL_SCHEMA_V1.chdb,
			targetFingerprint: LOCAL_SCHEMA_V1.fingerprint,
			targetDigest: LOCAL_SCHEMA_V1.digest,
			targetVersion: LOCAL_SCHEMA_V1.version,
			cutoffAt: "2026-01-01T00:00:00.000Z",
			createdAt: "2026-01-01T00:00:00.000Z",
		}
		try {
			await mkdir(join(dataDir, "store"), { recursive: true })
			await durableJson(storeMarkerPath(dataDir), {
				chdb: CURRENT_LOCAL_SCHEMA.chdb,
				maple: "test",
				createdAt: journal.createdAt,
				schema: LEGACY_SCHEMA_FINGERPRINT,
			})
			await mkdir(targetDataDir, { recursive: true })
			await ensureStoreMarkerDurable(targetDataDir, LOCAL_SCHEMA_V1, "test", journal.createdAt, {
				activation: "staging",
				storeId: journal.targetStoreId,
			})
			await durableJson(migrationJournalPath(dataDir), journal)
			await expect(readMigrationJournal(dataDir)).rejects.toThrow(/not available/)
			expect(await readMigrationJournalStructure(dataDir)).toMatchObject({ migrationId })

			const quarantine = await abandonLocalStoreMigrationPreservingSource(dataDir)
			expect(quarantine).not.toBeNull()
			expect(await Bun.file(join(quarantine!, "journal.json")).exists()).toBe(true)
			expect(await Bun.file(storeMarkerPath(dataDir)).exists()).toBe(true)
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

	it("expects the raised TTL once a retention floor is configured", () => {
		const bundled: LocalSchemaManifest = {
			objects: [
				{
					name: "logs",
					kind: "table",
					columns: [],
					engine: "MergeTree",
					ttl: "toDate(TimestampTime) + INTERVAL 30 DAY",
					indexes: [],
					definition: "CREATE TABLE logs",
				},
				{
					name: "logs_aggregates_hourly",
					kind: "table",
					columns: [],
					engine: "AggregatingMergeTree",
					ttl: "toDate(Hour) + INTERVAL 30 DAY",
					indexes: [],
					definition: "CREATE TABLE logs_aggregates_hourly",
				},
			],
			digest: "test",
		}
		const floored = withRawTelemetryRetentionFloor(bundled, ["logs"], 120)
		// The floor only moves the raw-telemetry tables; a rollup keeps its own TTL.
		expect(floored.objects.map((object) => object.ttl)).toEqual([
			"toDate(TimestampTime) + INTERVAL 120 DAY",
			"toDate(Hour) + INTERVAL 30 DAY",
		])
		// chDB reports the TTL as `toIntervalDay(n)`; the physical comparison
		// already normalizes that form, so the floored day count is what matters.
		expect(
			comparePhysicalSchema(floored, {
				objects: [
					{
						name: "logs",
						kind: "table",
						columns: [],
						engine: "MergeTree",
						ttl: "toDate(TimestampTime) + toIntervalDay(120)",
					},
					{
						name: "logs_aggregates_hourly",
						kind: "table",
						columns: [],
						engine: "AggregatingMergeTree",
						ttl: "toDate(Hour) + toIntervalDay(30)",
					},
				],
			}),
		).toEqual([])
		// Anything other than the floored value still fails closed.
		expect(
			comparePhysicalSchema(floored, {
				objects: [
					{
						name: "logs",
						kind: "table",
						columns: [],
						engine: "MergeTree",
						ttl: "toDate(TimestampTime) + toIntervalDay(30)",
					},
					{
						name: "logs_aggregates_hourly",
						kind: "table",
						columns: [],
						engine: "AggregatingMergeTree",
						ttl: "toDate(Hour) + toIntervalDay(30)",
					},
				],
			}).map((mismatch) => mismatch.reason),
		).toEqual([
			"TTL differs (toDate(TimestampTime) + toIntervalDay(30) vs toDate(TimestampTime) + INTERVAL 120 DAY)",
		])
	})

	it("leaves a longer bundled TTL alone", () => {
		const bundled: LocalSchemaManifest = {
			objects: [
				{
					name: "metrics_gauge",
					kind: "table",
					columns: [],
					engine: "MergeTree",
					ttl: "toDate(TimeUnix) + INTERVAL 365 DAY",
					indexes: [],
					definition: "CREATE TABLE metrics_gauge",
				},
			],
			digest: "test",
		}
		expect(withRawTelemetryRetentionFloor(bundled, ["metrics_gauge"], 120).objects[0]?.ttl).toBe(
			"toDate(TimeUnix) + INTERVAL 365 DAY",
		)
	})
})

describe("legacy raw replay cursor", () => {
	it("keeps a cumulative ordinal across row- and byte-bounded equal-key batches", () => {
		const initial: CopyProgress = {
			rows: 0,
			bytes: 0,
			lastTimestamp: null,
			lastHash: null,
			lastTieBreak: null,
			duplicateCount: 0,
			duplicateGroupExhausted: false,
		}
		const first = advanceDuplicateKeyProgress(initial, null, "same-key", 2)
		const second = advanceDuplicateKeyProgress({ ...initial, ...first }, "same-key", "same-key", 2)
		expect(first.duplicateCount).toBe(2)
		expect(second.duplicateCount).toBe(4)
		const nextKey = advanceDuplicateKeyProgress({ ...initial, ...second }, "same-key", "next-key", 1)
		expect(nextKey.duplicateCount).toBe(1)
		expect(
			duplicateCursorContinuation({
				...initial,
				lastTimestamp: "2026-01-01T00:00:00.000Z",
				lastHash: "42",
				lastTieBreak: "84",
				duplicateCount: 25,
			}),
		).toEqual({ comparison: ">=", offset: 25 })
		expect(
			duplicateCursorContinuation({
				...initial,
				lastTimestamp: "2026-01-01T00:00:00.000Z",
				lastHash: "42",
				lastTieBreak: "84",
				duplicateCount: 25,
				duplicateGroupExhausted: true,
			}),
		).toEqual({ comparison: ">", offset: 0 })
	})

	it("rejects non-numeric persisted cursor values", () => {
		const progress = {
			sourceInventory: {},
			copied: {
				logs: {
					rows: 0,
					bytes: 0,
					lastTimestamp: null,
					lastHash: "1 OR 1=1",
					lastTieBreak: "2",
					duplicateCount: 0,
					duplicateGroupExhausted: false,
				},
			},
		}
		expect(() => legacyToCurrentModule.decodeProgress(progress)).toThrow(/lastHash/)
	})
})
