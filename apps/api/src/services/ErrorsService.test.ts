import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, expect, it } from "@effect/vitest"
import { Clock, ConfigProvider, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
	ErrorPersistenceError,
	IssueEscalationPolicyRule,
	IssueEscalationPolicyUpsertRequest,
	OrgId,
	UserId,
} from "@maple/domain/http"
import {
	AlertDestinationId,
	ErrorIncidentId,
	ErrorIssueEventId,
	ErrorIssueId,
} from "@maple/domain/primitives"
import {
	alertDestinations,
	errorIncidents,
	errorIssues,
	errorIssueEvents,
	errorIssueStates,
	issueEscalations,
	orgIngestKeys,
} from "@maple/db"
import { eq } from "drizzle-orm"
import type { CompiledQuery } from "@maple/query-engine/ch"
import { EdgeCacheService, makeEdgeCacheService, makeMemoryBackend } from "@maple/query-engine/caching"
import { Database, DatabaseError } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "../lib/test-pglite"
import type { SqlQueryOptions, WarehouseQueryServiceShape } from "../lib/WarehouseQueryService"
import { WarehouseQueryService } from "../lib/WarehouseQueryService"
import { describeCause, ErrorsService, isBusyDatabaseError, makePersistenceError } from "./ErrorsService"
import { NotificationDispatcher } from "./NotificationDispatcher"

describe("makePersistenceError", () => {
	it("omits the cause key when the source has no cause", () => {
		const err = makePersistenceError(new Error("boom"))
		expect("cause" in err).toBe(false)
		expect(err.message).toBe("boom")
	})

	it("includes cause when the source carries one", () => {
		const inner = new Error("inner")
		const outer = new Error("boom", { cause: inner })
		const err = makePersistenceError(outer)
		expect(typeof err.cause).toBe("string")
		expect(err.cause).toContain("inner")
	})

	it("survives a Schema round-trip when cause is absent", () => {
		const err = makePersistenceError(new Error("boom"))
		const encoded = Schema.encodeSync(ErrorPersistenceError)(err)
		const decoded = Schema.decodeUnknownSync(ErrorPersistenceError)(encoded)
		expect("cause" in decoded).toBe(false)
		expect(decoded.message).toBe("boom")
	})
})

describe("describeCause", () => {
	it("returns undefined for null/undefined", () => {
		expect(describeCause(null)).toBeUndefined()
		expect(describeCause(undefined)).toBeUndefined()
	})

	it("returns the message/stack for Error instances", () => {
		const e = new Error("x")
		expect(describeCause(e)).toContain("x")
	})

	it("returns the string itself for string causes", () => {
		expect(describeCause("oops")).toBe("oops")
	})
})

describe("isBusyDatabaseError", () => {
	const makeError = (message: string, cause: unknown = null) => new DatabaseError({ message, cause })

	it("matches SQLITE_BUSY in message", () => {
		expect(isBusyDatabaseError(makeError("SQLITE_BUSY: database is locked"))).toBe(true)
	})

	it("matches D1_BUSY in message", () => {
		expect(isBusyDatabaseError(makeError("D1_BUSY: write conflict"))).toBe(true)
	})

	it("matches busy pattern in nested cause", () => {
		const cause = new Error("internal SQLITE_BUSY trying to commit")
		expect(isBusyDatabaseError(makeError("wrapper", cause))).toBe(true)
	})

	it("rejects unrelated database errors", () => {
		expect(isBusyDatabaseError(makeError("UNIQUE constraint failed"))).toBe(false)
		expect(isBusyDatabaseError(makeError("no such table"))).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// libsql-backed integration harness (fresh temp DB per test)
// ---------------------------------------------------------------------------

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3478",
			MCP_PORT: "3479",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

/**
 * Typed warehouse stub. The scheduled tick is the only consumer that reaches
 * the warehouse in these tests, so the stub feeds synthetic `errorIssuesScan`
 * rows (shaped like `ErrorIssuesOutput`) through the compiled query's own
 * `castRows`, and returns empty results for every other compiled query.
 */
const makeWarehouseStub = (
	scanRows: () => ReadonlyArray<Record<string, unknown>> = () => [],
	onScan?: () => void,
): WarehouseQueryServiceShape => ({
	query: () => Effect.die(new Error("unexpected warehouse query")),
	sqlQuery: () => Effect.succeed([]),
	compiledQuery: <T>(tenant: unknown, compiled: CompiledQuery<T>, options?: SqlQueryOptions) =>
		Effect.sync(() => {
			if (options?.context === "errorIssuesScan") {
				onScan?.()
				return compiled.castRows(scanRows())
			}
			// Active-org discovery reads the same data the scan does, so model that
			// consistency: surface the org iff it currently has error rows.
			if (options?.context === "errorActiveOrgsDiscovery") {
				const orgId = (tenant as { orgId?: string }).orgId ?? ""
				return compiled.castRows(scanRows().length > 0 ? [{ orgId }] : [])
			}
			return compiled.castRows([])
		}),
	compiledQueryFirst: () => Effect.die(new Error("unexpected warehouse query")),
	ingest: () => Effect.void,
	asExecutor: () => {
		throw new Error("asExecutor is not supported by this test stub")
	},
})

const makeErrorsLayer = (scanRows?: () => ReadonlyArray<Record<string, unknown>>, onScan?: () => void) => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	const databaseLive = testDb.layer
	const dispatcherStub = Layer.succeed(NotificationDispatcher, {
		dispatch: () => Effect.succeed({ delivered: 0, failed: 0 }),
	})
	return ErrorsService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				envLive,
				databaseLive,
				Layer.succeed(WarehouseQueryService, makeWarehouseStub(scanRows, onScan)),
				Layer.succeed(EdgeCacheService, makeEdgeCacheService(makeMemoryBackend())),
				dispatcherStub,
			),
		),
		Layer.provideMerge(databaseLive),
	)
}

/**
 * Layer variant for active-org gating tests. Lets a test force discovery to
 * FAIL (to exercise the fail-CLOSED path) and/or capture the cost `profile`
 * each query context was issued with.
 */
const makeGatingLayer = (opts: {
	failDiscovery?: boolean
	scanRows?: () => ReadonlyArray<Record<string, unknown>>
	scanned?: Set<string>
	profiles?: Map<string, string | undefined>
}) => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	const databaseLive = testDb.layer
	const dispatcherStub = Layer.succeed(NotificationDispatcher, {
		dispatch: () => Effect.succeed({ delivered: 0, failed: 0 }),
	})
	const scanRows = opts.scanRows ?? (() => [])
	const warehouseStub: WarehouseQueryServiceShape = {
		query: () => Effect.die(new Error("unexpected warehouse query")),
		sqlQuery: () => Effect.succeed([]),
		compiledQuery: <T>(tenant: unknown, compiled: CompiledQuery<T>, options?: SqlQueryOptions) => {
			if (options?.context) opts.profiles?.set(options.context, options.profile)
			if (options?.context === "errorActiveOrgsDiscovery") {
				if (opts.failDiscovery) return Effect.die(new Error("discovery down"))
				const orgId = (tenant as { orgId?: string }).orgId ?? ""
				return Effect.sync(() => compiled.castRows(scanRows().length > 0 ? [{ orgId }] : []))
			}
			if (options?.context === "errorIssuesScan") {
				const orgId = (tenant as { orgId?: string }).orgId ?? ""
				return Effect.sync(() => {
					opts.scanned?.add(orgId)
					return compiled.castRows(scanRows())
				})
			}
			return Effect.sync(() => compiled.castRows([]))
		},
		compiledQueryFirst: () => Effect.die(new Error("unexpected warehouse query")),
		ingest: () => Effect.void,
		asExecutor: () => {
			throw new Error("asExecutor is not supported by this test stub")
		},
	}
	return ErrorsService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				envLive,
				databaseLive,
				Layer.succeed(WarehouseQueryService, warehouseStub),
				Layer.succeed(EdgeCacheService, makeEdgeCacheService(makeMemoryBackend())),
				dispatcherStub,
			),
		),
		Layer.provideMerge(databaseLive),
	)
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asIssueId = Schema.decodeUnknownSync(ErrorIssueId)
const asIncidentId = Schema.decodeUnknownSync(ErrorIncidentId)
const asEventId = Schema.decodeUnknownSync(ErrorIssueEventId)
const asDestinationId = Schema.decodeUnknownSync(AlertDestinationId)
const asJsonRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))

const ORG = asOrgId("org_errors_service_test")
const USER = asUserId("user_errors_service_test")

const seedIssue = (issueId: ErrorIssueId, overrides: Partial<typeof errorIssues.$inferInsert> = {}) =>
	Effect.gen(function* () {
		const database = yield* Database
		const now = yield* Clock.currentTimeMillis
		yield* database.execute((db) =>
			db.insert(errorIssues).values({
				id: issueId,
				orgId: ORG,
				fingerprintHash: `fp-${issueId}`,
				serviceName: "checkout-api",
				exceptionType: "TimeoutError",
				exceptionMessage: "upstream timed out",
				topFrame: "",
				firstSeenAt: new Date(now),
				lastSeenAt: new Date(now),
				createdAt: new Date(now),
				updatedAt: new Date(now),
				...overrides,
			}),
		)
	})

/** Make an org "known" via an ingest key only — no issues, no incident state. */
const seedIngestKey = (orgId: string) =>
	Effect.gen(function* () {
		const database = yield* Database
		const now = yield* Clock.currentTimeMillis
		yield* database.execute((db) =>
			db.insert(orgIngestKeys).values({
				orgId,
				publicKey: `pk_${orgId}`,
				publicKeyHash: `pkh_${orgId}`,
				privateKeyCiphertext: "ct",
				privateKeyIv: "iv",
				privateKeyTag: "tag",
				privateKeyHash: `prh_${orgId}`,
				publicRotatedAt: new Date(now),
				privateRotatedAt: new Date(now),
				createdAt: new Date(now),
				updatedAt: new Date(now),
				createdBy: "test",
				updatedBy: "test",
			}),
		)
	})

// ---------------------------------------------------------------------------
// setSeverity
// ---------------------------------------------------------------------------

describe("ErrorsService.setSeverity", () => {
	it.effect("sets a manual severity, records the event, and queues an escalation", () =>
		Effect.gen(function* () {
			const errors = yield* ErrorsService
			const database = yield* Database
			const issueId = asIssueId(randomUUID())
			yield* seedIssue(issueId)
			const actor = yield* errors.ensureUserActor(ORG, USER)

			const updated = yield* errors.setSeverity(ORG, actor.id, issueId, "critical", {
				note: "paging-worthy",
			})
			assert.strictEqual(updated.severity, "critical")
			assert.strictEqual(updated.severitySource, "manual")

			const events = yield* database.execute((db) =>
				db.select().from(errorIssueEvents).where(eq(errorIssueEvents.issueId, issueId)),
			)
			const severityEvents = events.filter((e) => e.type === "severity_change")
			assert.lengthOf(severityEvents, 1)
			expect(severityEvents[0]?.payloadJson).toMatchObject({
				to: "critical",
				source: "manual",
				note: "paging-worthy",
			})

			const escalations = yield* database.execute((db) =>
				db.select().from(issueEscalations).where(eq(issueEscalations.issueId, issueId)),
			)
			assert.lengthOf(escalations, 1)
			assert.strictEqual(escalations[0]?.source, "manual")
			assert.strictEqual(escalations[0]?.reason, "severity_set")
		}).pipe(Effect.provide(makeErrorsLayer())),
	)

	it.effect("an AI write never clobbers a manual severity", () =>
		Effect.gen(function* () {
			const errors = yield* ErrorsService
			const issueId = asIssueId(randomUUID())
			yield* seedIssue(issueId)
			const actor = yield* errors.ensureUserActor(ORG, USER)

			yield* errors.setSeverity(ORG, actor.id, issueId, "low")
			const afterAi = yield* errors.setSeverity(ORG, actor.id, issueId, "critical", {
				source: "ai",
			})
			assert.strictEqual(afterAi.severity, "low")
			assert.strictEqual(afterAi.severitySource, "manual")
		}).pipe(Effect.provide(makeErrorsLayer())),
	)

	it.effect("clearing severity nulls both fields and skips escalation", () =>
		Effect.gen(function* () {
			const errors = yield* ErrorsService
			const database = yield* Database
			const issueId = asIssueId(randomUUID())
			yield* seedIssue(issueId)
			const actor = yield* errors.ensureUserActor(ORG, USER)

			yield* errors.setSeverity(ORG, actor.id, issueId, "medium")
			const cleared = yield* errors.setSeverity(ORG, actor.id, issueId, null)
			assert.isNull(cleared.severity)
			assert.isNull(cleared.severitySource)

			const escalations = yield* database.execute((db) =>
				db.select().from(issueEscalations).where(eq(issueEscalations.issueId, issueId)),
			)
			// Only the initial "medium" set escalates; clearing routes nothing.
			assert.lengthOf(escalations, 1)
		}).pipe(Effect.provide(makeErrorsLayer())),
	)

	it.effect("upsertEscalationPolicy rejects destination IDs the org does not own", () =>
		Effect.gen(function* () {
			const errors = yield* ErrorsService
			const database = yield* Database
			const now = yield* Clock.currentTimeMillis
			const ownedId = asDestinationId(randomUUID())
			const foreignId = asDestinationId(randomUUID())
			yield* database.execute((db) =>
				db.insert(alertDestinations).values({
					id: ownedId,
					orgId: ORG,
					name: "Primary webhook",
					type: "webhook",
					enabled: true,
					configJson: {},
					secretCiphertext: "x",
					secretIv: "x",
					secretTag: "x",
					createdAt: new Date(now),
					updatedAt: new Date(now),
					createdBy: USER,
					updatedBy: USER,
				}),
			)

			const rejected = yield* errors
				.upsertEscalationPolicy(
					ORG,
					USER,
					new IssueEscalationPolicyUpsertRequest({
						enabled: true,
						rules: [
							new IssueEscalationPolicyRule({
								severity: "critical",
								destinationIds: [ownedId, foreignId],
							}),
						],
					}),
				)
				.pipe(Effect.flip)
			assert.strictEqual(rejected._tag, "@maple/http/errors/ErrorValidationError")
			if (rejected._tag === "@maple/http/errors/ErrorValidationError") {
				assert.include(rejected.details, foreignId)
				assert.notInclude(rejected.details, ownedId)
			}

			const accepted = yield* errors.upsertEscalationPolicy(
				ORG,
				USER,
				new IssueEscalationPolicyUpsertRequest({
					enabled: true,
					rules: [
						new IssueEscalationPolicyRule({ severity: "critical", destinationIds: [ownedId] }),
					],
				}),
			)
			assert.strictEqual(accepted.rules[0]?.destinationIds[0], ownedId)
		}).pipe(Effect.provide(makeErrorsLayer())),
	)

	it.effect("listIssues filters by severity and kind", () =>
		Effect.gen(function* () {
			const errors = yield* ErrorsService
			const database = yield* Database
			const issueId = asIssueId(randomUUID())
			yield* seedIssue(issueId)
			const actor = yield* errors.ensureUserActor(ORG, USER)
			yield* errors.setSeverity(ORG, actor.id, issueId, "high")

			const alertIssueId = asIssueId(randomUUID())
			const now = yield* Clock.currentTimeMillis
			yield* database.execute((db) =>
				db.insert(errorIssues).values({
					id: alertIssueId,
					orgId: ORG,
					kind: "alert",
					fingerprintHash: "alert:rule-1:checkout",
					serviceName: "checkout",
					exceptionType: "High latency",
					exceptionMessage: "p95_latency gte 800",
					topFrame: "",
					firstSeenAt: new Date(now),
					lastSeenAt: new Date(now),
					createdAt: new Date(now),
					updatedAt: new Date(now),
				}),
			)

			const high = yield* errors.listIssues(ORG, { severity: "high" })
			assert.deepStrictEqual(
				high.issues.map((i) => i.id),
				[issueId],
			)

			const unset = yield* errors.listIssues(ORG, { severity: "unset" })
			assert.deepStrictEqual(
				unset.issues.map((i) => i.id),
				[alertIssueId],
			)

			const alerts = yield* errors.listIssues(ORG, { kind: "alert" })
			assert.deepStrictEqual(
				alerts.issues.map((i) => i.id),
				[alertIssueId],
			)
			assert.strictEqual(alerts.issues[0]?.kind, "alert")
		}).pipe(Effect.provide(makeErrorsLayer())),
	)
})

// ---------------------------------------------------------------------------
// runTick — the per-minute scheduled tick that turns warehouse error rows
// into issues/incidents. The warehouse stub feeds synthetic scan rows; the
// TestClock pins the tick window.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000

// Multiple of TICK_WINDOW_MS * RETENTION_PHASE_EVERY_N_TICKS (2min * 30 = 1h),
// so a tick at exactly this instant runs the retention phase.
const RETENTION_TICK_MS = 1_750_003_200_000
// One tick later — the retention phase does not run.
const TICK_MS = RETENTION_TICK_MS + 120_000

/** Same format the tick itself sends to the warehouse ("YYYY-MM-DD HH:MM:SS", UTC). */
const toWarehouseDateTime = (epochMs: number) =>
	new Date(epochMs).toISOString().slice(0, 19).replace("T", " ")

/** Real error fingerprints are decimal UInt64 strings from ClickHouse. */
const SCAN_FINGERPRINT = "12345678901234567890"

const scanRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	fingerprintHash: SCAN_FINGERPRINT,
	serviceName: "checkout-api",
	exceptionType: "TimeoutError",
	exceptionMessage: "upstream timed out",
	errorLabel: "TimeoutError: upstream timed out",
	topFrame: "checkout/handler.ts:42",
	count: 3,
	affectedServicesCount: 1,
	firstSeen: toWarehouseDateTime(TICK_MS - 60_000),
	lastSeen: toWarehouseDateTime(TICK_MS - 1_000),
	...overrides,
})

const loadIssuesByFingerprint = (fingerprintHash: string) =>
	Effect.gen(function* () {
		const database = yield* Database
		return yield* database.execute((db) =>
			db.select().from(errorIssues).where(eq(errorIssues.fingerprintHash, fingerprintHash)),
		)
	})

const loadIncidentsForIssue = (issueId: ErrorIssueId) =>
	Effect.gen(function* () {
		const database = yield* Database
		return yield* database.execute((db) =>
			db.select().from(errorIncidents).where(eq(errorIncidents.issueId, issueId)),
		)
	})

const loadEventsForIssue = (issueId: ErrorIssueId) =>
	Effect.gen(function* () {
		const database = yield* Database
		return yield* database.execute((db) =>
			db.select().from(errorIssueEvents).where(eq(errorIssueEvents.issueId, issueId)),
		)
	})

describe("ErrorsService.runTick", () => {
	it.effect("with no known orgs the tick scans nothing and writes nothing", () =>
		Effect.gen(function* () {
			const errors = yield* ErrorsService
			yield* TestClock.setTime(TICK_MS)
			const result = yield* errors.runTick()
			assert.deepStrictEqual(result, {
				orgsProcessed: 0,
				issuesTouched: 0,
				incidentsOpened: 0,
				incidentsResolved: 0,
				issuesReopened: 0,
				issuesArchived: 0,
				issuesDeleted: 0,
				leasesExpired: 0,
				retentionRan: false,
			})
		}).pipe(Effect.provide(makeErrorsLayer())),
	)

	it.effect("an ingest-only org with no recent errors and no issue state is not scanned", () => {
		let scanCalls = 0
		return Effect.gen(function* () {
			const errors = yield* ErrorsService
			yield* TestClock.setTime(TICK_MS)
			// Known via an ingest key, but no errors and no issue state — and
			// discovery (empty scan rows) reports it inactive.
			yield* seedIngestKey(ORG)

			const result = yield* errors.runTick()
			// Counted as known, but the expensive warehouse scan is skipped.
			assert.strictEqual(result.orgsProcessed, 1)
			assert.strictEqual(scanCalls, 0)
		}).pipe(
			Effect.provide(
				makeErrorsLayer(
					() => [],
					() => {
						scanCalls += 1
					},
				),
			),
		)
	})

	it.effect("discovery failure fails CLOSED — stateful orgs scanned, idle orgs skipped", () => {
		const scanned = new Set<string>()
		const IDLE = asOrgId("org_idle_ingest_only")
		return Effect.gen(function* () {
			const errors = yield* ErrorsService
			yield* TestClock.setTime(TICK_MS)
			// ORG becomes known + stateful via an issue; IDLE is known via an ingest
			// key only (no issue, no incident state).
			yield* seedIssue(asIssueId(randomUUID()))
			yield* seedIngestKey(IDLE)

			yield* errors.runTick()

			// The stateful org is still scanned so resolution/aging keeps running…
			assert.isTrue(scanned.has(ORG))
			// …but the idle org is NOT scanned: no fan-out to every known org (the old
			// fail-OPEN behaviour would have scanned it via activeOrgs="all").
			assert.isFalse(scanned.has(IDLE))
		}).pipe(Effect.provide(makeGatingLayer({ failDiscovery: true, scanned })))
	})

	it.effect("discovery uses the 5s discovery profile; the per-org scan uses the list profile", () => {
		const profiles = new Map<string, string | undefined>()
		return Effect.gen(function* () {
			const errors = yield* ErrorsService
			yield* TestClock.setTime(TICK_MS)
			yield* seedIssue(asIssueId(randomUUID()))

			yield* errors.runTick()

			assert.strictEqual(profiles.get("errorActiveOrgsDiscovery"), "discovery")
			assert.strictEqual(profiles.get("errorIssuesScan"), "list")
		}).pipe(Effect.provide(makeGatingLayer({ scanRows: () => [scanRow()], profiles })))
	})

	it.effect(
		"a fresh scan row creates a triage issue, opens a first_seen incident, and records the created event",
		() => {
			const rows = [scanRow()]
			return Effect.gen(function* () {
				const errors = yield* ErrorsService
				const database = yield* Database
				yield* TestClock.setTime(TICK_MS)
				// Org discovery: the tick only scans orgs already present in the DB,
				// so seed an unrelated issue to make the org known.
				yield* seedIssue(asIssueId(randomUUID()))

				const result = yield* errors.runTick()
				assert.deepStrictEqual(result, {
					orgsProcessed: 1,
					issuesTouched: 1,
					incidentsOpened: 1,
					incidentsResolved: 0,
					issuesReopened: 0,
					issuesArchived: 0,
					issuesDeleted: 0,
					leasesExpired: 0,
					retentionRan: false,
				})

				const issues = yield* loadIssuesByFingerprint(SCAN_FINGERPRINT)
				assert.lengthOf(issues, 1)
				const issue = issues[0]!
				assert.strictEqual(issue.orgId, ORG)
				assert.strictEqual(issue.kind, "error")
				assert.strictEqual(issue.workflowState, "triage")
				// Tick-created issues start untriaged — no severity until AI/human sets one.
				assert.isNull(issue.severity)
				assert.isNull(issue.severitySource)
				assert.strictEqual(issue.serviceName, "checkout-api")
				assert.strictEqual(issue.exceptionType, "TimeoutError")
				assert.strictEqual(issue.errorLabel, "TimeoutError: upstream timed out")
				assert.strictEqual(issue.topFrame, "checkout/handler.ts:42")
				assert.strictEqual(issue.occurrenceCount, 3)
				assert.strictEqual(issue.firstSeenAt.getTime(), TICK_MS - 60_000)
				assert.strictEqual(issue.lastSeenAt.getTime(), TICK_MS - 1_000)
				assert.strictEqual(issue.createdAt.getTime(), TICK_MS)

				const events = yield* loadEventsForIssue(issue.id)
				assert.deepStrictEqual(
					events.map((e) => e.type),
					["created"],
				)
				assert.strictEqual(events[0]?.toState, "triage")

				const incidents = yield* loadIncidentsForIssue(issue.id)
				assert.lengthOf(incidents, 1)
				assert.strictEqual(incidents[0]?.status, "open")
				assert.strictEqual(incidents[0]?.reason, "first_seen")
				assert.strictEqual(incidents[0]?.occurrenceCount, 3)

				const states = yield* database.execute((db) =>
					db.select().from(errorIssueStates).where(eq(errorIssueStates.issueId, issue.id)),
				)
				assert.lengthOf(states, 1)
				assert.strictEqual(states[0]?.openIncidentId, incidents[0]?.id)
			}).pipe(Effect.provide(makeErrorsLayer(() => rows)))
		},
	)

	it.effect("re-running the tick over the same scan rows refreshes the issue, never duplicates it", () => {
		const rows = [scanRow()]
		return Effect.gen(function* () {
			const errors = yield* ErrorsService
			yield* TestClock.setTime(TICK_MS)
			yield* seedIssue(asIssueId(randomUUID()))

			const first = yield* errors.runTick()
			assert.strictEqual(first.incidentsOpened, 1)

			yield* TestClock.setTime(TICK_MS + 60_000)
			const second = yield* errors.runTick()
			assert.strictEqual(second.issuesTouched, 1)
			assert.strictEqual(second.incidentsOpened, 0)

			const issues = yield* loadIssuesByFingerprint(SCAN_FINGERPRINT)
			assert.lengthOf(issues, 1)
			// Re-observation accumulates occurrences onto the same issue row.
			assert.strictEqual(issues[0]?.occurrenceCount, 6)

			const incidents = yield* loadIncidentsForIssue(issues[0]!.id)
			assert.lengthOf(incidents, 1)
			assert.strictEqual(incidents[0]?.status, "open")
			assert.strictEqual(incidents[0]?.occurrenceCount, 6)

			const events = yield* loadEventsForIssue(issues[0]!.id)
			assert.lengthOf(
				events.filter((e) => e.type === "created"),
				1,
			)
		}).pipe(Effect.provide(makeErrorsLayer(() => rows)))
	})

	it.effect(
		"a re-fired fingerprint on a done issue reopens it to triage with a regression incident",
		() => {
			const rows = [scanRow()]
			return Effect.gen(function* () {
				const errors = yield* ErrorsService
				yield* TestClock.setTime(TICK_MS)
				yield* seedIssue(asIssueId(randomUUID()))
				yield* errors.runTick()
				const issue = (yield* loadIssuesByFingerprint(SCAN_FINGERPRINT))[0]!

				// Resolve through the public workflow (triage -> done is not a legal
				// direct transition).
				const actor = yield* errors.ensureUserActor(ORG, USER)
				yield* errors.transitionIssue(ORG, actor.id, issue.id, "in_progress")
				yield* errors.transitionIssue(ORG, actor.id, issue.id, "in_review")
				yield* errors.transitionIssue(ORG, actor.id, issue.id, "done")

				const resolved = (yield* loadIssuesByFingerprint(SCAN_FINGERPRINT))[0]!
				assert.strictEqual(resolved.workflowState, "done")
				assert.isNotNull(resolved.resolvedAt)

				yield* TestClock.setTime(TICK_MS + 120_000)
				const second = yield* errors.runTick()
				assert.strictEqual(second.issuesTouched, 1)
				assert.strictEqual(second.incidentsOpened, 1)

				// A done issue reopens immediately on re-observation — the errors tick
				// has no reopen cool-down window.
				const reopened = (yield* loadIssuesByFingerprint(SCAN_FINGERPRINT))[0]!
				assert.strictEqual(reopened.workflowState, "triage")
				assert.isNull(reopened.resolvedAt)

				const events = yield* loadEventsForIssue(issue.id)
				assert.lengthOf(
					events.filter((e) => e.type === "regression"),
					1,
				)

				const incidents = yield* loadIncidentsForIssue(issue.id)
				const open = incidents.filter((i) => i.status === "open")
				assert.lengthOf(open, 1)
				assert.strictEqual(open[0]?.reason, "regression")
			}).pipe(Effect.provide(makeErrorsLayer(() => rows)))
		},
		15_000,
	)

	it.effect("a wontfix issue with an indefinite snooze is skipped entirely by the scan", () => {
		const rows = [scanRow()]
		return Effect.gen(function* () {
			const errors = yield* ErrorsService
			const database = yield* Database
			yield* TestClock.setTime(TICK_MS)
			yield* seedIssue(asIssueId(randomUUID()))
			yield* errors.runTick()
			const issue = (yield* loadIssuesByFingerprint(SCAN_FINGERPRINT))[0]!

			yield* database.execute((db) =>
				db
					.update(errorIssues)
					.set({ workflowState: "wontfix", snoozeUntil: null })
					.where(eq(errorIssues.id, issue.id)),
			)

			yield* TestClock.setTime(TICK_MS + 120_000)
			const second = yield* errors.runTick()
			assert.strictEqual(second.issuesTouched, 0)
			assert.strictEqual(second.incidentsOpened, 0)
			assert.strictEqual(second.issuesReopened, 0)

			const after = (yield* loadIssuesByFingerprint(SCAN_FINGERPRINT))[0]!
			assert.strictEqual(after.workflowState, "wontfix")
			// Skipped means skipped: not even the occurrence count moves.
			assert.strictEqual(after.occurrenceCount, 3)
		}).pipe(Effect.provide(makeErrorsLayer(() => rows)))
	})

	it.effect("an elapsed snooze wakes a wontfix issue back to triage", () =>
		Effect.gen(function* () {
			const errors = yield* ErrorsService
			yield* TestClock.setTime(TICK_MS)
			const issueId = asIssueId(randomUUID())
			yield* seedIssue(issueId, { workflowState: "wontfix", snoozeUntil: new Date(TICK_MS - 1_000) })

			const result = yield* errors.runTick()
			assert.strictEqual(result.issuesReopened, 1)

			const database = yield* Database
			const rows = yield* database.execute((db) =>
				db.select().from(errorIssues).where(eq(errorIssues.id, issueId)),
			)
			assert.strictEqual(rows[0]?.workflowState, "triage")
			assert.isNull(rows[0]?.snoozeUntil)

			const events = yield* loadEventsForIssue(issueId)
			const wakeups = events.filter(
				(e) => e.type === "state_change" && asJsonRecord(e.payloadJson).viaSnoozeWakeup === true,
			)
			assert.lengthOf(wakeups, 1)
			assert.strictEqual(wakeups[0]?.fromState, "wontfix")
			assert.strictEqual(wakeups[0]?.toState, "triage")
		}).pipe(Effect.provide(makeErrorsLayer())),
	)

	it.effect("an empty scan window leaves the issue table untouched", () =>
		Effect.gen(function* () {
			const errors = yield* ErrorsService
			const database = yield* Database
			yield* TestClock.setTime(TICK_MS)
			const issueId = asIssueId(randomUUID())
			yield* seedIssue(issueId)
			const before = yield* database.execute((db) =>
				db.select().from(errorIssues).where(eq(errorIssues.id, issueId)),
			)

			const result = yield* errors.runTick()
			assert.deepStrictEqual(result, {
				orgsProcessed: 1,
				issuesTouched: 0,
				incidentsOpened: 0,
				incidentsResolved: 0,
				issuesReopened: 0,
				issuesArchived: 0,
				issuesDeleted: 0,
				leasesExpired: 0,
				retentionRan: false,
			})

			const after = yield* database.execute((db) =>
				db.select().from(errorIssues).where(eq(errorIssues.id, issueId)),
			)
			assert.deepStrictEqual(after, before)

			const incidents = yield* loadIncidentsForIssue(issueId)
			assert.lengthOf(incidents, 0)
			const events = yield* loadEventsForIssue(issueId)
			assert.lengthOf(events, 0)
		}).pipe(Effect.provide(makeErrorsLayer())),
	)

	it.effect("an open incident auto-resolves after 30 quiet minutes without touching the issue", () => {
		const rows = [scanRow()]
		return Effect.gen(function* () {
			const errors = yield* ErrorsService
			const database = yield* Database
			yield* TestClock.setTime(TICK_MS)
			yield* seedIssue(asIssueId(randomUUID()))
			yield* errors.runTick()
			const issue = (yield* loadIssuesByFingerprint(SCAN_FINGERPRINT))[0]!

			// The fingerprint goes quiet.
			rows.length = 0
			const resolveTickMs = TICK_MS + 31 * 60_000
			yield* TestClock.setTime(resolveTickMs)
			const second = yield* errors.runTick()
			assert.strictEqual(second.issuesTouched, 0)
			assert.strictEqual(second.incidentsResolved, 1)

			const incidents = yield* loadIncidentsForIssue(issue.id)
			assert.lengthOf(incidents, 1)
			assert.strictEqual(incidents[0]?.status, "resolved")
			assert.strictEqual(incidents[0]?.resolvedAt?.getTime(), resolveTickMs)

			const states = yield* database.execute((db) =>
				db.select().from(errorIssueStates).where(eq(errorIssueStates.issueId, issue.id)),
			)
			assert.isNull(states[0]?.openIncidentId)

			// Auto-resolve closes the incident only; the issue's workflow state is
			// not advanced.
			const after = (yield* loadIssuesByFingerprint(SCAN_FINGERPRINT))[0]!
			assert.strictEqual(after.workflowState, "triage")
		}).pipe(Effect.provide(makeErrorsLayer(() => rows)))
	})

	it.effect("expired leases are released and in_progress issues fall back to todo", () =>
		Effect.gen(function* () {
			const errors = yield* ErrorsService
			yield* TestClock.setTime(TICK_MS)
			const issueId = asIssueId(randomUUID())
			yield* seedIssue(issueId)
			const actor = yield* errors.ensureUserActor(ORG, USER)
			// Default lease is 30 minutes; claiming moves triage -> in_progress.
			yield* errors.claimIssue(ORG, actor.id, issueId)

			yield* TestClock.setTime(TICK_MS + 35 * 60_000)
			const result = yield* errors.runTick()
			assert.strictEqual(result.leasesExpired, 1)

			const database = yield* Database
			const rows = yield* database.execute((db) =>
				db.select().from(errorIssues).where(eq(errorIssues.id, issueId)),
			)
			assert.isNull(rows[0]?.leaseHolderActorId)
			assert.isNull(rows[0]?.leaseExpiresAt)
			assert.isNull(rows[0]?.claimedAt)
			assert.strictEqual(rows[0]?.workflowState, "todo")

			const events = yield* loadEventsForIssue(issueId)
			assert.lengthOf(
				events.filter((e) => e.type === "lease_expired"),
				1,
			)
		}).pipe(Effect.provide(makeErrorsLayer())),
	)

	it.effect("the retention phase archives stale done issues and purges long-archived ones", () =>
		Effect.gen(function* () {
			const errors = yield* ErrorsService
			const database = yield* Database
			yield* TestClock.setTime(RETENTION_TICK_MS)

			// Done + resolved 15 days ago (> 14-day resolved retention): archived.
			const archiveCandidate = asIssueId(randomUUID())
			yield* seedIssue(archiveCandidate, {
				workflowState: "done",
				resolvedAt: new Date(RETENTION_TICK_MS - 15 * DAY_MS),
			})

			// Archived 91 days ago (> 90-day archived retention): purged together
			// with its incidents, evaluator state, and audit events.
			const purgeCandidate = asIssueId(randomUUID())
			yield* seedIssue(purgeCandidate, {
				workflowState: "done",
				resolvedAt: new Date(RETENTION_TICK_MS - 120 * DAY_MS),
				archivedAt: new Date(RETENTION_TICK_MS - 91 * DAY_MS),
			})
			const seededAt = new Date(RETENTION_TICK_MS - 120 * DAY_MS)
			yield* database.execute((db) =>
				db.insert(errorIssueEvents).values({
					id: asEventId(randomUUID()),
					orgId: ORG,
					issueId: purgeCandidate,
					actorId: null,
					type: "created",
					payloadJson: {},
					createdAt: seededAt,
				}),
			)
			yield* database.execute((db) =>
				db.insert(errorIncidents).values({
					id: asIncidentId(randomUUID()),
					orgId: ORG,
					issueId: purgeCandidate,
					status: "resolved",
					reason: "first_seen",
					firstTriggeredAt: seededAt,
					lastTriggeredAt: seededAt,
					resolvedAt: seededAt,
					occurrenceCount: 1,
					createdAt: seededAt,
					updatedAt: seededAt,
				}),
			)
			yield* database.execute((db) =>
				db.insert(errorIssueStates).values({
					orgId: ORG,
					issueId: purgeCandidate,
					lastObservedOccurrenceAt: seededAt,
					lastEvaluatedAt: seededAt,
					openIncidentId: null,
					updatedAt: seededAt,
				}),
			)

			const result = yield* errors.runTick()
			assert.isTrue(result.retentionRan)
			assert.strictEqual(result.issuesArchived, 1)
			assert.strictEqual(result.issuesDeleted, 1)

			const archivedRows = yield* database.execute((db) =>
				db.select().from(errorIssues).where(eq(errorIssues.id, archiveCandidate)),
			)
			assert.lengthOf(archivedRows, 1)
			assert.strictEqual(archivedRows[0]?.archivedAt?.getTime(), RETENTION_TICK_MS)

			const purgedIssues = yield* database.execute((db) =>
				db.select().from(errorIssues).where(eq(errorIssues.id, purgeCandidate)),
			)
			assert.lengthOf(purgedIssues, 0)
			assert.lengthOf(yield* loadIncidentsForIssue(purgeCandidate), 0)
			assert.lengthOf(yield* loadEventsForIssue(purgeCandidate), 0)
			const purgedStates = yield* database.execute((db) =>
				db.select().from(errorIssueStates).where(eq(errorIssueStates.issueId, purgeCandidate)),
			)
			assert.lengthOf(purgedStates, 0)
		}).pipe(Effect.provide(makeErrorsLayer())),
	)
})
