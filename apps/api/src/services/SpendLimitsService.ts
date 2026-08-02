import {
	SpendLimitPersistenceError,
	SpendLimitValidationError,
	SpendLimits,
	type OrgId,
	type SpendEnforcementMode,
	type UpdateSpendLimitsRequest,
} from "@maple/domain/http"
import { orgSpendLimits, type OrgSpendLimitsRow } from "@maple/db"
import { eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { Database, DatabaseError } from "../lib/DatabaseLive"

/**
 * Per-org spend guardrails: the monthly ceiling on estimated spend, the alert
 * thresholds below it, the enforcement mode, and optional per-feature volume
 * caps.
 *
 * Absence of a row is the default state, not an error — so `get` synthesizes the
 * defaults rather than 404ing, and the billing page can render the card for an
 * org that has never touched it.
 *
 * The derived evaluation fields (`breachedAt` / `pausedAt` / spend snapshot) are
 * never accepted from a client: only the spend-limit cron writes them, via
 * `recordEvaluation`. `update` deliberately leaves them alone except to clear a
 * pause the user just made impossible by switching to notify-only — otherwise a
 * mode change wouldn't take effect at the gateway until the next cron tick.
 */

/** Features the billing page can cap, keyed by Autumn featureId. */
const CAPPABLE_FEATURES = ["logs", "traces", "metrics", "browser_sessions"] as const

const MAX_LIMIT_CENTS = 100_000_000 // $1,000,000 — a typo guard, not a policy.

/** What the evaluation cron stamps back onto the row. */
export interface SpendEvaluationRecord {
	readonly spendCents: number
	readonly breached: boolean
	readonly cycleStartMs: number
	readonly notifiedThresholds: ReadonlyArray<number>
	/** Features over their own cap this cycle, as Autumn featureIds. */
	readonly exceededCaps?: ReadonlyArray<string>
}

export interface SpendLimitsServiceShape {
	readonly get: (orgId: OrgId) => Effect.Effect<SpendLimits, SpendLimitPersistenceError>
	readonly update: (
		orgId: OrgId,
		request: UpdateSpendLimitsRequest,
		updatedBy: string,
	) => Effect.Effect<SpendLimits, SpendLimitValidationError | SpendLimitPersistenceError>
	/** Cron-only: stamp the evaluated spend and the resulting breach/pause state. */
	readonly recordEvaluation: (
		orgId: OrgId,
		evaluation: SpendEvaluationRecord,
	) => Effect.Effect<void, SpendLimitPersistenceError>
	/** Cron-only: every org with guardrails configured — the evaluation work-list. */
	readonly listConfigured: () => Effect.Effect<
		ReadonlyArray<ConfiguredSpendLimits>,
		SpendLimitPersistenceError
	>
}

/**
 * A work-list entry for the evaluation cron. Carries the two derived fields the
 * public `SpendLimits` deliberately omits — the cron needs `notifiedThresholds`
 * to fire a threshold once, and `cycleStartedAtMs` to know whether that state
 * belongs to the cycle being evaluated.
 */
export interface ConfiguredSpendLimits {
	readonly orgId: string
	readonly limits: SpendLimits
	readonly notifiedThresholds: ReadonlyArray<number>
	readonly cycleStartedAtMs: number | null
}

const runDb = <A>(
	operation: string,
	effect: Effect.Effect<A, DatabaseError>,
): Effect.Effect<A, SpendLimitPersistenceError> =>
	effect.pipe(
		Effect.tapCause((cause) =>
			Effect.logError("Spend limit database operation failed").pipe(
				Effect.annotateLogs({ operation, cause }),
			),
		),
		Effect.mapError((error) => new SpendLimitPersistenceError({ message: error.message })),
	)

const DEFAULT_LIMITS = new SpendLimits({
	monthlyLimitCents: null,
	enforcementMode: "notify",
	alertThresholdPercents: [80, 100],
	featureCaps: {},
	lastEvaluatedAt: null,
	evaluatedSpendCents: null,
	breachedAt: null,
	pausedAt: null,
	pausedFeatures: [],
})

const msOrNull = (value: Date | null) => (value === null ? null : value.getTime())

const rowToResponse = (row: OrgSpendLimitsRow): SpendLimits =>
	new SpendLimits({
		monthlyLimitCents: row.monthlyLimitCents,
		enforcementMode: row.enforcementMode === "pause" ? "pause" : "notify",
		alertThresholdPercents: row.alertThresholdPercents,
		featureCaps: row.featureCaps,
		lastEvaluatedAt: msOrNull(row.lastEvaluatedAt),
		evaluatedSpendCents: row.evaluatedSpendCents,
		breachedAt: msOrNull(row.breachedAt),
		pausedAt: msOrNull(row.pausedAt),
		pausedFeatures: row.pausedFeatures,
	})

/**
 * Reject nonsense before it reaches the gateway: a negative or absurd ceiling, a
 * threshold outside 0–100, or a negative cap. Thresholds are normalized
 * (deduped, sorted) so "80, 80, 100" can't notify twice for one crossing.
 */
export const validateSpendLimits = (
	request: UpdateSpendLimitsRequest,
): Effect.Effect<
	{
		readonly monthlyLimitCents: number | null
		readonly enforcementMode: SpendEnforcementMode
		readonly alertThresholdPercents: ReadonlyArray<number>
		readonly featureCaps: Record<string, number | null>
	},
	SpendLimitValidationError
> =>
	Effect.gen(function* () {
		const limit = request.monthlyLimitCents
		if (limit !== null) {
			if (!Number.isFinite(limit) || !Number.isInteger(limit)) {
				return yield* new SpendLimitValidationError({
					message: "Monthly limit must be a whole number of cents",
				})
			}
			if (limit <= 0) {
				return yield* new SpendLimitValidationError({
					message: "Monthly limit must be greater than zero — use no limit to remove the ceiling",
				})
			}
			if (limit > MAX_LIMIT_CENTS) {
				return yield* new SpendLimitValidationError({ message: "Monthly limit is unreasonably high" })
			}
		}

		// A pause mode with no ceiling can never fire, and would read on the page as
		// enforcement that silently does nothing.
		if (request.enforcementMode === "pause" && limit === null) {
			return yield* new SpendLimitValidationError({
				message: "Pausing ingest requires a monthly spend limit",
			})
		}

		for (const percent of request.alertThresholdPercents) {
			if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
				return yield* new SpendLimitValidationError({
					message: "Alert thresholds must be percentages between 1 and 100",
				})
			}
		}
		const thresholds = Array.from(new Set(request.alertThresholdPercents)).sort((a, b) => a - b)

		const featureCaps: Record<string, number | null> = {}
		for (const [featureId, cap] of Object.entries(request.featureCaps)) {
			if (!CAPPABLE_FEATURES.includes(featureId as (typeof CAPPABLE_FEATURES)[number])) {
				return yield* new SpendLimitValidationError({ message: `Unknown feature: ${featureId}` })
			}
			if (cap === null) continue
			if (!Number.isFinite(cap) || cap <= 0) {
				return yield* new SpendLimitValidationError({
					message: `Cap for ${featureId} must be greater than zero`,
				})
			}
			featureCaps[featureId] = cap
		}

		return {
			monthlyLimitCents: limit,
			enforcementMode: request.enforcementMode,
			alertThresholdPercents: thresholds,
			featureCaps,
		}
	})

export class SpendLimitsService extends Context.Service<SpendLimitsService, SpendLimitsServiceShape>()(
	"@maple/api/services/SpendLimitsService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database

			const selectRow = (orgId: OrgId) =>
				runDb(
					"select",
					database.execute((db) =>
						db.select().from(orgSpendLimits).where(eq(orgSpendLimits.orgId, orgId)).limit(1),
					),
				).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])))

			const get = Effect.fn("SpendLimitsService.get")(function* (orgId: OrgId) {
				const row = yield* selectRow(orgId)
				return Option.match(row, {
					onNone: () => DEFAULT_LIMITS,
					onSome: rowToResponse,
				})
			})

			const update = Effect.fn("SpendLimitsService.update")(function* (
				orgId: OrgId,
				request: UpdateSpendLimitsRequest,
				updatedBy: string,
			) {
				const validated = yield* validateSpendLimits(request)
				const now = new Date(yield* Clock.currentTimeMillis)

				// Switching to notify-only lifts an active pause immediately: the row is
				// what the ingest gateway reads, so leaving `pausedAt` set would keep
				// 402ing until the next cron tick even though the user just turned
				// enforcement off.
				const pausedAt = validated.enforcementMode === "pause" ? undefined : null

				yield* runDb(
					"upsert",
					database.execute((db) =>
						db
							.insert(orgSpendLimits)
							.values({
								orgId,
								monthlyLimitCents: validated.monthlyLimitCents,
								enforcementMode: validated.enforcementMode,
								alertThresholdPercents: validated.alertThresholdPercents,
								featureCaps: validated.featureCaps,
								createdAt: now,
								updatedAt: now,
								updatedBy,
							})
							.onConflictDoUpdate({
								target: orgSpendLimits.orgId,
								set: {
									monthlyLimitCents: validated.monthlyLimitCents,
									enforcementMode: validated.enforcementMode,
									alertThresholdPercents: validated.alertThresholdPercents,
									featureCaps: validated.featureCaps,
									updatedAt: now,
									updatedBy,
									...(pausedAt === null ? { pausedAt: null } : {}),
								},
							}),
					),
				)

				return yield* get(orgId)
			})

			const recordEvaluation = Effect.fn("SpendLimitsService.recordEvaluation")(function* (
				orgId: OrgId,
				evaluation: SpendEvaluationRecord,
			) {
				const existing = yield* selectRow(orgId)
				if (Option.isNone(existing)) return
				const row = existing.value
				const now = new Date(yield* Clock.currentTimeMillis)
				const cycleStart = new Date(evaluation.cycleStartMs)

				// A new cycle resets breach/pause state: last month's overspend must not
				// keep this month's ingestion paused.
				const sameCycle = row.cycleStartedAt?.getTime() === cycleStart.getTime()
				const breachedAt = evaluation.breached
					? sameCycle && row.breachedAt !== null
						? row.breachedAt
						: now
					: null

				yield* runDb(
					"recordEvaluation",
					database.execute((db) =>
						db
							.update(orgSpendLimits)
							.set({
								lastEvaluatedAt: now,
								evaluatedSpendCents: Math.round(evaluation.spendCents),
								breachedAt,
								pausedAt:
									evaluation.breached && row.enforcementMode === "pause"
										? (breachedAt ?? now)
										: null,
								notifiedThresholds: evaluation.notifiedThresholds,
								// Cap pauses are per signal and independent of the spend
								// ceiling, but they still only bite in pause mode.
								pausedFeatures:
									row.enforcementMode === "pause" ? (evaluation.exceededCaps ?? []) : [],
								cycleStartedAt: cycleStart,
								updatedAt: now,
							})
							.where(eq(orgSpendLimits.orgId, orgId)),
					),
				)
			})

			const listConfigured = Effect.fn("SpendLimitsService.listConfigured")(function* () {
				const rows = yield* runDb(
					"listConfigured",
					database.execute((db) => db.select().from(orgSpendLimits)),
				)
				// An org with no ceiling and no caps has nothing to evaluate — skip it
				// rather than spending an Autumn round-trip per tick on a default row.
				return rows
					.filter(
						(row) =>
							row.monthlyLimitCents !== null || Object.keys(row.featureCaps ?? {}).length > 0,
					)
					.map((row) => ({
						orgId: row.orgId,
						limits: rowToResponse(row),
						notifiedThresholds: row.notifiedThresholds,
						cycleStartedAtMs: msOrNull(row.cycleStartedAt),
					}))
			})

			return { get, update, recordEvaluation, listConfigured } satisfies SpendLimitsServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
