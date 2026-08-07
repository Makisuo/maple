import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { OrgId } from "@maple/domain/http"
import { AlertIncidentId, AlertRuleId } from "@maple/domain/primitives"
import { alertIncidents, errorIssues, errorIssueEvents } from "@maple/db"
import { and, eq, sql } from "drizzle-orm"
import { Database } from "@/platform/DatabaseLive"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { alertIssueFingerprint, detectorSeverityFor, upsertAlertIssue } from "./issue-hub"

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3474",
			MCP_PORT: "3475",
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

const makeLayer = () => {
	const testDb = createTestDb(createdDbs)
	return testDb.layer.pipe(Layer.provideMerge(Env.layer), Layer.provide(testConfig()))
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const ORG = asOrgId("org_issue_hub_test")

// Rule/incident ids are UUID-branded end to end, so fixtures must be real UUIDs.
const RULE_1 = Schema.decodeUnknownSync(AlertRuleId)("11111111-1111-4111-8111-111111111111")
const INCIDENT_1 = Schema.decodeUnknownSync(AlertIncidentId)("22222222-2222-4222-8222-222222222222")
const INCIDENT_2 = Schema.decodeUnknownSync(AlertIncidentId)("33333333-3333-4333-8333-333333333333")

// Single time base for the whole file: seeded rows, upsert input timestamps,
// and the service's own Clock reads (via TestClock.setTime) all derive from T0
// instead of mixing literal epochs with wall-clock time.
const T0 = 1_750_000_000_000

const baseInput = (overrides: Partial<Parameters<typeof upsertAlertIssue>[0]> = {}) => ({
	orgId: ORG,
	ruleId: RULE_1,
	ruleName: "High p95 latency",
	groupKey: "checkout",
	signalType: "p95_latency",
	severity: "warning" as const,
	comparator: "gte",
	threshold: 800,
	thresholdUpper: null,
	windowMinutes: 5,
	observedValue: 1240,
	sampleCount: 412,
	incidentId: INCIDENT_1,
	serviceName: "checkout",
	timestamp: T0,
	internalServiceToken: Option.none(),
	...overrides,
})

const loadIssue = Effect.gen(function* () {
	const database = yield* Database
	const rows = yield* database.execute((db) =>
		db
			.select()
			.from(errorIssues)
			.where(
				and(
					eq(errorIssues.orgId, ORG),
					eq(errorIssues.fingerprintHash, alertIssueFingerprint(RULE_1, "checkout")),
				),
			),
	)
	return rows
})

describe("detectorSeverityFor", () => {
	it("maps warning to medium and critical to critical", () => {
		assert.strictEqual(detectorSeverityFor("warning"), "medium")
		assert.strictEqual(detectorSeverityFor("critical"), "critical")
	})
})

describe("upsertAlertIssue", () => {
	it.effect("creates an alert-kind issue with detector severity and links the incident", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			const database = yield* Database
			yield* database.execute((db) =>
				db.insert(alertIncidents).values({
					id: INCIDENT_1,
					orgId: ORG,
					ruleId: RULE_1,
					incidentKey: INCIDENT_1,
					ruleName: "High p95 latency",
					groupKey: "checkout",
					signalType: "p95_latency",
					severity: "warning",
					status: "open",
					comparator: "gte",
					threshold: 800,
					firstTriggeredAt: new Date(T0),
					lastTriggeredAt: new Date(T0),
					dedupeKey: `${ORG}:${RULE_1}:checkout`,
					createdAt: new Date(T0),
					updatedAt: new Date(T0),
				}),
			)

			const result = yield* upsertAlertIssue(baseInput())
			assert.strictEqual(result.action, "created")
			assert.isNotNull(result.issueId)

			const issues = yield* loadIssue
			assert.lengthOf(issues, 1)
			const issue = issues[0]!
			assert.strictEqual(issue.kind, "alert")
			assert.strictEqual(issue.workflowState, "triage")
			assert.strictEqual(issue.severity, "medium")
			assert.strictEqual(issue.severitySource, "detector")
			assert.strictEqual(issue.exceptionType, "High p95 latency")
			assert.strictEqual(issue.serviceName, "checkout")
			assert.deepStrictEqual(issue.sourceRefJson, {
				ruleId: RULE_1,
				groupKey: "checkout",
				signalType: "p95_latency",
				latestIncidentId: INCIDENT_1,
			})

			const incidents = yield* database.execute((db) =>
				db.select().from(alertIncidents).where(eq(alertIncidents.id, INCIDENT_1)),
			)
			assert.strictEqual(incidents[0]?.errorIssueId, issue.id)

			const events = yield* database.execute((db) =>
				db.select().from(errorIssueEvents).where(eq(errorIssueEvents.issueId, issue.id)),
			)
			assert.lengthOf(events, 1)
			assert.strictEqual(events[0]?.type, "created")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("re-fires refresh the same issue instead of creating a new one", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			const first = yield* upsertAlertIssue(baseInput())
			const second = yield* upsertAlertIssue(
				baseInput({ incidentId: INCIDENT_2, timestamp: T0 + 100_000 }),
			)
			assert.strictEqual(second.action, "refreshed")
			assert.strictEqual(second.issueId, first.issueId)

			const issues = yield* loadIssue
			assert.lengthOf(issues, 1)
			assert.strictEqual(issues[0]?.occurrenceCount, 2)
			assert.deepStrictEqual(issues[0]?.sourceRefJson, {
				ruleId: RULE_1,
				groupKey: "checkout",
				signalType: "p95_latency",
				latestIncidentId: INCIDENT_2,
			})
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("does not clobber an existing severity on re-fire", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			const database = yield* Database
			const first = yield* upsertAlertIssue(baseInput())
			yield* database.execute((db) =>
				db
					.update(errorIssues)
					.set({ severity: "low", severitySource: "manual" })
					.where(eq(errorIssues.id, first.issueId!)),
			)

			yield* upsertAlertIssue(
				baseInput({ incidentId: INCIDENT_2, severity: "critical", timestamp: T0 + 100_000 }),
			)

			const issues = yield* loadIssue
			assert.strictEqual(issues[0]?.severity, "low")
			assert.strictEqual(issues[0]?.severitySource, "manual")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("backfills the detector severity on re-fire when severity was cleared", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			const database = yield* Database
			const first = yield* upsertAlertIssue(baseInput())
			// Simulate a triager clearing the severity back to "untriaged".
			yield* database.execute((db) =>
				db
					.update(errorIssues)
					.set({ severity: null, severitySource: null })
					.where(eq(errorIssues.id, first.issueId!)),
			)

			const second = yield* upsertAlertIssue(
				baseInput({ incidentId: INCIDENT_2, severity: "critical", timestamp: T0 + 100_000 }),
			)
			assert.strictEqual(second.action, "refreshed")

			const issues = yield* loadIssue
			assert.strictEqual(issues[0]?.severity, "critical")
			assert.strictEqual(issues[0]?.severitySource, "detector")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("reopens a done issue to triage with regression events", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			const database = yield* Database
			const first = yield* upsertAlertIssue(baseInput())
			yield* database.execute((db) =>
				db
					.update(errorIssues)
					.set({ workflowState: "done", resolvedAt: new Date(T0 + 50_000) })
					.where(eq(errorIssues.id, first.issueId!)),
			)

			const second = yield* upsertAlertIssue(
				baseInput({ incidentId: INCIDENT_2, timestamp: T0 + 100_000 }),
			)
			assert.strictEqual(second.action, "reopened")

			const issues = yield* loadIssue
			assert.strictEqual(issues[0]?.workflowState, "triage")
			assert.isNull(issues[0]?.resolvedAt)

			const events = yield* database.execute((db) =>
				db.select().from(errorIssueEvents).where(eq(errorIssueEvents.issueId, first.issueId!)),
			)
			const types = events.map((e) => e.type)
			assert.include(types, "state_change")
			assert.include(types, "regression")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("skips a wontfix issue while its snooze is active", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			const database = yield* Database
			const first = yield* upsertAlertIssue(baseInput())
			yield* database.execute((db) =>
				db
					.update(errorIssues)
					.set({ workflowState: "wontfix", snoozeUntil: new Date(T0 + 999_000) })
					.where(eq(errorIssues.id, first.issueId!)),
			)

			const second = yield* upsertAlertIssue(
				baseInput({ incidentId: INCIDENT_2, timestamp: T0 + 100_000 }),
			)
			assert.strictEqual(second.action, "skipped")

			const issues = yield* loadIssue
			assert.strictEqual(issues[0]?.workflowState, "wontfix")
			assert.strictEqual(issues[0]?.occurrenceCount, 1)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("skips a wontfix issue with an indefinite snooze (snoozeUntil null)", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			const database = yield* Database
			const first = yield* upsertAlertIssue(baseInput())
			yield* database.execute((db) =>
				db
					.update(errorIssues)
					.set({ workflowState: "wontfix", snoozeUntil: null })
					.where(eq(errorIssues.id, first.issueId!)),
			)

			const second = yield* upsertAlertIssue(
				baseInput({ incidentId: INCIDENT_2, timestamp: T0 + 100_000 }),
			)
			assert.strictEqual(second.action, "skipped")
			assert.strictEqual(second.issueId, first.issueId)

			const issues = yield* loadIssue
			// Indefinitely snoozed means left alone entirely: no reopen, no refresh.
			assert.strictEqual(issues[0]?.workflowState, "wontfix")
			assert.strictEqual(issues[0]?.occurrenceCount, 1)
			assert.isNull(issues[0]?.snoozeUntil)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("reopens a wontfix issue once its snooze has expired", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			const database = yield* Database
			const first = yield* upsertAlertIssue(baseInput())
			yield* database.execute((db) =>
				db
					.update(errorIssues)
					.set({ workflowState: "wontfix", snoozeUntil: new Date(T0 + 50_000) })
					.where(eq(errorIssues.id, first.issueId!)),
			)

			const second = yield* upsertAlertIssue(
				baseInput({ incidentId: INCIDENT_2, timestamp: T0 + 100_000 }),
			)
			assert.strictEqual(second.action, "reopened")

			const issues = yield* loadIssue
			assert.strictEqual(issues[0]?.workflowState, "triage")
			assert.isNull(issues[0]?.snoozeUntil)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("reports { issueId: null, action: 'error' } instead of failing when the DB breaks", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			const database = yield* Database
			// Sabotage the schema so the very first select inside the upsert fails;
			// the catchCause wrapper must swallow it and report `action: "error"`.
			yield* database.execute((db) => db.execute(sql`DROP TABLE error_issues`))

			const result = yield* upsertAlertIssue(baseInput())
			assert.isNull(result.issueId)
			assert.strictEqual(result.action, "error")
		}).pipe(Effect.provide(makeLayer())),
	)
})
