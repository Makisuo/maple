import { randomBytes } from "node:crypto"
import {
	IsoDateTimeString,
	IngestKeyEncryptionError,
	OrgId,
	IngestKeyPersistenceError,
	IngestKeysResponse,
	UserId,
} from "@maple/domain/http"
import {
	computeHmacFingerprint,
	createIngestKeyId,
	hashIngestKey,
	inferIngestKeyType,
	orgIngestKeys,
	parseIngestKeyLookupHmacKey,
	type ResolvedIngestKey,
} from "@maple/db"
import { eq } from "drizzle-orm"
import { Effect, Layer, Option, Redacted, Schema, Context } from "effect"
import { decryptAes256Gcm, encryptAes256Gcm, parseBase64Aes256GcmKey, type EncryptedValue } from "./Crypto"
import { Database } from "./DatabaseLive"
import { Env } from "./Env"

const toPersistenceError = (error: unknown) =>
	new IngestKeyPersistenceError({
		message: error instanceof Error ? error.message : "Ingest key persistence failed",
	})

const toEncryptionError = (message: string) => new IngestKeyEncryptionError({ message })

const decodeOrgIdSync = Schema.decodeUnknownSync(OrgId)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(IsoDateTimeString)

const parseEncryptionKey = (raw: string): Effect.Effect<Buffer, IngestKeyEncryptionError> =>
	parseBase64Aes256GcmKey(raw, (message) =>
		toEncryptionError(
			message === "Expected a non-empty base64 encryption key"
				? "MAPLE_INGEST_KEY_ENCRYPTION_KEY is required"
				: message === "Expected base64 for exactly 32 bytes"
					? "MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64 for exactly 32 bytes"
					: message,
		),
	)

const parseLookupHmacKey = (raw: string): Effect.Effect<string, IngestKeyEncryptionError> =>
	Effect.try({
		try: () => parseIngestKeyLookupHmacKey(raw),
		catch: (error) =>
			toEncryptionError(error instanceof Error ? error.message : "Invalid ingest key lookup HMAC key"),
	})

const encryptPrivateKey = (
	plaintext: string,
	encryptionKey: Buffer,
): Effect.Effect<EncryptedValue, IngestKeyEncryptionError> =>
	encryptAes256Gcm(plaintext, encryptionKey, () =>
		toEncryptionError("Failed to encrypt private ingest key"),
	)

const decryptPrivateKey = (
	encrypted: EncryptedValue,
	encryptionKey: Buffer,
): Effect.Effect<string, IngestKeyEncryptionError> =>
	decryptAes256Gcm(encrypted, encryptionKey, () =>
		toEncryptionError("Failed to decrypt private ingest key"),
	)

const generatePublicKey = () => `maple_pk_${randomBytes(24).toString("base64url")}`
const generatePrivateKey = () => `maple_sk_${randomBytes(24).toString("base64url")}`

export class OrgIngestKeysService extends Context.Service<OrgIngestKeysService>()("OrgIngestKeysService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const encryptionKey = yield* parseEncryptionKey(Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY))
		const lookupHmacKey = yield* parseLookupHmacKey(Redacted.value(env.MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY))

		// One-way fingerprint of the configured HMAC key. Operators diff this
		// against the ingest gateway's `maple.ingest.hmac_fingerprint` to detect
		// env-var drift between the two services without exposing the secret.
		yield* Effect.logInfo("OrgIngestKeysService.hmac_fingerprint").pipe(
			Effect.annotateLogs({ hmac_fingerprint: computeHmacFingerprint(lookupHmacKey) }),
		)

		const selectRow = Effect.fn("OrgIngestKeysService.selectRow")(function* (orgId: OrgId) {
			const rows = yield* database
				.execute((db) =>
					db.select().from(orgIngestKeys).where(eq(orgIngestKeys.orgId, orgId)).limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))

			return Option.fromNullishOr(rows[0])
		})

		const toResponse = Effect.fn("OrgIngestKeysService.toResponse")(function* (
			row: typeof orgIngestKeys.$inferSelect,
		) {
			const privateKey = yield* decryptPrivateKey(
				{
					ciphertext: row.privateKeyCiphertext,
					iv: row.privateKeyIv,
					tag: row.privateKeyTag,
				},
				encryptionKey,
			)

			return new IngestKeysResponse({
				publicKey: row.publicKey,
				privateKey,
				publicRotatedAt: decodeIsoDateTimeStringSync(new Date(row.publicRotatedAt).toISOString()),
				privateRotatedAt: decodeIsoDateTimeStringSync(new Date(row.privateRotatedAt).toISOString()),
			})
		})

		const ensureRow = Effect.fn("OrgIngestKeysService.ensureRow")(function* (
			orgId: OrgId,
			userId: UserId,
		) {
			const existing = yield* selectRow(orgId)
			if (Option.isSome(existing)) return existing.value

			const now = Date.now()
			const publicKey = generatePublicKey()
			const privateKey = generatePrivateKey()
			const publicKeyHash = hashIngestKey(publicKey, lookupHmacKey)
			const privateKeyHash = hashIngestKey(privateKey, lookupHmacKey)
			const encryptedPrivate = yield* encryptPrivateKey(privateKey, encryptionKey)

			yield* database
				.execute((db) =>
					db
						.insert(orgIngestKeys)
						.values({
							orgId,
							publicKey,
							publicKeyHash,
							privateKeyCiphertext: encryptedPrivate.ciphertext,
							privateKeyIv: encryptedPrivate.iv,
							privateKeyTag: encryptedPrivate.tag,
							privateKeyHash,
							publicRotatedAt: now,
							privateRotatedAt: now,
							createdAt: now,
							updatedAt: now,
							createdBy: userId,
							updatedBy: userId,
						})
						.onConflictDoNothing(),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const row = yield* selectRow(orgId)
			if (Option.isNone(row)) {
				return yield* Effect.fail(
					new IngestKeyPersistenceError({
						message: "Failed to create org ingest keys",
					}),
				)
			}

			return row.value
		})

		const getOrCreate = Effect.fn("OrgIngestKeysService.getOrCreate")(function* (
			orgId: OrgId,
			userId: UserId,
		) {
			const row = yield* ensureRow(orgId, userId)
			return yield* toResponse(row)
		})

		const rerollPublic = Effect.fn("OrgIngestKeysService.rerollPublic")(function* (
			orgId: OrgId,
			userId: UserId,
		) {
			yield* ensureRow(orgId, userId)

			const now = Date.now()
			const publicKey = generatePublicKey()
			const publicKeyHash = hashIngestKey(publicKey, lookupHmacKey)

			yield* database
				.execute((db) =>
					db
						.update(orgIngestKeys)
						.set({
							publicKey,
							publicKeyHash,
							publicRotatedAt: now,
							updatedAt: now,
							updatedBy: userId,
						})
						.where(eq(orgIngestKeys.orgId, orgId)),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const row = yield* selectRow(orgId)
			if (Option.isNone(row)) {
				return yield* Effect.fail(
					new IngestKeyPersistenceError({
						message: "Failed to load rerolled public ingest key",
					}),
				)
			}

			return yield* toResponse(row.value)
		})

		const rerollPrivate = Effect.fn("OrgIngestKeysService.rerollPrivate")(function* (
			orgId: OrgId,
			userId: UserId,
		) {
			yield* ensureRow(orgId, userId)

			const now = Date.now()
			const privateKey = generatePrivateKey()
			const privateKeyHash = hashIngestKey(privateKey, lookupHmacKey)
			const encryptedPrivate = yield* encryptPrivateKey(privateKey, encryptionKey)

			yield* database
				.execute((db) =>
					db
						.update(orgIngestKeys)
						.set({
							privateKeyCiphertext: encryptedPrivate.ciphertext,
							privateKeyIv: encryptedPrivate.iv,
							privateKeyTag: encryptedPrivate.tag,
							privateKeyHash,
							privateRotatedAt: now,
							updatedAt: now,
							updatedBy: userId,
						})
						.where(eq(orgIngestKeys.orgId, orgId)),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const row = yield* selectRow(orgId)
			if (Option.isNone(row)) {
				return yield* Effect.fail(
					new IngestKeyPersistenceError({
						message: "Failed to load rerolled private ingest key",
					}),
				)
			}

			return yield* toResponse(row.value)
		})

		const resolveIngestKey = Effect.fn("OrgIngestKeysService.resolveIngestKey")(function* (
			rawKey: string,
		) {
			const keyType = inferIngestKeyType(rawKey)
			if (!keyType) return Option.none()

			const keyHash = hashIngestKey(rawKey, lookupHmacKey)
			const rows = yield* database
				.execute((db) =>
					db
						.select({ orgId: orgIngestKeys.orgId })
						.from(orgIngestKeys)
						.where(
							keyType === "public"
								? eq(orgIngestKeys.publicKeyHash, keyHash)
								: eq(orgIngestKeys.privateKeyHash, keyHash),
						)
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const row = Option.fromNullishOr(rows[0])
			if (Option.isNone(row)) return Option.none()

			return Option.some({
				orgId: decodeOrgIdSync(row.value.orgId),
				keyType,
				keyId: createIngestKeyId(keyHash),
			} satisfies ResolvedIngestKey)
		})

		return {
			getOrCreate,
			rerollPublic,
			rerollPrivate,
			resolveIngestKey,
		}
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
	static readonly Live = this.layer
	static readonly Default = this.layer

	static readonly getOrCreate = (orgId: OrgId, userId: UserId) =>
		this.use((service) => service.getOrCreate(orgId, userId))

	static readonly rerollPublic = (orgId: OrgId, userId: UserId) =>
		this.use((service) => service.rerollPublic(orgId, userId))

	static readonly rerollPrivate = (orgId: OrgId, userId: UserId) =>
		this.use((service) => service.rerollPrivate(orgId, userId))

	static readonly resolveIngestKey = (rawKey: string) =>
		this.use((service) => service.resolveIngestKey(rawKey))
}
