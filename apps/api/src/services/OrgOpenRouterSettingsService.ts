import {
	IsoDateTimeString,
	OrgOpenrouterSettingsDeleteResponse,
	OrgOpenrouterSettingsEncryptionError,
	OrgOpenrouterSettingsForbiddenError,
	OrgOpenrouterSettingsPersistenceError,
	OrgOpenrouterSettingsResponse,
	type OrgOpenrouterSettingsUpsertRequest,
	OrgOpenrouterSettingsValidationError,
	OrgId,
	RoleName,
	UserId,
} from "@maple/domain/http"
import { orgOpenrouterSettings } from "@maple/db"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { decryptAes256Gcm, encryptAes256Gcm, parseBase64Aes256GcmKey, type EncryptedValue } from "./Crypto"
import { Database } from "./DatabaseLive"
import { Env } from "./Env"

type ActiveRow = typeof orgOpenrouterSettings.$inferSelect

const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(IsoDateTimeString)
const ROOT_ROLE = Schema.decodeUnknownSync(RoleName)("root")
const ORG_ADMIN_ROLE = Schema.decodeUnknownSync(RoleName)("org:admin")

const isOrgAdmin = (roles: ReadonlyArray<RoleName>) =>
	roles.includes(ROOT_ROLE) || roles.includes(ORG_ADMIN_ROLE)

const toPersistenceError = (error: unknown) =>
	new OrgOpenrouterSettingsPersistenceError({
		message: error instanceof Error ? error.message : "Org OpenRouter settings persistence failed",
	})

const toEncryptionError = (message: string) => new OrgOpenrouterSettingsEncryptionError({ message })

const parseEncryptionKey = (raw: string): Effect.Effect<Buffer, OrgOpenrouterSettingsEncryptionError> =>
	parseBase64Aes256GcmKey(raw, (message) =>
		toEncryptionError(
			message === "Expected a non-empty base64 encryption key"
				? "MAPLE_INGEST_KEY_ENCRYPTION_KEY is required"
				: message === "Expected base64 for exactly 32 bytes"
					? "MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64 for exactly 32 bytes"
					: message,
		),
	)

const encryptKey = (
	plaintext: string,
	encryptionKey: Buffer,
): Effect.Effect<EncryptedValue, OrgOpenrouterSettingsEncryptionError> =>
	encryptAes256Gcm(plaintext, encryptionKey, () =>
		toEncryptionError("Failed to encrypt OpenRouter API key"),
	)

const decryptKey = (
	encrypted: EncryptedValue,
	encryptionKey: Buffer,
): Effect.Effect<string, OrgOpenrouterSettingsEncryptionError> =>
	decryptAes256Gcm(encrypted, encryptionKey, () =>
		toEncryptionError("Failed to decrypt OpenRouter API key"),
	)

const normalizeApiKey = (raw: string): Effect.Effect<string, OrgOpenrouterSettingsValidationError> =>
	Effect.sync(() => raw.trim()).pipe(
		Effect.flatMap((trimmed) =>
			trimmed.length > 0
				? Effect.succeed(trimmed)
				: Effect.fail(
						new OrgOpenrouterSettingsValidationError({
							message: "OpenRouter API key is required",
						}),
					),
		),
	)

const toLast4 = (apiKey: string): string => apiKey.slice(Math.max(0, apiKey.length - 4))

const toResponse = (row: ActiveRow | null | undefined): OrgOpenrouterSettingsResponse =>
	new OrgOpenrouterSettingsResponse({
		configured: row != null,
		last4: row?.apiKeyLast4 ?? null,
		updatedAt: row == null ? null : decodeIsoDateTimeStringSync(new Date(row.updatedAt).toISOString()),
	})

export interface OrgOpenRouterSettingsServiceShape {
	readonly get: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		OrgOpenrouterSettingsResponse,
		OrgOpenrouterSettingsForbiddenError | OrgOpenrouterSettingsPersistenceError
	>
	readonly upsert: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		payload: OrgOpenrouterSettingsUpsertRequest,
	) => Effect.Effect<
		OrgOpenrouterSettingsResponse,
		| OrgOpenrouterSettingsForbiddenError
		| OrgOpenrouterSettingsValidationError
		| OrgOpenrouterSettingsPersistenceError
		| OrgOpenrouterSettingsEncryptionError
	>
	readonly delete: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		OrgOpenrouterSettingsDeleteResponse,
		OrgOpenrouterSettingsForbiddenError | OrgOpenrouterSettingsPersistenceError
	>
	readonly resolveApiKey: (
		orgId: OrgId,
	) => Effect.Effect<
		Option.Option<string>,
		OrgOpenrouterSettingsPersistenceError | OrgOpenrouterSettingsEncryptionError
	>
}

export class OrgOpenRouterSettingsService extends Context.Service<
	OrgOpenRouterSettingsService,
	OrgOpenRouterSettingsServiceShape
>()("OrgOpenRouterSettingsService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const encryptionKey = yield* parseEncryptionKey(Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY))

		const requireAdmin = Effect.fn("OrgOpenRouterSettingsService.requireAdmin")(function* (
			roles: ReadonlyArray<RoleName>,
		) {
			if (isOrgAdmin(roles)) return

			return yield* Effect.fail(
				new OrgOpenrouterSettingsForbiddenError({
					message: "Only org admins can manage OpenRouter settings",
				}),
			)
		})

		const selectActiveRow = Effect.fn("OrgOpenRouterSettingsService.selectActiveRow")(function* (
			orgId: OrgId,
		) {
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(orgOpenrouterSettings)
						.where(eq(orgOpenrouterSettings.orgId, orgId))
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))

			return Option.fromNullishOr(rows[0])
		})

		const get = Effect.fn("OrgOpenRouterSettingsService.get")(function* (
			orgId: OrgId,
			roles: ReadonlyArray<RoleName>,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* requireAdmin(roles)
			const row = yield* selectActiveRow(orgId)
			return toResponse(Option.getOrUndefined(row))
		})

		const upsert = Effect.fn("OrgOpenRouterSettingsService.upsert")(function* (
			orgId: OrgId,
			userId: UserId,
			roles: ReadonlyArray<RoleName>,
			payload: OrgOpenrouterSettingsUpsertRequest,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* Effect.annotateCurrentSpan("userId", userId)
			yield* requireAdmin(roles)
			const apiKey = yield* normalizeApiKey(payload.apiKey)
			const existing = yield* selectActiveRow(orgId)
			const encrypted = yield* encryptKey(apiKey, encryptionKey)
			const now = Date.now()
			const last4 = toLast4(apiKey)

			yield* database
				.execute((db) =>
					db
						.insert(orgOpenrouterSettings)
						.values({
							orgId,
							apiKeyCiphertext: encrypted.ciphertext,
							apiKeyIv: encrypted.iv,
							apiKeyTag: encrypted.tag,
							apiKeyLast4: last4,
							createdAt: Option.isSome(existing) ? existing.value.createdAt : now,
							updatedAt: now,
							createdBy: Option.isSome(existing) ? existing.value.createdBy : userId,
							updatedBy: userId,
						})
						.onConflictDoUpdate({
							target: orgOpenrouterSettings.orgId,
							set: {
								apiKeyCiphertext: encrypted.ciphertext,
								apiKeyIv: encrypted.iv,
								apiKeyTag: encrypted.tag,
								apiKeyLast4: last4,
								updatedAt: now,
								updatedBy: userId,
							},
						}),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const nextRow = yield* selectActiveRow(orgId)
			return toResponse(Option.getOrUndefined(nextRow))
		})

		const deleteSettings = Effect.fn("OrgOpenRouterSettingsService.delete")(function* (
			orgId: OrgId,
			roles: ReadonlyArray<RoleName>,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* requireAdmin(roles)

			yield* database
				.execute((db) =>
					db.delete(orgOpenrouterSettings).where(eq(orgOpenrouterSettings.orgId, orgId)),
				)
				.pipe(Effect.mapError(toPersistenceError))

			return new OrgOpenrouterSettingsDeleteResponse({ configured: false })
		})

		const resolveApiKey = Effect.fn("OrgOpenRouterSettingsService.resolveApiKey")(function* (
			orgId: OrgId,
		) {
			const row = yield* selectActiveRow(orgId)
			if (Option.isNone(row)) return Option.none<string>()

			const apiKey = yield* decryptKey(
				{
					ciphertext: row.value.apiKeyCiphertext,
					iv: row.value.apiKeyIv,
					tag: row.value.apiKeyTag,
				},
				encryptionKey,
			)

			return Option.some(apiKey)
		})

		return {
			get,
			upsert,
			delete: deleteSettings,
			resolveApiKey,
		}
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
	static readonly Live = this.layer
	static readonly Default = this.layer

	static readonly get = (orgId: OrgId, roles: ReadonlyArray<RoleName>) =>
		this.use((service) => service.get(orgId, roles))

	static readonly upsert = (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		payload: OrgOpenrouterSettingsUpsertRequest,
	) => this.use((service) => service.upsert(orgId, userId, roles, payload))

	static readonly delete = (orgId: OrgId, roles: ReadonlyArray<RoleName>) =>
		this.use((service) => service.delete(orgId, roles))

	static readonly resolveApiKey = (orgId: OrgId) => this.use((service) => service.resolveApiKey(orgId))
}
