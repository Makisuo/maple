import { afterEach, describe, expect, it } from "@effect/vitest"
import { OrgId, SpendLimitValidationError, UpdateSpendLimitsRequest } from "@maple/domain/http"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { cleanupTestDbs, createTestDb, type TestDb } from "../lib/test-pglite"
import { SpendLimitsService, validateSpendLimits } from "./SpendLimitsService"

const asOrgId = Schema.decodeUnknownSync(OrgId)

const getError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
	if (!Exit.isFailure(exit)) return undefined
	const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
	return failure ?? Cause.squash(exit.cause)
}

const request = (overrides: Partial<UpdateSpendLimitsRequest> = {}) =>
	new UpdateSpendLimitsRequest({
		monthlyLimitCents: 30_000,
		enforcementMode: "notify",
		alertThresholdPercents: [80, 100],
		featureCaps: {},
		...overrides,
	})

describe("validateSpendLimits", () => {
	it.effect("normalizes thresholds — deduped and ascending, so one crossing notifies once", () =>
		Effect.gen(function* () {
			const validated = yield* validateSpendLimits(
				request({ alertThresholdPercents: [100, 80, 80, 50] }),
			)
			expect(validated.alertThresholdPercents).toEqual([50, 80, 100])
		}),
	)

	it.effect("rejects pause mode without a ceiling — it could never fire", () =>
		Effect.gen(function* () {
			const exit = yield* validateSpendLimits(
				request({ enforcementMode: "pause", monthlyLimitCents: null }),
			).pipe(Effect.exit)

			const error = getError(exit)
			expect(error).toBeInstanceOf(SpendLimitValidationError)
			expect((error as SpendLimitValidationError).message).toContain("requires a monthly spend limit")
		}),
	)

	it.effect("rejects a zero/negative ceiling, an out-of-range threshold, and a bad cap", () =>
		Effect.gen(function* () {
			for (const bad of [
				request({ monthlyLimitCents: 0 }),
				request({ monthlyLimitCents: -1 }),
				request({ monthlyLimitCents: 1.5 }),
				request({ alertThresholdPercents: [0] }),
				request({ alertThresholdPercents: [101] }),
				request({ featureCaps: { logs: 0 } }),
				request({ featureCaps: { logs: -5 } }),
				request({ featureCaps: { nonsense: 10 } }),
			]) {
				const exit = yield* validateSpendLimits(bad).pipe(Effect.exit)
				expect(getError(exit)).toBeInstanceOf(SpendLimitValidationError)
			}
		}),
	)

	it.effect("drops null caps rather than storing them as configured", () =>
		Effect.gen(function* () {
			const validated = yield* validateSpendLimits(
				request({ featureCaps: { logs: 600, traces: null } }),
			)
			expect(validated.featureCaps).toEqual({ logs: 600 })
		}),
	)
})

describe("SpendLimitsService", () => {
	const dbs: TestDb[] = []
	afterEach(() => cleanupTestDbs(dbs))

	const withDb = <A, E>(testDb: TestDb, effect: Effect.Effect<A, E, SpendLimitsService>) =>
		effect.pipe(Effect.provide(SpendLimitsService.layer.pipe(Layer.provide(testDb.layer))))

	const readRows = (testDb: TestDb, orgId: string) =>
		testDb.pglite
			.query<{ updated_by: string | null }>("SELECT * FROM org_spend_limits WHERE org_id = $1", [
				orgId,
			])
			.then((result) => result.rows)

	it.effect("returns notify-only defaults for an org that has never configured limits", () => {
		const testDb = createTestDb(dbs)
		return withDb(
			testDb,
			Effect.gen(function* () {
				const service = yield* SpendLimitsService
				const limits = yield* service.get(asOrgId("org_never"))

				expect(limits.monthlyLimitCents).toBeNull()
				expect(limits.enforcementMode).toBe("notify")
				expect(limits.alertThresholdPercents).toEqual([80, 100])
				expect(limits.pausedAt).toBeNull()
				expect(limits.breachedAt).toBeNull()
			}),
		)
	})

	it.effect("upserts on save — a second save replaces rather than duplicating", () => {
		const testDb = createTestDb(dbs)
		const orgId = asOrgId("org_upsert")
		return withDb(
			testDb,
			Effect.gen(function* () {
				const service = yield* SpendLimitsService

				yield* service.update(orgId, request({ monthlyLimitCents: 30_000 }), "user_1")
				const second = yield* service.update(
					orgId,
					request({ monthlyLimitCents: 45_000, featureCaps: { logs: 600 } }),
					"user_2",
				)

				expect(second.monthlyLimitCents).toBe(45_000)
				expect(second.featureCaps).toEqual({ logs: 600 })

				const rows = yield* Effect.promise(() => readRows(testDb, orgId))
				expect(rows).toHaveLength(1)
				expect(rows[0]?.updated_by).toBe("user_2")
			}),
		)
	})

	it.effect("switching to notify-only lifts an active pause immediately", () => {
		const testDb = createTestDb(dbs)
		const orgId = asOrgId("org_unpause")
		return withDb(
			testDb,
			Effect.gen(function* () {
				const service = yield* SpendLimitsService

				yield* service.update(
					orgId,
					request({ enforcementMode: "pause", monthlyLimitCents: 10_000 }),
					"user_1",
				)
				yield* service.recordEvaluation(orgId, {
					spendCents: 12_000,
					breached: true,
					cycleStartMs: Date.UTC(2026, 6, 1),
					notifiedThresholds: [80, 100],
				})

				const paused = yield* service.get(orgId)
				expect(paused.pausedAt).not.toBeNull()

				// The gateway reads this row directly, so a mode change that left
				// `paused_at` set would keep 402ing until the next cron tick.
				const unpaused = yield* service.update(orgId, request({ enforcementMode: "notify" }), "user_1")
				expect(unpaused.pausedAt).toBeNull()
			}),
		)
	})

	it.effect("notify-only breaches loudly without ever pausing", () => {
		const testDb = createTestDb(dbs)
		const orgId = asOrgId("org_notify")
		return withDb(
			testDb,
			Effect.gen(function* () {
				const service = yield* SpendLimitsService

				yield* service.update(orgId, request({ enforcementMode: "notify" }), "user_1")
				yield* service.recordEvaluation(orgId, {
					spendCents: 99_000,
					breached: true,
					cycleStartMs: Date.UTC(2026, 6, 1),
					notifiedThresholds: [80, 100],
				})

				const limits = yield* service.get(orgId)
				expect(limits.breachedAt).not.toBeNull()
				expect(limits.pausedAt).toBeNull()
				expect(limits.evaluatedSpendCents).toBe(99_000)
			}),
		)
	})

	it.effect("a new cycle clears last cycle's breach and pause", () => {
		const testDb = createTestDb(dbs)
		const orgId = asOrgId("org_rollover")
		return withDb(
			testDb,
			Effect.gen(function* () {
				const service = yield* SpendLimitsService

				yield* service.update(
					orgId,
					request({ enforcementMode: "pause", monthlyLimitCents: 10_000 }),
					"user_1",
				)
				yield* service.recordEvaluation(orgId, {
					spendCents: 12_000,
					breached: true,
					cycleStartMs: Date.UTC(2026, 6, 1),
					notifiedThresholds: [80, 100],
				})
				expect((yield* service.get(orgId)).pausedAt).not.toBeNull()

				// August, spend back at zero: last month's overspend must not keep
				// this month's ingestion paused.
				yield* service.recordEvaluation(orgId, {
					spendCents: 0,
					breached: false,
					cycleStartMs: Date.UTC(2026, 7, 1),
					notifiedThresholds: [],
				})

				const fresh = yield* service.get(orgId)
				expect(fresh.breachedAt).toBeNull()
				expect(fresh.pausedAt).toBeNull()
			}),
		)
	})

	it.effect("recordEvaluation is a no-op for an org with no configured row", () => {
		const testDb = createTestDb(dbs)
		return withDb(
			testDb,
			Effect.gen(function* () {
				const service = yield* SpendLimitsService
				yield* service.recordEvaluation(asOrgId("org_absent"), {
					spendCents: 5_000,
					breached: true,
					cycleStartMs: Date.UTC(2026, 6, 1),
					notifiedThresholds: [],
				})

				const rows = yield* Effect.promise(() => readRows(testDb, "org_absent"))
				expect(rows).toHaveLength(0)
			}),
		)
	})

	it.effect("listConfigured skips rows with neither a ceiling nor a cap", () => {
		const testDb = createTestDb(dbs)
		return withDb(
			testDb,
			Effect.gen(function* () {
				const service = yield* SpendLimitsService

				yield* service.update(asOrgId("org_with_limit"), request({ monthlyLimitCents: 30_000 }), "u")
				yield* service.update(
					asOrgId("org_with_cap"),
					request({ monthlyLimitCents: null, featureCaps: { logs: 600 } }),
					"u",
				)
				// Neither a ceiling nor a cap: nothing to evaluate, so the cron must
				// not spend an Autumn round-trip on it every tick.
				yield* service.update(
					asOrgId("org_defaults"),
					request({ monthlyLimitCents: null, featureCaps: {} }),
					"u",
				)

				const configured = yield* service.listConfigured()
				expect(configured.map((entry) => entry.orgId).sort()).toEqual([
					"org_with_cap",
					"org_with_limit",
				])
			}),
		)
	})
})
