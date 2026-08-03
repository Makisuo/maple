import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { errorIssues, errorIssueStates, orgClickHouseSettings } from "@maple/db"
import { ErrorIssueId, OrgId } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { selectDistinctOrgIds } from "@/platform/distinct-org-ids"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asIssueId = Schema.decodeUnknownSync(ErrorIssueId)

const issueRow = (org: string, suffix: string) => ({
	id: asIssueId(randomUUID()),
	orgId: asOrgId(org),
	fingerprintHash: `fp_${org}_${suffix}`,
	serviceName: "checkout-api",
	exceptionType: "TimeoutError",
	exceptionMessage: "upstream timed out",
	topFrame: "",
	firstSeenAt: new Date(0),
	lastSeenAt: new Date(0),
	createdAt: new Date(0),
	updatedAt: new Date(0),
})

describe("selectDistinctOrgIds", () => {
	it.effect("returns the same set as SELECT DISTINCT, in ascending order", () =>
		Effect.gen(function* () {
			const db = createTestDb(createdDbs)
			const database = yield* Database.pipe(Effect.provide(db.layer))

			// Duplicates per org are the point: a loose index scan must emit each
			// org exactly once no matter how many rows it owns.
			yield* database.execute((client) =>
				client
					.insert(errorIssues)
					.values([
						issueRow("org_c", "1"),
						issueRow("org_a", "1"),
						issueRow("org_a", "2"),
						issueRow("org_a", "3"),
						issueRow("org_b", "1"),
						issueRow("org_b", "2"),
					]),
			)

			const loose = yield* database.execute((client) =>
				selectDistinctOrgIds(client, errorIssues, errorIssues.orgId),
			)
			const baseline = yield* database.execute((client) =>
				client.selectDistinct({ orgId: errorIssues.orgId }).from(errorIssues),
			)

			assert.deepStrictEqual([...loose], ["org_a", "org_b", "org_c"])
			assert.deepStrictEqual([...loose].sort(), baseline.map((row) => row.orgId).sort())
		}),
	)

	it.effect("returns an empty list for an empty table", () =>
		Effect.gen(function* () {
			const db = createTestDb(createdDbs)
			const database = yield* Database.pipe(Effect.provide(db.layer))

			const loose = yield* database.execute((client) =>
				selectDistinctOrgIds(client, errorIssues, errorIssues.orgId),
			)
			assert.deepStrictEqual([...loose], [])
		}),
	)

	it.effect("walks a composite primary key and a single-column primary key", () =>
		Effect.gen(function* () {
			const db = createTestDb(createdDbs)
			const database = yield* Database.pipe(Effect.provide(db.layer))

			yield* database.execute(async (client) => {
				await client.insert(errorIssueStates).values([
					{ orgId: asOrgId("org_b"), issueId: asIssueId(randomUUID()), updatedAt: new Date(0) },
					{ orgId: asOrgId("org_b"), issueId: asIssueId(randomUUID()), updatedAt: new Date(0) },
					{ orgId: asOrgId("org_a"), issueId: asIssueId(randomUUID()), updatedAt: new Date(0) },
				])
				await client.insert(orgClickHouseSettings).values(
					["org_z", "org_y"].map((orgId) => ({
						orgId,
						chUrl: "https://ch.example",
						chUser: "default",
						chDatabase: "maple",
						syncStatus: "connected",
						createdAt: new Date(0),
						updatedAt: new Date(0),
						createdBy: "test",
						updatedBy: "test",
					})),
				)
			})

			const states = yield* database.execute((client) =>
				selectDistinctOrgIds(client, errorIssueStates, errorIssueStates.orgId),
			)
			const settings = yield* database.execute((client) =>
				selectDistinctOrgIds(client, orgClickHouseSettings, orgClickHouseSettings.orgId),
			)

			assert.deepStrictEqual([...states], ["org_a", "org_b"])
			assert.deepStrictEqual([...settings], ["org_y", "org_z"])
		}),
	)
})
