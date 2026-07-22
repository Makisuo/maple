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
import { and, desc, eq } from "drizzle-orm"
import { Clock, Effect, Layer, Option, Redacted, Schema, Context } from "effect"
import { Database } from "../lib/DatabaseLive"
import { readTxid, txidColumn } from "../lib/electric-txid"
import { Env } from "../lib/Env"
import { dateToMs, msToDate } from "../lib/time"

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

const McpOAuthApiKeyMetadata = Schema.Struct({
	source: Schema.Literal("maple_mcp_oauth"),
	roles: Schema.Array(RoleName),
	clientId: Schema.String,
	resource: Schema.String,
})
const decodeMcpOAuthApiKeyMetadata = Schema.decodeUnknownOption(McpOAuthApiKeyMetadata)

/** Metadata `source` values that pin roles onto a key. */
const ROLE_BEARING_SOURCES = ["maple_cli", "maple_mcp", "maple_mcp_oauth"] as const

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
const decodeOrgIdSync = Schema.decodeUnknownSync(OrgId)
const decodeUserIdSync = Schema.decodeUnknownSync(UserId)

const toPersistenceError = (error: unknown) =>
	new ApiKeyPersistenceError({
		message: error instanceof Error ? error.message : "API key persistence failed",
	})

const rowToResponse = (row: typeof apiKeys.$inferSelect, txid?: PostgresTransactionId): ApiKeyResponse =>
	new ApiKeyResponse({
		id: decodeApiKeyIdSync(row.id),
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
		createdBy: decodeUserIdSync(row.createdBy),
		createdByEmail: row.createdByEmail ?? null,
		...(txid !== undefined ? { txid } : {}),
	})

export class ApiKeysService extends Context.Service<ApiKeysService>()("@maple/api/services/ApiKeysService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const hmacKey = parseIngestKeyLookupHmacKey(Redacted.value(env.MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY))

		const selectById = Effect.fn("ApiKeysService.selectById")(function* (orgId: OrgId, keyId: ApiKeyId) {
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
			const row = yield* selectById(orgId, keyId)
			if (Option.isSome(row)) return row.value

			return yield* Effect.fail(new ApiKeyNotFoundError({ keyId, message: "API key not found" }))
		})

		const get = Effect.fn("ApiKeysService.get")(function* (orgId: OrgId, keyId: ApiKeyId) {
			const row = yield* requireById(orgId, keyId)
			return rowToResponse(row)
		})

		const list = Effect.fn("ApiKeysService.list")(function* (orgId: OrgId) {
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(apiKeys)
						.where(eq(apiKeys.orgId, orgId))
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
			const id = decodeApiKeyIdSync(randomUUID())
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
				...(txid !== undefined ? { txid } : {}),
			})
		})

		const roll = Effect.fn("ApiKeysService.roll")(function* (
			orgId: OrgId,
			userId: UserId,
			keyId: ApiKeyId,
			params: {
				createdByEmail?: string | null
			},
		) {
			const existing = yield* requireById(orgId, keyId)
			if (existing.revoked) {
				return yield* Effect.fail(
					new ApiKeyNotFoundError({ keyId, message: "API key is already revoked" }),
				)
			}

			const id = decodeApiKeyIdSync(randomUUID())
			const rawKey = generateApiKey()
			const keyHash = hashApiKey(rawKey, hmacKey)
			const keyPrefix = rawKey.slice(0, 12) + "..."
			const now = yield* Clock.currentTimeMillis
			const createdByEmail = params.createdByEmail ?? null

			const rolledRows = yield* database
				.execute((db) =>
					db.transaction(async (tx) => {
						await tx.insert(apiKeys).values({
							id,
							orgId,
							name: existing.name,
							description: existing.description ?? null,
							keyHash,
							keyPrefix,
							kind: existing.kind,
							scopes: existing.scopes ?? null,
							// Carry the role metadata across: a rolled key that lost it
							// would resolve with the null (= `root`) default, silently
							// escalating a CLI/MCP key beyond its creator's roles.
							metadataJson: existing.metadataJson,
							expiresAt: null,
							createdAt: new Date(now),
							createdBy: userId,
							createdByEmail,
						})
						return tx
							.update(apiKeys)
							.set({ revoked: true, revokedAt: new Date(now) })
							.where(eq(apiKeys.id, keyId))
							.returning(txidColumn)
					}),
				)
				.pipe(Effect.mapError(toPersistenceError))
			const txid = readTxid(rolledRows)

			return new ApiKeyCreatedResponse({
				id,
				name: existing.name,
				description: existing.description ?? null,
				keyPrefix,
				kind: existing.kind,
				scopes: existing.scopes ?? null,
				revoked: false,
				revokedAt: null,
				lastUsedAt: null,
				expiresAt: null,
				createdAt: now,
				createdBy: userId,
				createdByEmail,
				secret: rawKey,
				...(txid !== undefined ? { txid } : {}),
			})
		})

		const revoke = Effect.fn("ApiKeysService.revoke")(function* (orgId: OrgId, keyId: ApiKeyId) {
			const now = yield* Clock.currentTimeMillis
			const row = yield* requireById(orgId, keyId)

			const revokedRows = yield* database
				.execute((db) =>
					db
						.update(apiKeys)
						.set({ revoked: true, revokedAt: new Date(now) })
						.where(eq(apiKeys.id, keyId))
						.returning(txidColumn),
				)
				.pipe(Effect.mapError(toPersistenceError))
			const txid = readTxid(revokedRows)

			return rowToResponse({ ...row, revoked: true, revokedAt: new Date(now) }, txid)
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

			return Option.some({
				orgId: decodeOrgIdSync(row.value.orgId),
				userId: decodeUserIdSync(row.value.createdBy),
				keyId: decodeApiKeyIdSync(row.value.id),
				kind: row.value.kind,
				metadataJson: row.value.metadataJson == null ? null : JSON.stringify(row.value.metadataJson),
				scopes: row.value.scopes ?? null,
				roles: roleMetadata.value.roles,
				cliManaged: roleMetadata.value.cliManaged,
				mcpOAuthResource: roleMetadata.value.mcpOAuthResource,
			} satisfies ResolvedApiKey)
		})

		const touchLastUsed = Effect.fn("ApiKeysService.touchLastUsed")(function* (keyId: ApiKeyId) {
			const now = yield* Clock.currentTimeMillis
			yield* database
				.execute((db) =>
					db
						.update(apiKeys)
						.set({ lastUsedAt: new Date(now) })
						.where(eq(apiKeys.id, keyId)),
				)
				.pipe(Effect.mapError(toPersistenceError))
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
				yield* touchLastUsed(resolved.value.keyId).pipe(Effect.ignore, Effect.forkDetach)
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
		}
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
