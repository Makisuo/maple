import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { InvestigationId, OrgId } from "@maple/domain/http"
import { aiTriageSettings, investigations } from "@maple/db"
import { Database } from "@/platform/DatabaseLive"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { AiTriageService } from "./AiTriageService"

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			MCP_PORT: "3473",
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
	return AiTriageService.layer.pipe(
		Layer.provideMerge(testDb.layer),
		Layer.provideMerge(Env.layer),
		Layer.provide(testConfig()),
	)
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asInvestigationId = Schema.decodeUnknownSync(InvestigationId)
const ORG = asOrgId("org_triage_settings_test")

const seedSettings = (maxRunsPerDay: number, maxPassesPerDay: number) =>
	Effect.gen(function* () {
		const database = yield* Database
		yield* database.execute((db) =>
			db.insert(aiTriageSettings).values({
				orgId: ORG,
				enabled: true,
				maxRunsPerDay,
				maxPassesPerDay,
				updatedAt: new Date(),
			}),
		)
	})

/**
 * Usage is counted from started rows as `fanoutSize + 1`, so a width-3 row is
 * worth 4 passes. Seeding rows rather than driving the enqueue path keeps the
 * arithmetic under the test's control instead of the planner's.
 */
const seedStartedRuns = (count: number, fanoutSize: number, idOffset = 0) =>
	Effect.gen(function* () {
		const database = yield* Database
		const now = new Date()
		for (let index = 0; index < count; index++) {
			yield* database.execute((db) =>
				db.insert(investigations).values({
					id: asInvestigationId(
						`00000000-0000-4000-8000-${String(idOffset + index).padStart(12, "0")}`,
					),
					orgId: ORG,
					status: "investigating",
					seededBy: "system",
					subjectJson: { type: "question", question: "seed" },
					fanoutSize,
					startedAt: now,
					createdAt: now,
					updatedAt: now,
				}),
			)
		}
	})

describe("AiTriageService.getSettings pause state", () => {
	it.effect("reports triage healthy while both ceilings have room", () =>
		Effect.gen(function* () {
			yield* seedSettings(50, 100)
			const doc = yield* (yield* AiTriageService).getSettings(ORG)
			assert.isFalse(doc.ordinaryPaused)
			assert.isFalse(doc.priorityPaused)
			assert.isNull(doc.pausedDimension)
			assert.isNull(doc.resumesAt)
		}).pipe(Effect.provide(makeLayer())),
	)

	/**
	 * The probe has to cost what a start *reserves* (`width + 2` = 6 for a medium
	 * incident), not what a settled run consumes. Probing with 4 left the banner
	 * hidden across the last two passes of the slice — exactly the window where
	 * ordinary starts were already being refused.
	 */
	it.effect("pauses ordinary triage at the reservation, not at the settled cost", () =>
		Effect.gen(function* () {
			// Ordinary slice of a 100-pass ceiling is 70. Land usage on 65 — the one
			// window that separates the two probes: 65 + 6 > 70 refuses a real start,
			// while the old 65 + 4 <= 70 reported triage as healthy.
			yield* seedSettings(500, 100)
			yield* seedStartedRuns(16, 3) // 16 x 4 = 64
			yield* seedStartedRuns(1, 1, 100) // a single-pass run is worth 1
			const doc = yield* (yield* AiTriageService).getSettings(ORG)
			assert.strictEqual(doc.usage.passes, 65)
			assert.isTrue(doc.ordinaryPaused)
			assert.strictEqual(doc.pausedDimension, "passes_reserved")
			// The reserve is the whole point: criticals are still starting here.
			assert.isFalse(doc.priorityPaused)
			assert.isNotNull(doc.resumesAt)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("pauses priority triage too once the full ceiling is spent", () =>
		Effect.gen(function* () {
			yield* seedSettings(500, 100)
			yield* seedStartedRuns(24, 3) // 96 passes; 96 + 7 > 100
			const doc = yield* (yield* AiTriageService).getSettings(ORG)
			assert.isTrue(doc.ordinaryPaused)
			assert.isTrue(doc.priorityPaused)
		}).pipe(Effect.provide(makeLayer())),
	)

	/**
	 * The runs ceiling is checked before any pass arithmetic and has no reserve,
	 * so it stops every severity. Reporting it as a pass problem would tell an
	 * operator that criticals are covered when they are not, and point them at a
	 * number that was never the constraint.
	 */
	it.effect("names the runs ceiling and pauses every severity with it", () =>
		Effect.gen(function* () {
			yield* seedSettings(3, 10_000)
			yield* seedStartedRuns(3, 3)
			const doc = yield* (yield* AiTriageService).getSettings(ORG)
			assert.strictEqual(doc.pausedDimension, "runs")
			assert.isTrue(doc.ordinaryPaused)
			assert.isTrue(doc.priorityPaused)
		}).pipe(Effect.provide(makeLayer())),
	)
})
