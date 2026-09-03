import { v7ToV8AppleCrashFramesModule } from "../src/server/local-store-migrations/v7-to-v8-apple-crash-frames"
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
	LOCAL_SCHEMA_V5_MANIFEST,
	LOCAL_SCHEMA_V7_MANIFEST,
	LOCAL_SCHEMA_V6,
	LOCAL_SCHEMA_V7,
	LOCAL_SCHEMA_V8,
	LOCAL_SCHEMA_V10,
	LOCAL_SCHEMA_V10_MANIFEST,
	LOCAL_SCHEMA_V11,
	LOCAL_SCHEMA_V11_MANIFEST,
	LOCAL_SCHEMA_V12,
	LOCAL_SCHEMA_V12_MANIFEST,
	LOCAL_SCHEMA_V13,
	LOCAL_SCHEMA_V13_MANIFEST,
	LOCAL_SCHEMA_V14,
	LOCAL_SCHEMA_V15,
	LOCAL_SCHEMA_V16,
	LOCAL_SCHEMA_V17,
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
	__testables as legacyTestables,
	advanceDuplicateKeyProgress,
	duplicateCursorContinuation,
	LEGACY_RAW_TABLES,
	nextFetchRowLimit,
	type CopyProgress,
	type RawReplayProgress,
} from "../src/server/local-store-migrations/legacy-to-current"
import { v10ToV11ProductEventsModule } from "../src/server/local-store-migrations/v10-to-v11-product-events"
import { v11ToV12ServiceMapEdgeQuantilesModule } from "../src/server/local-store-migrations/v11-to-v12-service-map-edge-quantiles"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("current local schema identity", () => {
	it("matches the generated v17 revision and keeps the issue-297 identity frozen", () => {
		expect(SCHEMA_FINGERPRINT).toBe("9135b2a26d977584")
		expect(SCHEMA_DIGEST).toBe("9135b2a26d977584d621f4d3ba8cce1def47d98d55a3bf53dac493f93d2e0118")
		expect(ISSUE_297_TARGET_SCHEMA_PROJECT_REVISION).toBe(
			"506bc745f7a7eca202ec905a6403a6815e86413faf0cd3cbbf73881023edce91",
		)
		expect(CURRENT_SCHEMA_PROJECT_REVISION).toMatch(/^[0-9a-f]{64}$/)
		expect(LOCAL_SCHEMA_MANIFEST.objects.length).toBeGreaterThan(60)
		expect(CURRENT_LOCAL_SCHEMA.version).toBe(17)
		expect(CURRENT_LOCAL_SCHEMA).toEqual(LOCAL_SCHEMA_V17)
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

		// v4 is exactly v3 plus the web analytics fact table and its view. Asserted
		// against the frozen v3 manifest rather than the diff so a later structural
		// change can't quietly ride along on this version. (v6 drops web_events
		// again, so it is read from the frozen v4 manifest, not the current one.)
		const webEvents = LOCAL_SCHEMA_V4_MANIFEST.objects.find((object) => object.name === "web_events")
		expect(webEvents?.engine).toBe("MergeTree")
		expect(webEvents?.orderBy).toBe("(OrgId, Timestamp, SessionId, Seq)")
		expect(webEvents?.indexes).toContain("idx_event_name")
		const webEventsView = LOCAL_SCHEMA_V4_MANIFEST.objects.find(
			(object) => object.name === "web_events_mv",
		)
		expect(webEventsView?.definition).toContain("FROM session_events")
		const v3Names = new Set(LOCAL_SCHEMA_V3_MANIFEST.objects.map((object) => object.name))
		expect(v3Names.has("web_events")).toBe(false)
		const v4Names = new Set(LOCAL_SCHEMA_V4_MANIFEST.objects.map((object) => object.name))
		expect([...v4Names].filter((name) => !v3Names.has(name))).toEqual(["web_events", "web_events_mv"])

		// v5 is exactly v4 plus the minutely service-overview rollup and its view.
		// Asserted against the frozen v4 manifest, same as above, so a later
		// structural change cannot quietly ride along on this version.
		const minutely = LOCAL_SCHEMA_V5_MANIFEST.objects.find(
			(object) => object.name === "service_overview_minutely",
		)
		expect(minutely?.engine).toBe("AggregatingMergeTree")
		expect(minutely?.orderBy).toBe(
			"(OrgId, ServiceName, Minute, DeploymentEnv, ServiceNamespace, CommitSha)",
		)
		const minutelyView = LOCAL_SCHEMA_V5_MANIFEST.objects.find(
			(object) => object.name === "service_overview_minutely_mv",
		)
		// Reads traces directly — a cascade off the hourly rollup would make the
		// migration's backfill double-count into a table that cannot be rebuilt.
		expect(minutelyView?.definition).toContain("FROM traces")
		expect(minutelyView?.definition).not.toContain("FROM service_overview_minutely")
		const v5Names = new Set(LOCAL_SCHEMA_V5_MANIFEST.objects.map((object) => object.name))
		const currentNames = new Set(LOCAL_SCHEMA_MANIFEST.objects.map((object) => object.name))
		expect([...v5Names].filter((name) => !v4Names.has(name))).toEqual([
			"service_overview_minutely",
			"service_overview_minutely_mv",
		])

		// v6, v7 and v8 add and remove nothing: they only replace materialized-view
		// bodies, so their object set is identical to v5 and the manifest digest
		// differs solely through those definitions. v9 removes `error_spans` and
		// its view; v11 replaces `web_events` with `product_events` and adds
		// `identity_links`. Asserted as an exact set difference rather than a
		// relaxed check, so a future edge still cannot add or drop an object
		// unnoticed.
		expect([...v5Names].filter((name) => !currentNames.has(name))).toEqual([
			"error_spans",
			"error_spans_mv",
			"web_events",
			"web_events_mv",
		])
		expect([...currentNames].filter((name) => !v5Names.has(name))).toEqual([
			"ai_trace_index",
			"ai_trace_index_mv",
			"identity_links",
			"identity_links_mv",
			"product_events",
			"product_events_mv",
		])
		const errorEventsView = LOCAL_SCHEMA_MANIFEST.objects.find(
			(object) => object.name === "error_events_mv",
		)
		const errorEventsByTimeView = LOCAL_SCHEMA_MANIFEST.objects.find(
			(object) => object.name === "error_events_by_time_mv",
		)
		// Exception-less 4xx client spans (Cloudflare marks every non-2xx fetch
		// span Error) no longer materialize, and ids in the top stack line are
		// redacted out of the fingerprint frames.
		for (const view of [errorEventsView, errorEventsByTimeView]) {
			expect(view?.definition).toContain("_httpStatus >= 400 AND _httpStatus < 500")
			expect(view?.definition).toContain(":[0-9]+|line [0-9]+|0x[0-9a-fA-F]+|[0-9a-fA-F]{8,}|[0-9]{6,}")
		}
		const v5ErrorEventsView = LOCAL_SCHEMA_V5_MANIFEST.objects.find(
			(object) => object.name === "error_events_mv",
		)
		expect(v5ErrorEventsView?.definition).not.toContain("_httpStatus")

		// v11 replaces web_events with product_events, adds identity_links, and
		// widens session_events by the three identity columns. Asserted against
		// the frozen v10 manifest, same as above.
		const productEvents = LOCAL_SCHEMA_MANIFEST.objects.find((object) => object.name === "product_events")
		expect(productEvents?.engine).toBe("MergeTree")
		expect(productEvents?.orderBy).toBe("(OrgId, Timestamp, VisitorId, SessionId, Seq)")
		expect(productEvents?.ttl).toContain("365 DAY")
		expect(productEvents?.indexes).toEqual(["idx_event_name", "idx_user_id"])
		expect(productEvents?.columns.map((column) => column.name)).toEqual([
			"OrgId",
			"Timestamp",
			"Source",
			"SessionId",
			"Seq",
			"VisitorId",
			"UserId",
			"GroupId",
			"Kind",
			"EventName",
			"Host",
			"PagePath",
			"Url",
			"ServiceName",
			"Attributes",
		])
		const productEventsView = LOCAL_SCHEMA_MANIFEST.objects.find(
			(object) => object.name === "product_events_mv",
		)
		expect(productEventsView?.definition).toContain("FROM session_events")
		expect(productEventsView?.definition).toContain("'browser' AS Source")
		const identityLinks = LOCAL_SCHEMA_MANIFEST.objects.find((object) => object.name === "identity_links")
		// Aggregating, not Replacing: the funnel ranks a visitor's linked users by
		// `FirstSeen`, so the merge has to keep the pair's EARLIEST sighting. A
		// Replacing merge with no version column keeps an arbitrary duplicate and
		// the ranking flips as merges land.
		expect(identityLinks?.engine).toBe("AggregatingMergeTree")
		expect(identityLinks?.orderBy).toBe("(OrgId, VisitorId, UserId)")
		const identityLinksView = LOCAL_SCHEMA_MANIFEST.objects.find(
			(object) => object.name === "identity_links_mv",
		)
		expect(identityLinksView?.definition).toContain("FROM session_replays")
		const sessionEventColumns = (manifest: LocalSchemaManifest) =>
			manifest.objects
				.find((object) => object.name === "session_events")
				?.columns.map((column) => column.name) ?? []
		expect(sessionEventColumns(LOCAL_SCHEMA_V10_MANIFEST)).not.toContain("VisitorId")
		expect(sessionEventColumns(LOCAL_SCHEMA_MANIFEST).slice(-3)).toEqual([
			"VisitorId",
			"UserId",
			"GroupId",
		])
		const v10Names = new Set(LOCAL_SCHEMA_V10_MANIFEST.objects.map((object) => object.name))
		// The frozen v11 manifest, not the current one: v14 adds objects of its
		// own, and this assertion pins what v11 itself introduced.
		const v11Names = new Set(LOCAL_SCHEMA_V11_MANIFEST.objects.map((object) => object.name))
		expect([...v11Names].filter((name) => !v10Names.has(name))).toEqual([
			"identity_links",
			"identity_links_mv",
			"product_events",
			"product_events_mv",
		])
		expect([...v10Names].filter((name) => !v11Names.has(name))).toEqual(["web_events", "web_events_mv"])

		// v12 replaces two view bodies and v13 adds columns to two rollups; neither
		// adds an object. v14 is exactly the GenAI span index and its view, created
		// empty and filled forward.
		const v12Names = new Set(LOCAL_SCHEMA_V12_MANIFEST.objects.map((object) => object.name))
		const v13Names = new Set(LOCAL_SCHEMA_V13_MANIFEST.objects.map((object) => object.name))
		const currentSchemaNames = new Set(LOCAL_SCHEMA_MANIFEST.objects.map((object) => object.name))
		expect([...v12Names].filter((name) => !v11Names.has(name))).toEqual([])
		expect([...v13Names].filter((name) => !v12Names.has(name))).toEqual([])
		expect([...v12Names].filter((name) => !v13Names.has(name))).toEqual([])
		expect([...currentSchemaNames].filter((name) => !v13Names.has(name))).toEqual([
			"ai_trace_index",
			"ai_trace_index_mv",
		])
		expect([...v13Names].filter((name) => !currentSchemaNames.has(name))).toEqual([])
		const aiTraceIndex = LOCAL_SCHEMA_MANIFEST.objects.find(
			(object) => object.name === "ai_trace_index",
		)
		expect(aiTraceIndex?.engine).toBe("MergeTree")
		expect(aiTraceIndex?.orderBy).toBe("(OrgId, Timestamp, TraceId)")
		const aiTraceIndexView = LOCAL_SCHEMA_MANIFEST.objects.find(
			(object) => object.name === "ai_trace_index_mv",
		)
		// Reads raw traces with the vendor stamp as its write filter — the same
		// predicate Agent Sessions detection used to scan for at read time.
		expect(aiTraceIndexView?.definition).toContain("FROM traces")
		expect(aiTraceIndexView?.definition).toContain("SpanAttributes['maple_ai.vendor.id'] != ''")
	})

	it("recognises Apple crash frames at v8 but not before", () => {
		const applePattern = "^[0-9]+ +\\\\S.* +0x[0-9a-fA-F]+"
		for (const name of ["error_events_mv", "error_events_by_time_mv"]) {
			const view = LOCAL_SCHEMA_MANIFEST.objects.find((object) => object.name === name)
			expect(view?.definition).toContain(applePattern)
		}
		// v7 matched no Apple frame at all, so every iOS crash fell through to the
		// message hash and collapsed into one issue per exception type.
		const v7View = LOCAL_SCHEMA_V7_MANIFEST.objects.find((object) => object.name === "error_events_mv")
		expect(v7View?.definition).not.toContain(applePattern)
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
			"local-0004-to-0005-service-overview-minutely",
			"local-0005-to-0006-error-events-fingerprint-hygiene",
			"local-0006-to-0007-error-service-version",
			"local-0007-to-0008-apple-crash-frames",
			"local-0008-to-0009-mv-sweep",
			"local-0009-to-0010-semconv-key-renames",
			"local-0010-to-0011-product-events",
			"local-0011-to-0012-service-map-edge-quantiles",
			"local-0012-to-0013-service-operations-discriminators",
			"local-0013-to-0014-ai-trace-index",
			"local-0014-to-0015-commit-sha-vcs-revision",
			"local-0015-to-0016-ai-trace-index-filter-columns",
			"local-0016-to-0017-error-events-attribute-fallback",
		])
		expect(chain[0]?.from.fingerprint).toBe(LEGACY_SCHEMA_FINGERPRINT)
		expect(chain[0]?.to).toEqual(LOCAL_SCHEMA_V1)
		expect(chain[1]?.to).toEqual(LOCAL_SCHEMA_V2)
		expect(chain[2]?.to).toEqual(LOCAL_SCHEMA_V3)
		expect(chain[3]?.to).toEqual(LOCAL_SCHEMA_V4)
		expect(chain[4]?.to).toEqual(LOCAL_SCHEMA_V5)
		expect(chain[5]?.to).toEqual(LOCAL_SCHEMA_V6)
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
				// One past the current tip — bump alongside LOCAL_SCHEMA_VERSION, or this
				// stops testing the future-store guard and starts testing the
				// unknown-fingerprint one.
				{ ...CURRENT_LOCAL_SCHEMA, version: 18, fingerprint: "future", digest: SCHEMA_DIGEST },
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
		} as MigrationModuleContext
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
			// The message is the schema's, so this asserts the failing field rather
			// than the phrasing: an array where the inventory map belongs.
			await expect(readMigrationJournal(dataDir)).rejects.toThrow(/sourceInventory/)
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
						...(resumeSecondStep ? { state: { module: first.id, version: 1 } } : undefined),
					},
					{
						id: second.id,
						moduleVersion: 1,
						from: second.from,
						to: second.to,
						status: resumeSecondStep ? "verified" : "pending",
						...(resumeSecondStep
							? {
									state: { module: second.id, version: 1 },
									progress: { rows: 1 },
								}
							: undefined),
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

describe("v7 -> v8 journal state decoding", () => {
	const RAW_TABLES = [
		"logs",
		"traces",
		"metrics_sum",
		"metrics_gauge",
		"metrics_histogram",
		"metrics_exponential_histogram",
	]
	const rawRows = Object.fromEntries(RAW_TABLES.map((table) => [table, "12"]))
	const state = { module: "local-0007-to-0008-apple-crash-frames", version: 1, rawRows }

	it("round-trips a valid state, with and without a retention floor", () => {
		expect(v7ToV8AppleCrashFramesModule.decodeState(state)).toEqual(state)
		expect(v7ToV8AppleCrashFramesModule.decodeState({ ...state, retentionDays: 90 })).toEqual({
			...state,
			retentionDays: 90,
		})
	})

	it("rejects a field this build does not know about", () => {
		// A journal carrying an unknown field was written by a different build.
		// Dropping it silently would resume someone else's migration under our
		// assumptions.
		expect(() => v7ToV8AppleCrashFramesModule.decodeState({ ...state, somethingElse: 1 })).toThrow()
	})

	it("rejects another module's state", () => {
		expect(() =>
			v7ToV8AppleCrashFramesModule.decodeState({
				...state,
				module: "local-0006-to-0007-error-service-version",
			}),
		).toThrow()
		expect(() => v7ToV8AppleCrashFramesModule.decodeState({ ...state, version: 2 })).toThrow()
	})

	it("rejects row counts that are not unsigned decimal strings", () => {
		// They are strings precisely because a count can exceed
		// Number.MAX_SAFE_INTEGER, so anything lossy has to fail loudly.
		for (const bad of [12, "-1", "1.5", "1e3", ""]) {
			expect(() =>
				v7ToV8AppleCrashFramesModule.decodeState({ ...state, rawRows: { ...rawRows, logs: bad } }),
			).toThrow()
		}
	})

	it("rejects a missing or unknown raw table", () => {
		const { logs: _dropped, ...missing } = rawRows
		expect(() => v7ToV8AppleCrashFramesModule.decodeState({ ...state, rawRows: missing })).toThrow()
		expect(() =>
			v7ToV8AppleCrashFramesModule.decodeState({ ...state, rawRows: { ...rawRows, not_a_table: "1" } }),
		).toThrow()
	})

	it("rejects a non-integer retention floor", () => {
		expect(() => v7ToV8AppleCrashFramesModule.decodeState({ ...state, retentionDays: 1.5 })).toThrow()
	})

	it("decodes progress, and treats absent progress as absent", () => {
		expect(v7ToV8AppleCrashFramesModule.decodeProgress(undefined)).toBeUndefined()
		expect(v7ToV8AppleCrashFramesModule.decodeProgress({ installed: true })).toEqual({ installed: true })
		expect(() => v7ToV8AppleCrashFramesModule.decodeProgress({ installed: false })).toThrow()
		expect(() => v7ToV8AppleCrashFramesModule.decodeProgress({})).toThrow()
	})
})

/**
 * Characterization of the legacy raw-replay journal decoder.
 *
 * It guards a resumable copy out of a pre-v1 store: a journal it wrongly
 * accepts resumes someone else's copy under this build's assumptions, and one
 * it wrongly rejects strands a user mid-migration. Only one case was pinned
 * before this, so these lock the accept/reject boundary in place.
 */
describe("legacy raw replay progress decoding", () => {
	const inventory = {
		table: "logs",
		rowCount: "10",
		retentionStartAt: "2026-01-01 00:00:00",
		minTime: null,
		maxTime: null,
		hashSum: "1",
		hashXor: "2",
	}
	const copied = {
		rows: 1,
		bytes: 2,
		lastTimestamp: null,
		lastHash: "12",
		lastTieBreak: "13",
		duplicateCount: 0,
		duplicateGroupExhausted: false,
	}
	const pendingBatch = {
		table: "logs",
		rowCount: 1,
		byteLength: 2,
		firstTimestamp: null,
		firstHash: "1",
		firstTieBreak: "2",
		lastTimestamp: null,
		lastHash: "3",
		lastTieBreak: "4",
		lastKeyCount: 1,
		lastKeyExhausted: false,
		signature: "a".repeat(64),
	}
	const progress = { sourceInventory: { logs: inventory }, copied: { logs: copied } }
	const decode = (value: unknown) => legacyToCurrentModule.decodeProgress(value)

	it("accepts a well-formed progress, with and without a pending batch", () => {
		expect(decode(progress)).toEqual(progress)
		expect(decode({ ...progress, pendingBatch })).toEqual({ ...progress, pendingBatch })
		// Absent progress is "not started", which is not the same as invalid.
		expect(decode(undefined)).toBeUndefined()
	})

	it("rejects a non-object, and unknown top-level fields", () => {
		for (const bad of [null, [], "x", 1]) expect(() => decode(bad)).toThrow()
		expect(() => decode({ ...progress, somethingElse: 1 })).toThrow()
	})

	it("rejects tables that are not registered raw tables", () => {
		expect(() => decode({ ...progress, sourceInventory: { not_a_table: inventory } })).toThrow()
		expect(() => decode({ ...progress, copied: { not_a_table: copied } })).toThrow()
		expect(() =>
			decode({ ...progress, pendingBatch: { ...pendingBatch, table: "not_a_table" } }),
		).toThrow()
	})

	it("rejects an inventory whose table disagrees with its key", () => {
		expect(() =>
			decode({ ...progress, sourceInventory: { logs: { ...inventory, table: "traces" } } }),
		).toThrow()
	})

	it("rejects cursors that are not unsigned decimal strings", () => {
		// These are interpolated into numeric SQL comparisons, so anything that
		// could change their meaning has to fail here rather than there.
		for (const bad of ["-1", "1.5", "0x10", "", 12]) {
			expect(() => decode({ ...progress, copied: { logs: { ...copied, lastHash: bad } } })).toThrow()
		}
		// null is a legitimate "no cursor yet".
		expect(decode({ ...progress, copied: { logs: { ...copied, lastHash: null } } })).toBeDefined()
	})

	it("rejects counters that are not non-negative safe integers", () => {
		for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2, "1", null]) {
			expect(() => decode({ ...progress, copied: { logs: { ...copied, rows: bad } } })).toThrow()
		}
	})

	it("rejects a non-boolean exhaustion flag", () => {
		expect(() =>
			decode({ ...progress, copied: { logs: { ...copied, duplicateGroupExhausted: "no" } } }),
		).toThrow()
	})

	it("rejects a pending batch that is empty or wrongly signed", () => {
		// An empty batch would commit nothing while advancing the cursor past it.
		expect(() => decode({ ...progress, pendingBatch: { ...pendingBatch, rowCount: 0 } })).toThrow()
		for (const bad of ["a".repeat(63), "z".repeat(64), ""]) {
			expect(() => decode({ ...progress, pendingBatch: { ...pendingBatch, signature: bad } })).toThrow()
		}
	})

	it("rejects missing fields anywhere in the tree", () => {
		const { hashSum: _h, ...shortInventory } = inventory
		expect(() => decode({ ...progress, sourceInventory: { logs: shortInventory } })).toThrow()
		const { rows: _r, ...shortCopied } = copied
		expect(() => decode({ ...progress, copied: { logs: shortCopied } })).toThrow()
	})
})

describe("v10 -> v11 product events module", () => {
	const rawRows = {
		logs: "1",
		traces: "2",
		metrics_sum: "0",
		metrics_gauge: "0",
		metrics_histogram: "0",
		metrics_exponential_histogram: "0",
	}
	const state = {
		module: "local-0010-to-0011-product-events",
		version: 1,
		rawRows,
		sourceRows: { browserEvents: "3", identityPairs: "2" },
	}

	it("binds the frozen v10 and v11 identities and never the current constant", () => {
		expect(v10ToV11ProductEventsModule.from).toEqual(LOCAL_SCHEMA_V10)
		expect(v10ToV11ProductEventsModule.to).toEqual(LOCAL_SCHEMA_V11)
		expect(v10ToV11ProductEventsModule.from).not.toBe(CURRENT_LOCAL_SCHEMA)
		expect(v10ToV11ProductEventsModule.operations.map((operation) => operation.id)).toEqual([
			"clone-v10-store",
			"add-session-event-identity",
			"install-product-events",
			"verify-v11-schema",
		])
		// The chain must reach v11 through this module and only this module.
		const chain = resolveMigrationChain(LOCAL_SCHEMA_V10, CURRENT_LOCAL_SCHEMA)
		expect(chain.map((migration) => migration.id)).toEqual([
			"local-0010-to-0011-product-events",
			"local-0011-to-0012-service-map-edge-quantiles",
			"local-0012-to-0013-service-operations-discriminators",
			"local-0013-to-0014-ai-trace-index",
			"local-0014-to-0015-commit-sha-vcs-revision",
			"local-0015-to-0016-ai-trace-index-filter-columns",
			"local-0016-to-0017-error-events-attribute-fallback",
		])
		expect(chain[0]?.to).toEqual(LOCAL_SCHEMA_V11)
		// The dropped table is declared, and the backfilled ones say what they
		// are rebuilt from.
		const dispositions = new Map(
			v10ToV11ProductEventsModule.dispositions.map((entry) => [entry.name, entry.disposition]),
		)
		expect(dispositions.get("web_events")).toBe("invalidate")
		expect(dispositions.get("product_events")).toBe("rebuild-complete")
		expect(dispositions.get("identity_links")).toBe("rebuild-complete")
		expect(dispositions.get("session_events")).toBe("preserve-exact")
	})

	it("decodes only its own well-formed persisted state", () => {
		expect(v10ToV11ProductEventsModule.decodeState(state)).toEqual(state)
		expect(v10ToV11ProductEventsModule.decodeState({ ...state, retentionDays: 120 })).toEqual({
			...state,
			retentionDays: 120,
		})
		expect(() =>
			v10ToV11ProductEventsModule.decodeState({
				...state,
				module: "local-0009-to-0010-semconv-key-renames",
			}),
		).toThrow(/unsupported module or version/)
		expect(() => v10ToV11ProductEventsModule.decodeState({ ...state, version: 2 })).toThrow(
			/unsupported module or version/,
		)
		expect(() => v10ToV11ProductEventsModule.decodeState({ ...state, extra: true })).toThrow(
			/unknown field/,
		)
		expect(() => v10ToV11ProductEventsModule.decodeState({ ...state, retentionDays: "120" })).toThrow(
			/retentionDays must be an integer/,
		)
		expect(() =>
			v10ToV11ProductEventsModule.decodeState({ ...state, rawRows: { ...rawRows, logs: "-1" } }),
		).toThrow(/rawRows.logs/)
		expect(() =>
			v10ToV11ProductEventsModule.decodeState({ ...state, rawRows: { ...rawRows, web_events: "1" } }),
		).toThrow(/unknown table/)
		// The backfill counts are part of the resume key: a state without them
		// cannot verify, so it must not decode.
		const { sourceRows: _sourceRows, ...withoutSourceRows } = state
		expect(() => v10ToV11ProductEventsModule.decodeState(withoutSourceRows)).toThrow(
			/sourceRows must be an object/,
		)
		expect(() =>
			v10ToV11ProductEventsModule.decodeState({ ...state, sourceRows: { browserEvents: "3" } }),
		).toThrow(/identityPairs/)
		expect(() =>
			v10ToV11ProductEventsModule.decodeState({
				...state,
				sourceRows: { browserEvents: 3, identityPairs: "2" },
			}),
		).toThrow(/browserEvents/)
		expect(() =>
			v10ToV11ProductEventsModule.decodeState({
				...state,
				sourceRows: { browserEvents: "3", identityPairs: "2", webEvents: "0" },
			}),
		).toThrow(/unknown field/)
	})

	it("decodes progress as the single installed marker", () => {
		expect(v10ToV11ProductEventsModule.decodeProgress(undefined)).toBeUndefined()
		expect(v10ToV11ProductEventsModule.decodeProgress({ installed: true })).toEqual({ installed: true })
		expect(() => v10ToV11ProductEventsModule.decodeProgress({ installed: false })).toThrow(/invalid/)
		expect(() => v10ToV11ProductEventsModule.decodeProgress({ installed: true, rows: 1 })).toThrow(
			/invalid/,
		)
	})

	it("recovers by keeping whatever state and progress were persisted", async () => {
		const progress = { installed: true } as const
		await expect(
			v10ToV11ProductEventsModule.recover({} as MigrationModuleContext, state as never, progress),
		).resolves.toEqual({ state, progress })
	})
})

describe("legacy raw replay fetch bounds", () => {
	const tracesTable = LEGACY_RAW_TABLES[1]

	it("seeds the first fetch small instead of materializing batchRows full rows", () => {
		expect(nextFetchRowLimit(tracesTable, 0, 0)).toBe(128)
	})

	it("grows toward batchRows for small rows and shrinks for huge rows", () => {
		// 128 rows of ~200 bytes: the budget allows far more — clamp to batchRows.
		expect(nextFetchRowLimit(tracesTable, 128, 128 * 200)).toBe(tracesTable.batchRows)
		// 4 rows of ~8 MiB: even one row overshoots the budget — floor at 1.
		expect(nextFetchRowLimit(tracesTable, 4, 4 * 8 * 1024 * 1024)).toBe(1)
		// ~64 KiB rows: the limit lands near budget/rowBytes, never above batchRows.
		const limit = nextFetchRowLimit(tracesTable, 100, 100 * 64 * 1024)
		expect(limit).toBeGreaterThanOrEqual(64)
		expect(limit).toBeLessThanOrEqual(128)
	})
})

describe("legacy raw replay 64-bit exactness", () => {
	it("requests quoted 64-bit output and reinserts a >2^53 UInt64 verbatim", async () => {
		const bigDuration = "9007199254740993" // 2^53 + 1: rounds to ...992 as a JS number
		const sourceQueries: string[] = []
		const targetStatements: string[] = []
		let call = 0
		const fakeSourceDb = {
			query: (sql: string): string => {
				sourceQueries.push(sql)
				call += 1
				if (call > 1) return ""
				return `${JSON.stringify({
					Timestamp: "2026-08-30 12:00:00.000000000",
					Duration: bigDuration,
					__maple_timestamp: "1756555200000000000",
					__maple_hash: "18446744073709551615",
					__maple_tie_break: "3",
				})}\n`
			},
		}
		const fakeTargetDb = {
			query: (sql: string): string => {
				targetStatements.push(sql)
				return ""
			},
			exec: (sql: string): void => {
				targetStatements.push(sql)
			},
		}
		const context = {
			dataDir: "/tmp/fake",
			sourceDataDir: "/tmp/fake-source",
			targetDataDir: "/tmp/fake-target",
			source: LEGACY_LOCAL_SCHEMA,
			target: LOCAL_SCHEMA_V1,
			cutoffAt: "2026-08-31T00:00:00.000Z",
			step: {
				id: "local-0000-to-0001-raw-replay",
				moduleVersion: 1,
				from: LEGACY_LOCAL_SCHEMA,
				to: LOCAL_SCHEMA_V1,
				status: "running" as const,
			},
			openSource: async (fn: (db: typeof fakeSourceDb) => string | Promise<string>) => fn(fakeSourceDb),
			openTarget: async (fn: (db: typeof fakeTargetDb) => string | void | Promise<string | void>) =>
				fn(fakeTargetDb),
			closeStores: async () => undefined,
			ensureCapacity: async () => undefined,
			saveStep: async () => undefined,
		} as MigrationModuleContext
		const columns = [
			{ name: "Timestamp", type: "DateTime64(9)" },
			{ name: "Duration", type: "UInt64" },
		]
		const initial: RawReplayProgress = { sourceInventory: {}, copied: {} }
		await legacyTestables.copyTable(context, LEGACY_RAW_TABLES[1], columns, initial)

		// The source SELECT must override the connection-wide unquoted 64-bit
		// output; without it chDB emits Duration as a JSON number and the decode
		// below would round it before reinsertion.
		expect(sourceQueries[0]).toContain("SETTINGS output_format_json_quote_64bit_integers = 1")
		const insert = targetStatements.find((sql) => sql.startsWith("INSERT INTO"))
		expect(insert).toBeDefined()
		expect(insert).toContain(`"Duration":"${bigDuration}"`)
	})
})

describe("clone-based staging excludes the checkpoint registry", () => {
	it("clones store contents but never <dataDir>/backups", async () => {
		const root = await mkdtemp(join(tmpdir(), "maple-clone-staging-"))
		try {
			const source = join(root, "source")
			const target = join(root, "target", "data")
			await mkdir(join(source, "store", "parts"), { recursive: true })
			await mkdir(join(source, "backups", "snapshots", "cp-1"), { recursive: true })
			const { writeFile } = await import("node:fs/promises")
			await writeFile(join(source, "store", "parts", "part.bin"), "data")
			await writeFile(join(source, "backups", "state.json"), "{}")
			await writeFile(
				join(source, "backups", "snapshots", "cp-1", "manifest.json"),
				// A copied manifest pins the OLD schema fingerprint: post-promotion it
				// fails resolution and marks the registry "unusable", blocking the new
				// checkpoint the migration instructs the user to create.
				JSON.stringify({ schemaFingerprint: "stale" }),
			)
			const { cloneStoreForStaging } =
				await import("../src/server/local-store-migrations/journal-codecs")
			await cloneStoreForStaging(source, target)
			const { existsSync } = await import("node:fs")
			expect(existsSync(join(target, "store", "parts", "part.bin"))).toBe(true)
			expect(existsSync(join(target, "backups"))).toBe(false)
			// The registry stays with the retained rollback source.
			expect(existsSync(join(source, "backups", "state.json"))).toBe(true)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})

describe("migration journal creation is lock-serialized", () => {
	it("does not create a journal while another maintenance operation holds the lock", async () => {
		const root = await mkdtemp(join(tmpdir(), "maple-migration-lock-order-"))
		try {
			const dataDir = join(root, "data")
			await mkdir(join(dataDir, "store"), { recursive: true })
			const { writeFile } = await import("node:fs/promises")
			await writeFile(
				storeMarkerPath(dataDir),
				`${JSON.stringify({
					chdb: (await import("../src/version")).CHDB_VERSION,
					maple: "test",
					createdAt: "2026-08-30T00:00:00.000Z",
					schema: LEGACY_LOCAL_SCHEMA.fingerprint,
				})}\n`,
			)
			const { withMaintenanceLock } = await import("../src/server/checkpoints")
			const { randomUUID } = await import("node:crypto")
			await withMaintenanceLock(dataDir, randomUUID(), async () => {
				// A concurrent migrate must fail at the lock WITHOUT having written
				// the canonical journal first — journal creation used to happen
				// before lock acquisition and could clobber a running migration's
				// journal with a fresh one under a different migration id.
				await expect(runLocalStoreMigration({ dataDir })).rejects.toThrow(
					/another Maple maintenance operation is active/,
				)
			})
			const { existsSync } = await import("node:fs")
			expect(existsSync(migrationJournalPath(dataDir))).toBe(false)
			// And no orphaned migration root either.
			expect(existsSync(join(root, ".maple-migrations"))).toBe(false)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
