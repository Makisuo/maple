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
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import {
	decryptAes256Gcm,
	encryptAes256Gcm,
	parseBase64Aes256GcmKey,
	type EncryptedValue,
} from "../lib/Crypto"
import { Database } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"

const toPersistenceError = (error: unknown) =>
	new IngestKeyPersistenceError({
		message: error instanceof Error ? error.message : "Ingest key persistence failed",
	})

const toEncryptionError = (message: string) => new IngestKeyEncryptionError({ message })

const decodeOrgIdSync = Schema.decodeUnknownSync(OrgId)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(IsoDateTimeString)

// TTL for the in-isolate memo of the per-org key row. The scraper's target-list
// poll calls `getOrCreate` once per distinct org on every reconcile (~5.7k
// Postgres round-trips/day) behind only a request-scoped Map, and the row
// changes solely on an explicit reroll — which busts the entry in the writing
// isolate. Matches `OrgClickHouseSettingsService`'s config memo TTL, so
// cross-isolate staleness after a reroll is bounded to minutes.
//
// The Map itself is built per service instance (not at module scope) so it is
// scoped to the layer that owns the connection it caches — module scope would
// share one memo across every database in a process, which is exactly wrong for
// tests that build a fresh PGlite per case.
const ORG_INGEST_KEYS_MEMO_TTL_MS = 300_000

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

export class OrgIngestKeysService extends Context.Service<OrgIngestKeysService>()(
	"@maple/api/services/OrgIngestKeysService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			/** Holds the ENCRYPTED row exactly as stored — `toResponse` decrypts per request. */
			const ingestKeysMemo = new Map<
				string,
				{ row: typeof orgIngestKeys.$inferSelect; expiresAt: number }
			>()
			const env = yield* Env
			const encryptionKey = yield* parseEncryptionKey(
				Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			)
			const lookupHmacKey = yield* parseLookupHmacKey(
				Redacted.value(env.MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY),
			)

			// One-way fingerprint of the configured HMAC key. Operators diff this
			// against the ingest gateway's `maple.ingest.hmac_fingerprint` to detect
			// env-var drift between the two services without exposing the secret.
			yield* Effect.logInfo("OrgIngestKeysService.hmac_fingerprint").pipe(
				Effect.annotateLogs({ hmac_fingerprint: computeHmacFingerprint(lookupHmacKey) }),
			)

			// Untraced: this wraps a single `Database.execute`, which already emits its
			// own client span. A named `Effect.fn` here only added a second span of
			// byte-identical duration on a hot path — the exact noise CLAUDE.md warns
			// against ("be careful adding spans to per-request hot paths").
			const selectRow = Effect.fnUntraced(function* (orgId: OrgId) {
				const rows = yield* database
					.execute((db) =>
						db.select().from(orgIngestKeys).where(eq(orgIngestKeys.orgId, orgId)).limit(1),
					)
					.pipe(Effect.mapError(toPersistenceError))

				return Option.fromNullishOr(rows[0])
			})

			// Untraced: synchronous AES-GCM decrypt, ~0ms — never worth a span.
			const toResponse = Effect.fnUntraced(function* (row: typeof orgIngestKeys.$inferSelect) {
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
					publicRotatedAt: decodeIsoDateTimeStringSync(row.publicRotatedAt.toISOString()),
					privateRotatedAt: decodeIsoDateTimeStringSync(row.privateRotatedAt.toISOString()),
				})
			})

			// Untraced for the same reason as `selectRow`: on the steady-state path it
			// early-returns and contributes nothing but a duplicate span.
			const ensureRow = Effect.fnUntraced(function* (orgId: OrgId, userId: UserId) {
				const now = yield* Clock.currentTimeMillis
				const memoized = ingestKeysMemo.get(orgId)
				if (memoized !== undefined && memoized.expiresAt > now) {
					yield* Effect.annotateCurrentSpan("ingestKeys.memoHit", true)
					return memoized.row
				}
				yield* Effect.annotateCurrentSpan("ingestKeys.memoHit", false)

				const existing = yield* selectRow(orgId)
				if (Option.isSome(existing)) {
					ingestKeysMemo.set(orgId, {
						row: existing.value,
						expiresAt: now + ORG_INGEST_KEYS_MEMO_TTL_MS,
					})
					return existing.value
				}

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
								publicRotatedAt: new Date(now),
								privateRotatedAt: new Date(now),
								createdAt: new Date(now),
								updatedAt: new Date(now),
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
				ingestKeysMemo.set(orgId, {
					row: row.value,
					expiresAt: now + ORG_INGEST_KEYS_MEMO_TTL_MS,
				})

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

				const now = yield* Clock.currentTimeMillis
				const publicKey = generatePublicKey()
				const publicKeyHash = hashIngestKey(publicKey, lookupHmacKey)

				yield* database
					.execute((db) =>
						db
							.update(orgIngestKeys)
							.set({
								publicKey,
								publicKeyHash,
								publicRotatedAt: new Date(now),
								updatedAt: new Date(now),
								updatedBy: userId,
							})
							.where(eq(orgIngestKeys.orgId, orgId)),
					)
					.pipe(Effect.mapError(toPersistenceError))

				// The memoized row is now stale in this isolate; others fall off within
				// the TTL. Must come before the re-read so it repopulates with the new key.
				ingestKeysMemo.delete(orgId)

				const row = yield* selectRow(orgId)
				if (Option.isNone(row)) {
					return yield* Effect.fail(
						new IngestKeyPersistenceError({
							message: "Failed to load rerolled public ingest key",
						}),
					)
				}
				ingestKeysMemo.set(orgId, { row: row.value, expiresAt: now + ORG_INGEST_KEYS_MEMO_TTL_MS })

				return yield* toResponse(row.value)
			})

			const rerollPrivate = Effect.fn("OrgIngestKeysService.rerollPrivate")(function* (
				orgId: OrgId,
				userId: UserId,
			) {
				yield* ensureRow(orgId, userId)

				const now = yield* Clock.currentTimeMillis
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
								privateRotatedAt: new Date(now),
								updatedAt: new Date(now),
								updatedBy: userId,
							})
							.where(eq(orgIngestKeys.orgId, orgId)),
					)
					.pipe(Effect.mapError(toPersistenceError))

				ingestKeysMemo.delete(orgId)

				const row = yield* selectRow(orgId)
				if (Option.isNone(row)) {
					return yield* Effect.fail(
						new IngestKeyPersistenceError({
							message: "Failed to load rerolled private ingest key",
						}),
					)
				}
				ingestKeysMemo.set(orgId, { row: row.value, expiresAt: now + ORG_INGEST_KEYS_MEMO_TTL_MS })

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
	},
) {
	static readonly layer = Layer.effect(this, this.make)

	static readonly getOrCreate = (orgId: OrgId, userId: UserId) =>
		this.use((service) => service.getOrCreate(orgId, userId))

	static readonly rerollPublic = (orgId: OrgId, userId: UserId) =>
		this.use((service) => service.rerollPublic(orgId, userId))

	static readonly rerollPrivate = (orgId: OrgId, userId: UserId) =>
		this.use((service) => service.rerollPrivate(orgId, userId))

	static readonly resolveIngestKey = (rawKey: string) =>
		this.use((service) => service.resolveIngestKey(rawKey))
}
