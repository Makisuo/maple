/**
 * Share links for dashboards.
 *
 * At most one live share per dashboard, enforced by a partial unique index on
 * `(org_id, dashboard_id) WHERE revoked_at IS NULL`. Revoke and rotate are the
 * same underlying move — stamp `revoked_at`, and for a rotate insert a fresh
 * row in the same transaction — so a link can never be resurrected and two
 * links can never be live at once.
 *
 * Storage keeps two derivations of the raw token: an HMAC, which is what
 * resolution looks up, and an AES-256-GCM ciphertext, which is what lets an
 * owner read their own link back at any time. The encryption key lives in the
 * Worker's secrets and never in Postgres, so a database dump on its own is
 * still not a set of working links.
 */
import {
	DashboardId,
	DashboardShare,
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
import { decryptAes256Gcm, encryptAes256Gcm, parseBase64Aes256GcmKey } from "@/platform/Crypto"
import { Database } from "@/platform/DatabaseLive"
import { postgresSqlState } from "@/platform/postgres-errors"
import { msToDate } from "@/platform/time"
import { Env } from "@/platform/Env"

/** SQLSTATE for `unique_violation` — here, `dashboard_shares_live_unq`. */
const UNIQUE_VIOLATION = "23505"

/**
 * AAD for a stored share token. Authenticated but not stored, so it binds the
 * ciphertext to its row: someone with database write access cannot move an
 * `(iv, ciphertext, tag)` triple onto another org's share and have it decrypt.
 */
const shareTokenAad = (orgId: string, shareId: string): Buffer =>
	Buffer.from(`dashboard_shares:v1:${orgId}:${shareId}:token`, "utf8")

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
	readonly tokenCiphertext: string
	readonly tokenIv: string
	readonly tokenTag: string
	readonly tokenSuffix: string
	readonly createdAt: Date
	readonly updatedAt: Date
}

const toDashboardShare = (row: ShareRowShape, token: string) =>
	new DashboardShare({
		id: row.id,
		dashboardId: row.dashboardId,
		...(row.widgetId === null ? {} : { widgetId: row.widgetId }),
		mode: row.mode,
		token,
		tokenSuffix: row.tokenSuffix,
		createdAt: decodeIsoDateTimeStringSync(row.createdAt.toISOString()),
		updatedAt: decodeIsoDateTimeStringSync(row.updatedAt.toISOString()),
	})

/** Columns every read here projects. Keeps `token_hash` out of memory by default. */
const shareColumns = {
	id: dashboardShares.id,
	orgId: dashboardShares.orgId,
	dashboardId: dashboardShares.dashboardId,
	widgetId: dashboardShares.widgetId,
	mode: dashboardShares.mode,
	tokenCiphertext: dashboardShares.tokenCiphertext,
	tokenIv: dashboardShares.tokenIv,
	tokenTag: dashboardShares.tokenTag,
	tokenSuffix: dashboardShares.tokenSuffix,
	createdAt: dashboardShares.createdAt,
	updatedAt: dashboardShares.updatedAt,
} as const

export interface SharedDashboardServiceApi {
	/** The live share for one scope, or `None`. Carries the decrypted token. */
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
	 * has. A mode change keeps the existing link, so the token comes back
	 * unchanged rather than absent.
	 */
	readonly upsert: (
		orgId: OrgId,
		userId: UserId,
		scope: ShareScope,
		mode: DashboardShareMode,
	) => Effect.Effect<DashboardShare, SharePersistenceError | ShareNotConfiguredError>

	/** Revoke a scope's current link and mint a replacement in one transaction. */
	readonly rotate: (
		orgId: OrgId,
		userId: UserId,
		scope: ShareScope,
	) => Effect.Effect<DashboardShare, SharePersistenceError | ShareNotConfiguredError | ShareNotFoundError>

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

		/*
		 * Unlike the HMAC key this one is required in `Env` and already carries
		 * every other secret this app stores at rest, so there is no "not
		 * configured" case to model — a value that is not base64 for 32 bytes is a
		 * broken deployment, which is a defect rather than an expected failure.
		 */
		const encryptionKey = yield* parseBase64Aes256GcmKey(
			Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			(message) => new Error(`MAPLE_INGEST_KEY_ENCRYPTION_KEY: ${message}`),
		).pipe(Effect.orDie)

		/**
		 * A row whose token will not decrypt is a storage-integrity failure, not a
		 * missing share: the link still resolves for viewers (that path reads the
		 * HMAC), so reporting it as "not shared" would hide a live public link from
		 * the only people who can revoke it.
		 */
		const readToken = (row: ShareRowShape) =>
			decryptAes256Gcm(
				{ ciphertext: row.tokenCiphertext, iv: row.tokenIv, tag: row.tokenTag },
				encryptionKey,
				() =>
					new SharePersistenceError({
						message: `Stored share token for ${row.id} could not be decrypted`,
					}),
				shareTokenAad(row.orgId, row.id),
			)

		const decodeShare = (row: ShareRowShape) =>
			readToken(row).pipe(Effect.map((token) => toDashboardShare(row, token)))

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
			return row === undefined ? Option.none() : Option.some(yield* decodeShare(row))
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
			return yield* Effect.forEach(rows, decodeShare)
		})

		/**
		 * Mint a token and build the row. Shared by create and rotate.
		 *
		 * The share id is drawn here rather than by the database because the AAD
		 * binds the ciphertext to it — the value has to exist before the token can
		 * be encrypted for that row.
		 */
		const mintRow = Effect.fnUntraced(function* (
			orgId: OrgId,
			userId: UserId,
			scope: ShareScope,
			mode: DashboardShareMode,
			hmacKey: string,
			now: number,
		) {
			const rawToken = generateShareToken()
			const id = decodeShareIdSync(`dshare_${randomUUID()}`)
			const encrypted = yield* encryptAes256Gcm(
				rawToken,
				encryptionKey,
				(message) => new SharePersistenceError({ message: `Share token encryption: ${message}` }),
				shareTokenAad(orgId, id),
			)
			return {
				rawToken,
				values: {
					orgId,
					id,
					dashboardId: scope.dashboardId,
					widgetId: scope.widgetId,
					mode,
					tokenHash: hashShareToken(rawToken, hmacKey),
					tokenCiphertext: encrypted.ciphertext,
					tokenIv: encrypted.iv,
					tokenTag: encrypted.tag,
					tokenSuffix: shareTokenSuffix(rawToken),
					createdAt: msToDate(now),
					createdBy: userId,
					updatedAt: msToDate(now),
					updatedBy: userId,
					revokedAt: null,
				},
			}
		})

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
			// updates in place rather than rotating. Nothing is minted; the token
			// that comes back is the stored one, decrypted, so the caller sees the
			// same URL it had before.
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
					return yield* decodeShare(row)
				})

			const existingRows = yield* loadLive(orgId, scope)
			const existing = existingRows[0]
			if (existing !== undefined) return yield* updateMode(existing.id)

			const { rawToken, values } = yield* mintRow(orgId, userId, scope, mode, hmacKey, now)

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
			// is the update-in-place branch — the winner's share, and the winner's link.
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
			// The freshly minted token, not a decrypt of what was just written — same
			// value, one less round through the cipher.
			return toDashboardShare(row, rawToken)
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

			const { rawToken, values } = yield* mintRow(orgId, userId, scope, existing.mode, hmacKey, now)

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
			// The freshly minted token, not a decrypt of what was just written — same
			// value, one less round through the cipher.
			return toDashboardShare(row, rawToken)
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
			// `token` is the one the caller presented — it hashed to this row, so it
			// is by definition the stored one, and decrypting to prove that again
			// would only add a cipher round to the viewer hot path.
			return { share: toDashboardShare(row, token), orgId: row.orgId }
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
