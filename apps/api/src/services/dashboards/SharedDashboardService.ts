/**
 * Share links for dashboards.
 *
 * At most one live share per dashboard, enforced by a partial unique index on
 * `(org_id, dashboard_id) WHERE revoked_at IS NULL`. Revoke and rotate are the
 * same underlying move — stamp `revoked_at`, and for a rotate insert a fresh
 * row in the same transaction — so a link can never be resurrected and two
 * links can never be live at once.
 *
 * The raw token exists only in the response to `create` and `rotate`. Storage
 * keeps an HMAC and a short suffix, so nothing here can hand a caller back a
 * link they failed to copy.
 */
import {
	DashboardId,
	DashboardShare,
	DashboardShareCreated,
	DashboardShareId,
	type DashboardShareMode,
	DashboardShareTombstone,
	IsoDateTimeString,
	OrgId,
	SHARE_NOT_FOUND_MESSAGE,
	ShareNotConfiguredError,
	ShareNotFoundError,
	SharePersistenceError,
	UserId,
} from "@maple/domain/http"
import { dashboardShares, generateShareToken, hashShareToken, shareTokenSuffix } from "@maple/db"
import { and, eq, isNull } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { Database } from "@/platform/DatabaseLive"
import { postgresSqlState } from "@/platform/postgres-errors"
import { dateToMs, msToDate } from "@/platform/time"
import { Env } from "@/platform/Env"

/** SQLSTATE for `unique_violation` — here, `dashboard_shares_live_unq`. */
const UNIQUE_VIOLATION = "23505"

const decodeShareIdSync = Schema.decodeUnknownSync(DashboardShareId)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(IsoDateTimeString)

/**
 * The scope a share covers. `null` widget id means the whole dashboard.
 *
 * Passed around as an explicit value rather than an optional argument so that
 * "which scope" is never accidentally defaulted — a rotate that silently fell
 * back to the dashboard-wide row would mint a board-wide link where the caller
 * asked for a chart-wide one.
 */
export interface ShareScope {
	readonly dashboardId: DashboardId
	readonly widgetId: string | null
}

/**
 * Matches exactly one scope. Postgres compares NULL with `=` as unknown, so the
 * whole-board scope has to be selected with `is null` rather than `= null` —
 * getting this wrong silently matches nothing and reads as "not shared".
 */
const scopeMatches = (scope: ShareScope) =>
	scope.widgetId === null ? isNull(dashboardShares.widgetId) : eq(dashboardShares.widgetId, scope.widgetId)

const toPersistenceError = (error: unknown) =>
	new SharePersistenceError({
		message: error instanceof Error ? error.message : "Share persistence failed",
		cause: error,
	})

interface ShareRowShape {
	readonly id: DashboardShareId
	readonly orgId: OrgId
	readonly dashboardId: DashboardId
	readonly widgetId: string | null
	readonly mode: DashboardShareMode
	readonly tokenSuffix: string
	readonly createdAt: Date
	readonly updatedAt: Date
}

const toDashboardShare = (row: ShareRowShape) =>
	new DashboardShare({
		id: row.id,
		dashboardId: row.dashboardId,
		...(row.widgetId === null ? {} : { widgetId: row.widgetId }),
		mode: row.mode,
		tokenSuffix: row.tokenSuffix,
		createdAt: decodeIsoDateTimeStringSync(new Date(dateToMs(row.createdAt)).toISOString()),
		updatedAt: decodeIsoDateTimeStringSync(new Date(dateToMs(row.updatedAt)).toISOString()),
	})

/** Columns every read here projects. Keeps `token_hash` out of memory by default. */
const shareColumns = {
	id: dashboardShares.id,
	orgId: dashboardShares.orgId,
	dashboardId: dashboardShares.dashboardId,
	widgetId: dashboardShares.widgetId,
	mode: dashboardShares.mode,
	tokenSuffix: dashboardShares.tokenSuffix,
	createdAt: dashboardShares.createdAt,
	updatedAt: dashboardShares.updatedAt,
} as const

export interface SharedDashboardServiceApi {
	/** The live share for one scope, or `None`. Never includes the raw token. */
	readonly get: (
		orgId: OrgId,
		scope: ShareScope,
	) => Effect.Effect<Option.Option<DashboardShare>, SharePersistenceError>

	/** Every live share on a dashboard — the board's own, plus one per widget. */
	readonly listForDashboard: (
		orgId: OrgId,
		dashboardId: DashboardId,
	) => Effect.Effect<ReadonlyArray<DashboardShare>, SharePersistenceError>

	/**
	 * Create the share for a scope, or change the mode of the one it already
	 * has. Returns a raw token only when one was minted.
	 */
	readonly upsert: (
		orgId: OrgId,
		userId: UserId,
		scope: ShareScope,
		mode: DashboardShareMode,
	) => Effect.Effect<DashboardShareCreated, SharePersistenceError | ShareNotConfiguredError>

	/** Revoke a scope's current link and mint a replacement in one transaction. */
	readonly rotate: (
		orgId: OrgId,
		userId: UserId,
		scope: ShareScope,
	) => Effect.Effect<
		DashboardShareCreated,
		SharePersistenceError | ShareNotConfiguredError | ShareNotFoundError
	>

	/** Stop sharing a scope. Idempotent: revoking an unshared scope is not an error. */
	readonly revoke: (
		orgId: OrgId,
		userId: UserId,
		scope: ShareScope,
	) => Effect.Effect<DashboardShareTombstone, SharePersistenceError>

	/**
	 * Resolve a raw token to its live share.
	 *
	 * Fails with `ShareNotFoundError` for unknown *and* revoked tokens alike —
	 * the query itself filters `revoked_at is null`, so the two cases are the
	 * same single indexed lookup and offer no timing or body distinction.
	 */
	readonly resolveByToken: (
		token: string,
	) => Effect.Effect<
		{ readonly share: DashboardShare; readonly orgId: OrgId },
		SharePersistenceError | ShareNotConfiguredError | ShareNotFoundError
	>
}

export class SharedDashboardService extends Context.Service<
	SharedDashboardService,
	SharedDashboardServiceApi
>()("@maple/api/services/SharedDashboardService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env

		/**
		 * The HMAC key is optional in `Env` so the many suites that never touch
		 * sharing need no stub; a deployment supplies it via `alchemy.run.ts`.
		 * Absent, every operation fails here rather than hashing under a fallback,
		 * which would mint links that stop resolving the moment the real key lands.
		 */
		const requireHmacKey = Effect.suspend(() =>
			Option.match(env.MAPLE_SHARE_TOKEN_HMAC_KEY, {
				onNone: () =>
					Effect.fail(
						new ShareNotConfiguredError({
							message: "Dashboard sharing is not configured on this deployment.",
						}),
					),
				onSome: (key) => Effect.succeed(Redacted.value(key)),
			}),
		)

		const loadLive = (orgId: OrgId, scope: ShareScope) =>
			database
				.execute((db) =>
					db
						.select(shareColumns)
						.from(dashboardShares)
						.where(
							and(
								eq(dashboardShares.orgId, orgId),
								eq(dashboardShares.dashboardId, scope.dashboardId),
								scopeMatches(scope),
								isNull(dashboardShares.revokedAt),
							),
						),
				)
				.pipe(Effect.mapError(toPersistenceError))

		const get = Effect.fn("SharedDashboardService.get")(function* (orgId: OrgId, scope: ShareScope) {
			yield* Effect.annotateCurrentSpan({
				orgId,
				"maple.dashboard.id": scope.dashboardId,
				"maple.share.scope": scope.widgetId === null ? "dashboard" : "widget",
			})
			const rows = yield* loadLive(orgId, scope)
			const row = rows[0]
			return row === undefined ? Option.none() : Option.some(toDashboardShare(row))
		})

		/** Every live share on a dashboard: the board's own, plus one per widget. */
		const listForDashboard = Effect.fn("SharedDashboardService.listForDashboard")(function* (
			orgId: OrgId,
			dashboardId: DashboardId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.dashboard.id": dashboardId })
			const rows = yield* database
				.execute((db) =>
					db
						.select(shareColumns)
						.from(dashboardShares)
						.where(
							and(
								eq(dashboardShares.orgId, orgId),
								eq(dashboardShares.dashboardId, dashboardId),
								isNull(dashboardShares.revokedAt),
							),
						),
				)
				.pipe(Effect.mapError(toPersistenceError))
			return rows.map(toDashboardShare)
		})

		/** Mint a token and insert the row. Shared by create and rotate. */
		const mintRow = (
			orgId: OrgId,
			userId: UserId,
			scope: ShareScope,
			mode: DashboardShareMode,
			hmacKey: string,
			now: number,
		) => {
			const rawToken = generateShareToken()
			return {
				rawToken,
				values: {
					orgId,
					id: decodeShareIdSync(`dshare_${randomUUID()}`),
					dashboardId: scope.dashboardId,
					widgetId: scope.widgetId,
					mode,
					tokenHash: hashShareToken(rawToken, hmacKey),
					tokenSuffix: shareTokenSuffix(rawToken),
					createdAt: msToDate(now),
					createdBy: userId,
					updatedAt: msToDate(now),
					updatedBy: userId,
					revokedAt: null,
				},
			}
		}

		const upsert = Effect.fn("SharedDashboardService.upsert")(function* (
			orgId: OrgId,
			userId: UserId,
			scope: ShareScope,
			mode: DashboardShareMode,
		) {
			yield* Effect.annotateCurrentSpan({
				orgId,
				"tenant.userId": userId,
				"maple.dashboard.id": scope.dashboardId,
				"maple.share.scope": scope.widgetId === null ? "dashboard" : "widget",
				"maple.share.mode": mode,
			})
			const hmacKey = yield* requireHmacKey
			const now = yield* Clock.currentTimeMillis

			// Already shared: a mode change must keep the same link working, so this
			// updates in place rather than rotating. No token is minted, and none is
			// returned — the caller already has it, and we could not produce it again
			// even if they had lost it.
			const updateMode = (shareId: DashboardShareId) =>
				Effect.gen(function* () {
					const updated = yield* database
						.execute((db) =>
							db
								.update(dashboardShares)
								.set({ mode, updatedAt: msToDate(now), updatedBy: userId })
								.where(
									and(
										eq(dashboardShares.orgId, orgId),
										eq(dashboardShares.id, shareId),
										isNull(dashboardShares.revokedAt),
									),
								)
								.returning(shareColumns),
						)
						.pipe(Effect.mapError(toPersistenceError))

					const row = updated[0]
					if (row === undefined) {
						return yield* Effect.fail(
							new SharePersistenceError({
								message: "Share disappeared while updating its mode",
							}),
						)
					}
					yield* Effect.annotateCurrentSpan("maple.share.id", row.id)
					return new DashboardShareCreated({ share: toDashboardShare(row) })
				})

			const existingRows = yield* loadLive(orgId, scope)
			const existing = existingRows[0]
			if (existing !== undefined) return yield* updateMode(existing.id)

			const { rawToken, values } = mintRow(orgId, userId, scope, mode, hmacKey, now)

			// The read above and this insert are not one transaction, and making them
			// one would not help: two concurrent creates both read "not shared", both
			// insert, and `dashboard_shares_live_unq` fails the loser either way. So
			// the loser is handled rather than prevented — a double-click producing a
			// 503 is exactly what `revoke` was made idempotent to avoid.
			const attempt = yield* database
				.execute((db) => db.insert(dashboardShares).values(values).returning(shareColumns))
				.pipe(
					Effect.map((rows) => ({ raced: false, rows }) as const),
					Effect.catch((error) =>
						postgresSqlState(error) === UNIQUE_VIOLATION
							? Effect.succeed({ raced: true, rows: [] } as const)
							: Effect.fail(toPersistenceError(error)),
					),
				)

			// Lost the race: behave as if this call had simply arrived second, which
			// is the update-in-place branch — the winner's share, and no token.
			if (attempt.raced) {
				yield* Effect.annotateCurrentSpan("maple.share.insert_raced", true)
				const winner = (yield* loadLive(orgId, scope))[0]
				if (winner === undefined) {
					return yield* Effect.fail(
						new SharePersistenceError({
							message: "Share insert conflicted but no live share was found",
						}),
					)
				}
				return yield* updateMode(winner.id)
			}

			const row = attempt.rows[0]
			if (row === undefined) {
				return yield* Effect.fail(
					new SharePersistenceError({ message: "Share insert returned no row" }),
				)
			}
			yield* Effect.annotateCurrentSpan("maple.share.id", row.id)
			return new DashboardShareCreated({ share: toDashboardShare(row), token: rawToken })
		})

		const rotate = Effect.fn("SharedDashboardService.rotate")(function* (
			orgId: OrgId,
			userId: UserId,
			scope: ShareScope,
		) {
			yield* Effect.annotateCurrentSpan({
				orgId,
				"tenant.userId": userId,
				"maple.dashboard.id": scope.dashboardId,
				"maple.share.scope": scope.widgetId === null ? "dashboard" : "widget",
			})
			const hmacKey = yield* requireHmacKey
			const now = yield* Clock.currentTimeMillis

			const existingRows = yield* loadLive(orgId, scope)
			const existing = existingRows[0]
			if (existing === undefined) {
				return yield* Effect.fail(new ShareNotFoundError({ message: SHARE_NOT_FOUND_MESSAGE }))
			}

			const { rawToken, values } = mintRow(orgId, userId, scope, existing.mode, hmacKey, now)

			// One transaction: the old row must stop resolving at the same instant the
			// new one starts. Revoke first so the partial unique index — one live row
			// per dashboard — is satisfied when the insert lands.
			const inserted = yield* database
				.execute((db) =>
					db.transaction(async (tx) => {
						await tx
							.update(dashboardShares)
							.set({ revokedAt: msToDate(now), updatedAt: msToDate(now), updatedBy: userId })
							.where(and(eq(dashboardShares.orgId, orgId), eq(dashboardShares.id, existing.id)))
						return tx.insert(dashboardShares).values(values).returning(shareColumns)
					}),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const row = inserted[0]
			if (row === undefined) {
				return yield* Effect.fail(
					new SharePersistenceError({ message: "Share rotate returned no row" }),
				)
			}
			yield* Effect.annotateCurrentSpan("maple.share.id", row.id)
			return new DashboardShareCreated({ share: toDashboardShare(row), token: rawToken })
		})

		const revoke = Effect.fn("SharedDashboardService.revoke")(function* (
			orgId: OrgId,
			userId: UserId,
			scope: ShareScope,
		) {
			yield* Effect.annotateCurrentSpan({
				orgId,
				"tenant.userId": userId,
				"maple.dashboard.id": scope.dashboardId,
				"maple.share.scope": scope.widgetId === null ? "dashboard" : "widget",
			})
			const now = yield* Clock.currentTimeMillis

			const revoked = yield* database
				.execute((db) =>
					db
						.update(dashboardShares)
						// `updatedBy` too, not just the timestamp: revoked rows are kept
						// for audit, and a row that records only who *created* the link
						// cannot answer who took it down.
						.set({ revokedAt: msToDate(now), updatedAt: msToDate(now), updatedBy: userId })
						.where(
							and(
								eq(dashboardShares.orgId, orgId),
								eq(dashboardShares.dashboardId, scope.dashboardId),
								scopeMatches(scope),
								isNull(dashboardShares.revokedAt),
							),
						)
						.returning({ id: dashboardShares.id }),
				)
				.pipe(Effect.mapError(toPersistenceError))

			// Idempotent by design: "stop sharing" on a dashboard that was never
			// shared is a no-op, not a 404. The dialog can call it without first
			// checking, and a double-click cannot produce an error.
			return new DashboardShareTombstone({
				dashboardId: scope.dashboardId,
				revoked: revoked.length > 0,
			})
		})

		const resolveByToken = Effect.fn("SharedDashboardService.resolveByToken")(function* (token: string) {
			const hmacKey = yield* requireHmacKey
			const tokenHash = hashShareToken(token, hmacKey)

			const rows = yield* database
				.execute((db) =>
					db
						.select(shareColumns)
						.from(dashboardShares)
						.where(
							and(eq(dashboardShares.tokenHash, tokenHash), isNull(dashboardShares.revokedAt)),
						),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const row = rows[0]
			if (row === undefined) {
				return yield* Effect.fail(new ShareNotFoundError({ message: SHARE_NOT_FOUND_MESSAGE }))
			}

			// The share id and org, never the token or its hash.
			yield* Effect.annotateCurrentSpan({
				"maple.share.id": row.id,
				orgId: row.orgId,
				"maple.dashboard.id": row.dashboardId,
			})
			return { share: toDashboardShare(row), orgId: row.orgId }
		})

		return {
			get,
			listForDashboard,
			upsert,
			rotate,
			revoke,
			resolveByToken,
		} satisfies SharedDashboardServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)

	static readonly get = (orgId: OrgId, scope: ShareScope) =>
		this.use((service) => service.get(orgId, scope))

	static readonly listForDashboard = (orgId: OrgId, dashboardId: DashboardId) =>
		this.use((service) => service.listForDashboard(orgId, dashboardId))

	static readonly upsert = (orgId: OrgId, userId: UserId, scope: ShareScope, mode: DashboardShareMode) =>
		this.use((service) => service.upsert(orgId, userId, scope, mode))

	static readonly rotate = (orgId: OrgId, userId: UserId, scope: ShareScope) =>
		this.use((service) => service.rotate(orgId, userId, scope))

	static readonly revoke = (orgId: OrgId, userId: UserId, scope: ShareScope) =>
		this.use((service) => service.revoke(orgId, userId, scope))

	static readonly resolveByToken = (token: string) => this.use((service) => service.resolveByToken(token))
}
