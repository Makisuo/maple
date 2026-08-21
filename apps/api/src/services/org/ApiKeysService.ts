import { randomUUID } from "node:crypto"
import {
	ApiKeyId,
	type ApiKeyKind,
	ApiKeyCreatedResponse,
	ApiKeyLookupPersistenceError,
	ApiKeyNotFoundError,
	ApiKeyPersistenceError,
	ApiKeyResponse,
	ApiKeysListResponse,
	OrgId,
	type PostgresTransactionId,
	UserId,
	RoleName,
} from "@maple/domain/http"
import { API_KEY_PREFIX, apiKeys, generateApiKey, hashApiKey, parseIngestKeyLookupHmacKey } from "@maple/db"
import { and, desc, eq, getTableColumns, isNull, lt, ne, or, sql } from "drizzle-orm"
import { Clock, Effect, Layer, Option, Redacted, Schema, Context } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { readTxid, txidColumn } from "@/platform/electric-txid"
import { forkRequestScoped } from "@/platform/fork-request-scoped"
import { Env } from "@/platform/Env"
import { dateToMs, msToDate } from "@/platform/time"

export interface ResolvedApiKey {
	readonly orgId: OrgId
	readonly userId: UserId
	readonly keyId: ApiKeyId
	readonly kind: ApiKeyKind
	readonly metadataJson: string | null
	/** v2 scope strings; null = legacy full access. */
	readonly scopes: ReadonlyArray<string> | null
	readonly roles: ReadonlyArray<RoleName> | null
	readonly cliManaged: boolean
	readonly mcpOAuthResource: string | null
}

const CliApiKeyMetadata = Schema.Struct({
	source: Schema.Literal("maple_cli"),
	roles: Schema.Array(RoleName),
	deviceName: Schema.String,
})
const decodeCliApiKeyMetadata = Schema.decodeUnknownOption(CliApiKeyMetadata)

/**
 * Metadata written when a member mints an MCP key for themselves: the creator's
 * own roles are pinned to the key so it can never carry more authority than the
 * user who created it (an absent `roles` resolves to `root` downstream).
 */
const McpApiKeyMetadata = Schema.Struct({
	source: Schema.Literal("maple_mcp"),
	roles: Schema.Array(RoleName),
})
const decodeMcpApiKeyMetadata = Schema.decodeUnknownOption(McpApiKeyMetadata)

/**
 * Metadata written when a signed-in app mints a credential for one of its own
 * devices. Two fields carry weight:
 *
 * - `roles` pins the *minting user's* roles onto the key, so a credential that
 *   lives on a phone can never outrank the human who created it. Without it the
 *   key would resolve with the `root` default in `ApiAuthorizationV2Layer`,
 *   fenced only by its scopes.
 * - `deviceId` is what makes the credential replaceable: minting is idempotent
 *   per device, so a reinstall or a roll retires the previous key instead of
 *   leaving a live one behind on a phone nobody has any more.
 */
const DeviceApiKeyMetadata = Schema.Struct({
	source: Schema.Literal("maple_ios_widget"),
	roles: Schema.Array(RoleName),
	deviceId: Schema.String,
})
const decodeDeviceApiKeyMetadata = Schema.decodeUnknownOption(DeviceApiKeyMetadata)

/** The one `source` a `kind: "device"` key may carry today. */
export const WIDGET_DEVICE_KEY_SOURCE = "maple_ios_widget"

const McpOAuthApiKeyMetadata = Schema.Struct({
	source: Schema.Literal("maple_mcp_oauth"),
	roles: Schema.Array(RoleName),
	clientId: Schema.String,
	resource: Schema.String,
})
const decodeMcpOAuthApiKeyMetadata = Schema.decodeUnknownOption(McpOAuthApiKeyMetadata)

/** Metadata `source` values that pin roles onto a key. */
const ROLE_BEARING_SOURCES = ["maple_cli", "maple_mcp", "maple_mcp_oauth", WIDGET_DEVICE_KEY_SOURCE] as const

interface KeyRoleMetadata {
	readonly roles: ReadonlyArray<RoleName> | null
	readonly cliManaged: boolean
	readonly mcpOAuthResource: string | null
}

/**
 * Read the roles pinned onto a key by its metadata. Fails closed: metadata that
 * declares a known role-bearing `source` but doesn't decode must not fall back
 * to the null (= `root`) default, so the key is rejected outright.
 */
const readKeyRoleMetadata = (metadata: unknown): Option.Option<KeyRoleMetadata> => {
	if (typeof metadata !== "object" || metadata === null || !("source" in metadata)) {
		return Option.some({ roles: null, cliManaged: false, mcpOAuthResource: null })
	}

	const source = (metadata as { source?: unknown }).source
	const cli = decodeCliApiKeyMetadata(metadata)
	if (Option.isSome(cli)) {
		return Option.some({ roles: cli.value.roles, cliManaged: true, mcpOAuthResource: null })
	}
	const mcp = decodeMcpApiKeyMetadata(metadata)
	if (Option.isSome(mcp)) {
		return Option.some({ roles: mcp.value.roles, cliManaged: false, mcpOAuthResource: null })
	}
	const device = decodeDeviceApiKeyMetadata(metadata)
	if (Option.isSome(device)) {
		return Option.some({ roles: device.value.roles, cliManaged: false, mcpOAuthResource: null })
	}
	const mcpOAuth = decodeMcpOAuthApiKeyMetadata(metadata)
	if (Option.isSome(mcpOAuth)) {
		return Option.some({
			roles: mcpOAuth.value.roles,
			cliManaged: false,
			mcpOAuthResource: mcpOAuth.value.resource,
		})
	}

	if (typeof source === "string" && (ROLE_BEARING_SOURCES as ReadonlyArray<string>).includes(source)) {
		return Option.none()
	}
	return Option.some({ roles: null, cliManaged: false, mcpOAuthResource: null })
}

const decodeApiKeyIdSync = Schema.decodeUnknownSync(ApiKeyId)

const toPersistenceError = (error: unknown) =>
	new ApiKeyPersistenceError({
		message: error instanceof Error ? error.message : "API key persistence failed",
	})

const rowToResponse = (row: typeof apiKeys.$inferSelect, txid?: PostgresTransactionId): ApiKeyResponse =>
	new ApiKeyResponse({
		id: row.id,
		name: row.name,
		description: row.description ?? null,
		keyPrefix: row.keyPrefix,
		kind: row.kind,
		scopes: row.scopes ?? null,
		revoked: row.revoked,
		revokedAt: dateToMs(row.revokedAt),
		lastUsedAt: dateToMs(row.lastUsedAt),
		expiresAt: dateToMs(row.expiresAt),
		createdAt: row.createdAt.getTime(),
		createdBy: row.createdBy,
		createdByEmail: row.createdByEmail ?? null,
		...(txid !== undefined ? { txid } : undefined),
	})

export class ApiKeysService extends Context.Service<ApiKeysService>()("@maple/api/services/ApiKeysService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const hmacKey = parseIngestKeyLookupHmacKey(Redacted.value(env.MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY))

		const selectById = Effect.fn("ApiKeysService.selectById")(function* (orgId: OrgId, keyId: ApiKeyId) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.api_key.id": keyId })
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(apiKeys)
						.where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, orgId)))
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))

			return Option.fromNullishOr(rows[0])
		})

		const requireById = Effect.fn("ApiKeysService.requireById")(function* (
			orgId: OrgId,
			keyId: ApiKeyId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.api_key.id": keyId })
			const row = yield* selectById(orgId, keyId)
			if (Option.isSome(row)) return row.value

			return yield* Effect.fail(new ApiKeyNotFoundError({ keyId, message: "API key not found" }))
		})

		const get = Effect.fn("ApiKeysService.get")(function* (orgId: OrgId, keyId: ApiKeyId) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.api_key.id": keyId })
			const row = yield* requireById(orgId, keyId)
			return rowToResponse(row)
		})

		/**
		 * The organization's keys, **excluding device credentials**.
		 *
		 * A device key is not a thing anyone manages from the API-keys screen: it
		 * is minted, rolled, and revoked by the app that owns the phone, one per
		 * pinned organization per device. Listing them would put a dozen rows
		 * nobody created by hand in front of an admin looking for the two they
		 * did — and inviting them to revoke one just breaks a Home Screen until
		 * the app next mints again.
		 */
		const list = Effect.fn("ApiKeysService.list")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(apiKeys)
						.where(and(eq(apiKeys.orgId, orgId), ne(apiKeys.kind, "device")))
						.orderBy(desc(apiKeys.createdAt)),
				)
				.pipe(Effect.mapError(toPersistenceError))

			return new ApiKeysListResponse({
				keys: rows.map((row) => rowToResponse(row)),
			})
		})

		const create = Effect.fn("ApiKeysService.create")(function* (
			orgId: OrgId,
			userId: UserId,
			params: {
				name: string
				description?: string
				expiresInSeconds?: number
				kind?: ApiKeyKind
				scopes?: ReadonlyArray<string> | null
				createdByEmail?: string | null
				metadataJson?: unknown
			},
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "tenant.userId": userId })
			const id = decodeApiKeyIdSync(randomUUID())
			yield* Effect.annotateCurrentSpan("maple.api_key.id", id)
			const rawKey = generateApiKey()
			const keyHash = hashApiKey(rawKey, hmacKey)
			const keyPrefix = rawKey.slice(0, 12) + "..."
			const now = yield* Clock.currentTimeMillis
			const expiresAt = params.expiresInSeconds ? now + params.expiresInSeconds * 1000 : undefined
			const kind: ApiKeyKind = params.kind ?? "standard"
			const scopes = params.scopes == null ? null : [...params.scopes]
			const createdByEmail = params.createdByEmail ?? null

			const inserted = yield* database
				.execute((db) =>
					db
						.insert(apiKeys)
						.values({
							id,
							orgId,
							name: params.name,
							description: params.description ?? null,
							keyHash,
							keyPrefix,
							kind,
							scopes,
							expiresAt: msToDate(expiresAt),
							createdAt: new Date(now),
							createdBy: userId,
							createdByEmail,
							metadataJson: params.metadataJson,
						})
						.returning(txidColumn),
				)
				.pipe(Effect.mapError(toPersistenceError))
			const txid = readTxid(inserted)

			return new ApiKeyCreatedResponse({
				id,
				name: params.name,
				description: params.description ?? null,
				keyPrefix,
				kind,
				scopes,
				revoked: false,
				revokedAt: null,
				lastUsedAt: null,
				expiresAt: expiresAt ?? null,
				createdAt: now,
				createdBy: userId,
				createdByEmail,
				secret: rawKey,
				...(txid !== undefined ? { txid } : undefined),
			})
		})

		/**
		 * Matches the live device credentials this app minted for one device.
		 *
		 * Containment (`@>`) rather than three column comparisons because the
		 * association lives in `metadata_json`; the source is pinned too, so a
		 * future `kind: "device"` credential for something other than the widgets
		 * cannot be caught by a widget revoke.
		 */
		const liveDeviceKeysFor = (orgId: OrgId, deviceId: string) =>
			and(
				eq(apiKeys.orgId, orgId),
				eq(apiKeys.kind, "device"),
				eq(apiKeys.revoked, false),
				sql`${apiKeys.metadataJson} @> ${JSON.stringify({
					source: WIDGET_DEVICE_KEY_SOURCE,
					deviceId,
				})}::jsonb`,
			)

		/**
		 * Mint the widget credential for one device, retiring whatever it had.
		 *
		 * Every ceiling here is the server's, which is the whole point of a
		 * dedicated operation rather than `create` with a `kind`: the caller
		 * names a device and nothing else, so a compromised or simply wrong
		 * client cannot ask for wider scopes, a longer life, or more authority
		 * than the human running it.
		 *
		 * Idempotent per device: mint and roll are the same call, because the app
		 * re-mints on its own schedule and a phone that gets a new key must not
		 * leave the old one live. Revoke-then-insert inside one transaction, in
		 * that order, for the same reason `roll` does it that way.
		 */
		const replaceDeviceKey = Effect.fn("ApiKeysService.replaceDeviceKey")(function* (
			orgId: OrgId,
			userId: UserId,
			params: {
				deviceId: string
				name: string
				scopes: ReadonlyArray<string>
				expiresInSeconds: number
				roles: ReadonlyArray<RoleName>
				createdByEmail?: string | null
			},
		) {
			yield* Effect.annotateCurrentSpan({
				orgId,
				"tenant.userId": userId,
				"maple.device.id": params.deviceId,
			})
			const id = decodeApiKeyIdSync(randomUUID())
			const rawKey = generateApiKey()
			const keyHash = hashApiKey(rawKey, hmacKey)
			const keyPrefix = rawKey.slice(0, 12) + "..."
			const now = yield* Clock.currentTimeMillis
			const expiresAt = now + params.expiresInSeconds * 1000
			const scopes = [...params.scopes]
			const createdByEmail = params.createdByEmail ?? null

			const inserted = yield* database
				.execute((db) =>
					db.transaction(async (tx) => {
						await tx
							.update(apiKeys)
							.set({ revoked: true, revokedAt: msToDate(now) })
							.where(liveDeviceKeysFor(orgId, params.deviceId))
						return await tx
							.insert(apiKeys)
							.values({
								id,
								orgId,
								name: params.name,
								description: null,
								keyHash,
								keyPrefix,
								kind: "device",
								scopes,
								expiresAt: msToDate(expiresAt),
								createdAt: new Date(now),
								createdBy: userId,
								createdByEmail,
								metadataJson: {
									source: WIDGET_DEVICE_KEY_SOURCE,
									// The minting session's roles, so the key on the
									// phone can never outrank the human who created it.
									roles: [...params.roles],
									deviceId: params.deviceId,
								},
							})
							.returning(txidColumn)
					}),
				)
				.pipe(Effect.mapError(toPersistenceError))
			const txid = readTxid(inserted)

			return new ApiKeyCreatedResponse({
				id,
				name: params.name,
				description: null,
				keyPrefix,
				kind: "device",
				scopes,
				revoked: false,
				revokedAt: null,
				lastUsedAt: null,
				expiresAt,
				createdAt: now,
				createdBy: userId,
				createdByEmail,
				secret: rawKey,
				...(txid !== undefined ? { txid } : undefined),
			})
		})

		/**
		 * Retire one device's widget credentials. Called on sign-out, when the
		 * user leaves the organization, and when the widget is unpinned — the
		 * Home Screen outlives the session, and so would the key.
		 *
		 * Returns how many it retired, so a caller can tell "revoked" from
		 * "there was nothing to revoke" without a second read.
		 */
		const revokeDeviceKeys = Effect.fn("ApiKeysService.revokeDeviceKeys")(function* (
			orgId: OrgId,
			deviceId: string,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.device.id": deviceId })
			const now = yield* Clock.currentTimeMillis
			const revokedRows = yield* database
				.execute((db) =>
					db
						.update(apiKeys)
						.set({ revoked: true, revokedAt: msToDate(now) })
						.where(liveDeviceKeysFor(orgId, deviceId))
						.returning({ id: apiKeys.id }),
				)
				.pipe(Effect.mapError(toPersistenceError))
			return revokedRows.length
		})

		const roll = Effect.fn("ApiKeysService.roll")(function* (
			orgId: OrgId,
			userId: UserId,
			keyId: ApiKeyId,
			params: {
				createdByEmail?: string | null
			},
		) {
			yield* Effect.annotateCurrentSpan({
				orgId,
				"tenant.userId": userId,
				"maple.api_key.id": keyId,
			})
			const id = decodeApiKeyIdSync(randomUUID())
			const rawKey = generateApiKey()
			const keyHash = hashApiKey(rawKey, hmacKey)
			const keyPrefix = rawKey.slice(0, 12) + "..."
			const now = yield* Clock.currentTimeMillis
			const createdByEmail = params.createdByEmail ?? null

			// The revoke of the source row is the barrier, and it runs FIRST: the
			// `revoked = false` predicate means exactly one concurrent roll can
			// claim the row, and the row lock it takes makes a second roll (or a
			// racing revoke) re-read the committed state and match zero rows. Only
			// the transaction that actually claimed the source inserts a successor,
			// so a roll/roll race can no longer mint two live keys and a
			// revoke/roll race can no longer mint a successor for a dead one.
			const rolled = yield* database
				.execute((db) =>
					db.transaction(async (tx) => {
						const claimed = await tx
							.update(apiKeys)
							.set({ revoked: true, revokedAt: msToDate(now) })
							.where(
								and(
									eq(apiKeys.id, keyId),
									eq(apiKeys.orgId, orgId),
									eq(apiKeys.revoked, false),
								),
							)
							.returning({ ...getTableColumns(apiKeys), ...txidColumn })
						if (claimed.length === 0) return undefined
						const source = claimed[0]

						await tx.insert(apiKeys).values({
							id,
							orgId,
							name: source.name,
							description: source.description ?? null,
							keyHash,
							keyPrefix,
							kind: source.kind,
							scopes: source.scopes ?? null,
							// Carry the role metadata across: a rolled key that lost it
							// would resolve with the null (= `root`) default, silently
							// escalating a CLI/MCP key beyond its creator's roles.
							metadataJson: source.metadataJson,
							expiresAt: null,
							createdAt: msToDate(now),
							createdBy: userId,
							createdByEmail,
						})
						return source
					}),
				)
				.pipe(Effect.mapError(toPersistenceError))

			if (rolled === undefined) {
				// Lost the claim (or never had one): distinguish a key that does not
				// exist from one that was revoked out from under this roll.
				yield* requireById(orgId, keyId)
				return yield* Effect.fail(
					new ApiKeyNotFoundError({ keyId, message: "API key is already revoked" }),
				)
			}

			const txid = readTxid([rolled])

			return new ApiKeyCreatedResponse({
				id,
				name: rolled.name,
				description: rolled.description ?? null,
				keyPrefix,
				kind: rolled.kind,
				scopes: rolled.scopes ?? null,
				revoked: false,
				revokedAt: null,
				lastUsedAt: null,
				expiresAt: null,
				createdAt: now,
				createdBy: userId,
				createdByEmail,
				secret: rawKey,
				...(txid !== undefined ? { txid } : undefined),
			})
		})

		const revoke = Effect.fn("ApiKeysService.revoke")(function* (orgId: OrgId, keyId: ApiKeyId) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.api_key.id": keyId })
			const now = yield* Clock.currentTimeMillis

			// Conditional for the same reason `roll` is: a revoke that races a roll
			// must either claim the live row or observe that it is already dead —
			// never re-stamp `revoked_at` on a row someone else already retired
			// (which would also replicate a pointless row out through Electric).
			const revokedRows = yield* database
				.execute((db) =>
					db
						.update(apiKeys)
						.set({ revoked: true, revokedAt: msToDate(now) })
						.where(
							and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, orgId), eq(apiKeys.revoked, false)),
						)
						.returning({ ...getTableColumns(apiKeys), ...txidColumn }),
				)
				.pipe(Effect.mapError(toPersistenceError))

			// Lost the claim: either the key never existed (404) or it was already
			// revoked, in which case the stored row — not a freshly stamped copy —
			// is the truth to report back.
			if (revokedRows.length === 0) return rowToResponse(yield* requireById(orgId, keyId))

			return rowToResponse(revokedRows[0], readTxid(revokedRows))
		})

		const resolveByKey = Effect.fn("ApiKeysService.resolveByKey")(function* (rawKey: string) {
			if (!rawKey.startsWith(API_KEY_PREFIX)) return Option.none()

			const keyHash = hashApiKey(rawKey, hmacKey)
			const rows = yield* database
				.execute((db) => db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1))
				.pipe(Effect.mapError(toPersistenceError))

			const row = Option.fromNullishOr(rows[0])
			if (Option.isNone(row)) return Option.none()
			if (row.value.revoked) return Option.none()
			if (row.value.expiresAt) {
				const now = yield* Clock.currentTimeMillis
				if (row.value.expiresAt.getTime() < now) return Option.none()
			}

			const roleMetadata = readKeyRoleMetadata(row.value.metadataJson)
			if (Option.isNone(roleMetadata)) return Option.none()
			yield* Effect.annotateCurrentSpan({
				orgId: row.value.orgId,
				"tenant.userId": row.value.createdBy,
				"maple.api_key.id": row.value.id,
			})

			return Option.some({
				orgId: row.value.orgId,
				userId: row.value.createdBy,
				keyId: row.value.id,
				kind: row.value.kind,
				metadataJson: row.value.metadataJson == null ? null : JSON.stringify(row.value.metadataJson),
				scopes: row.value.scopes ?? null,
				roles: roleMetadata.value.roles,
				cliManaged: roleMetadata.value.cliManaged,
				mcpOAuthResource: roleMetadata.value.mcpOAuthResource,
			} satisfies ResolvedApiKey)
		})

		// Every API-key-authenticated request used to fire an unconditional
		// `UPDATE api_keys SET last_used_at = now()`. `api_keys` is Electric-synced
		// (electric_publication_default) and carries `last_used_at` in the browser
		// shape projection, so each of those writes decoded to a replication event
		// shipped out of PlanetScale and fanned out to every open tab in the org.
		//
		// Two gates, both needed:
		//   * the per-isolate memo skips the round trip entirely on a warm isolate;
		//   * the SQL predicate makes the write a *zero-row* UPDATE on a cold one,
		//     and Postgres writes no WAL tuple for a row it never touched. Without
		//     it, isolate churn would put us straight back to a write per request.
		//
		// The Map is built per service instance rather than at module scope for the
		// reason spelled out in ScrapeTargetsService — module scope would share one
		// memo across every database in a process, which breaks tests that build a
		// fresh PGlite per case.
		const LAST_USED_HEARTBEAT_MS = 5 * 60_000
		const lastUsedTouchMemo = new Map<string, number>()

		const touchLastUsed = Effect.fn("ApiKeysService.touchLastUsed")(function* (keyId: ApiKeyId) {
			yield* Effect.annotateCurrentSpan("maple.api_key.id", keyId)
			const now = yield* Clock.currentTimeMillis

			const touchedAt = lastUsedTouchMemo.get(keyId)
			if (touchedAt !== undefined && touchedAt > now - LAST_USED_HEARTBEAT_MS) {
				yield* Effect.annotateCurrentSpan("maple.api_key.last_used_memo_hit", true)
				return
			}
			yield* Effect.annotateCurrentSpan("maple.api_key.last_used_memo_hit", false)

			yield* database
				.execute((db) =>
					db
						.update(apiKeys)
						.set({ lastUsedAt: new Date(now) })
						.where(
							and(
								eq(apiKeys.id, keyId),
								or(
									isNull(apiKeys.lastUsedAt),
									lt(apiKeys.lastUsedAt, new Date(now - LAST_USED_HEARTBEAT_MS)),
								),
							),
						),
				)
				.pipe(Effect.mapError(toPersistenceError))

			lastUsedTouchMemo.set(keyId, now)
		})

		const resolveByBearer = Effect.fn("ApiKeysService.resolveByBearer")(function* (
			bearerToken: string | undefined,
		) {
			if (!bearerToken || !bearerToken.startsWith(API_KEY_PREFIX)) {
				return Option.none<ResolvedApiKey>()
			}

			const resolved = yield* resolveByKey(bearerToken).pipe(
				Effect.catchTag("@maple/http/errors/ApiKeyPersistenceError", (error) =>
					Effect.fail(new ApiKeyLookupPersistenceError({ message: error.message, cause: error })),
				),
			)
			if (Option.isSome(resolved)) {
				yield* Effect.annotateCurrentSpan({
					orgId: resolved.value.orgId,
					"tenant.userId": resolved.value.userId,
					"maple.api_key.id": resolved.value.keyId,
				})
				// Scoped, not detached: this write shares the request's single Postgres
				// connection, and a detached fiber can outlive its release.
				yield* forkRequestScoped(touchLastUsed(resolved.value.keyId).pipe(Effect.ignore))
			}
			return resolved
		})

		return {
			get,
			list,
			create,
			roll,
			revoke,
			resolveByKey,
			resolveByBearer,
			touchLastUsed,
			replaceDeviceKey,
			revokeDeviceKeys,
		}
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
