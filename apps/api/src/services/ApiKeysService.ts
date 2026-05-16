import { randomUUID } from "node:crypto"
import {
	ApiKeyId,
	type ApiKeyKind,
	ApiKeyCreatedResponse,
	ApiKeyNotFoundError,
	ApiKeyPersistenceError,
	ApiKeyResponse,
	ApiKeysListResponse,
	OrgId,
	UserId,
} from "@maple/domain/http"
import { API_KEY_PREFIX, apiKeys, generateApiKey, hashApiKey, parseIngestKeyLookupHmacKey } from "@maple/db"
import { and, desc, eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Database } from "./DatabaseLive"
import { Env } from "./Env"

export interface ResolvedApiKey {
	readonly orgId: OrgId
	readonly userId: UserId
	readonly keyId: ApiKeyId
	readonly metadataJson: string | null
}

const decodeApiKeyIdSync = Schema.decodeUnknownSync(ApiKeyId)
const decodeOrgIdSync = Schema.decodeUnknownSync(OrgId)
const decodeUserIdSync = Schema.decodeUnknownSync(UserId)

const toPersistenceError = (error: unknown) =>
	new ApiKeyPersistenceError({
		message: error instanceof Error ? error.message : "API key persistence failed",
	})

const rowToResponse = (row: typeof apiKeys.$inferSelect): ApiKeyResponse =>
	new ApiKeyResponse({
		id: decodeApiKeyIdSync(row.id),
		name: row.name,
		description: row.description ?? null,
		keyPrefix: row.keyPrefix,
		kind: row.kind,
		revoked: row.revoked,
		revokedAt: row.revokedAt ?? null,
		lastUsedAt: row.lastUsedAt ?? null,
		expiresAt: row.expiresAt ?? null,
		createdAt: row.createdAt,
		createdBy: decodeUserIdSync(row.createdBy),
		createdByEmail: row.createdByEmail ?? null,
	})

export class ApiKeysService extends Context.Service<ApiKeysService>()("ApiKeysService", {
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
				keys: rows.map(rowToResponse),
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
				createdByEmail?: string | null
			},
		) {
			const id = decodeApiKeyIdSync(randomUUID())
			const rawKey = generateApiKey()
			const keyHash = hashApiKey(rawKey, hmacKey)
			const keyPrefix = rawKey.slice(0, 12) + "..."
			const now = yield* Clock.currentTimeMillis
			const expiresAt = params.expiresInSeconds ? now + params.expiresInSeconds * 1000 : undefined
			const kind: ApiKeyKind = params.kind ?? "standard"
			const createdByEmail = params.createdByEmail ?? null

			yield* database
				.execute((db) =>
					db.insert(apiKeys).values({
						id,
						orgId,
						name: params.name,
						description: params.description ?? null,
						keyHash,
						keyPrefix,
						kind,
						expiresAt: expiresAt ?? null,
						createdAt: now,
						createdBy: userId,
						createdByEmail,
					}),
				)
				.pipe(Effect.mapError(toPersistenceError))

			return new ApiKeyCreatedResponse({
				id,
				name: params.name,
				description: params.description ?? null,
				keyPrefix,
				kind,
				revoked: false,
				revokedAt: null,
				lastUsedAt: null,
				expiresAt: expiresAt ?? null,
				createdAt: now,
				createdBy: userId,
				createdByEmail,
				secret: rawKey,
			})
		})

		const revoke = Effect.fn("ApiKeysService.revoke")(function* (orgId: OrgId, keyId: ApiKeyId) {
			const now = yield* Clock.currentTimeMillis
			const row = yield* requireById(orgId, keyId)

			yield* database
				.execute((db) =>
					db.update(apiKeys).set({ revoked: true, revokedAt: now }).where(eq(apiKeys.id, keyId)),
				)
				.pipe(Effect.mapError(toPersistenceError))

			return rowToResponse({ ...row, revoked: true, revokedAt: now })
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
			const now = yield* Clock.currentTimeMillis
			if (row.value.expiresAt && row.value.expiresAt < now) return Option.none()

			return Option.some({
				orgId: decodeOrgIdSync(row.value.orgId),
				userId: decodeUserIdSync(row.value.createdBy),
				keyId: decodeApiKeyIdSync(row.value.id),
				metadataJson: row.value.metadataJson ?? null,
			} satisfies ResolvedApiKey)
		})

		const touchLastUsed = Effect.fn("ApiKeysService.touchLastUsed")(function* (keyId: ApiKeyId) {
			const now = yield* Clock.currentTimeMillis
			yield* database
				.execute((db) =>
					db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, keyId)),
				)
				.pipe(Effect.mapError(toPersistenceError))
		})

		const resolveByBearer = Effect.fn("ApiKeysService.resolveByBearer")(function* (
			bearerToken: string | undefined,
		) {
			if (!bearerToken || !bearerToken.startsWith(API_KEY_PREFIX)) {
				return Option.none<ResolvedApiKey>()
			}

			const resolved = yield* resolveByKey(bearerToken)
			if (Option.isSome(resolved)) {
				yield* touchLastUsed(resolved.value.keyId).pipe(Effect.ignore, Effect.forkDetach)
			}
			return resolved
		})

		return {
			list,
			create,
			revoke,
			resolveByKey,
			resolveByBearer,
			touchLastUsed,
		}
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
	static readonly Live = this.layer
	static readonly Default = this.layer
}
