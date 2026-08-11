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
import { and, eq, isNull } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import {
	decryptAes256Gcm,
	encryptAes256Gcm,
	parseBase64Aes256GcmKey,
	type EncryptedValue,
} from "@/platform/Crypto"
import { Database } from "@/platform/DatabaseLive"
import { Env } from "@/platform/Env"

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

const encryptSessionSalt = (
	plaintext: string,
	encryptionKey: Buffer,
): Effect.Effect<EncryptedValue, IngestKeyEncryptionError> =>
	encryptAes256Gcm(plaintext, encryptionKey, () => toEncryptionError("Failed to encrypt org session salt"))

const decryptSessionSalt = (
	encrypted: EncryptedValue,
	encryptionKey: Buffer,
): Effect.Effect<string, IngestKeyEncryptionError> =>
	decryptAes256Gcm(encrypted, encryptionKey, () => toEncryptionError("Failed to decrypt org session salt"))

const generatePublicKey = () => `maple_pk_${randomBytes(24).toString("base64url")}`
const generatePrivateKey = () => `maple_sk_${randomBytes(24).toString("base64url")}`

const SESSION_SALT_BYTES = 32

/**
 * Generates a per-org secret salt for AI session-key hashing.
 *
 * The ingest gateway hashes every inbound session key as
 * `cityHash64(concat(salt, '\0', value))`, so the raw session key never reaches
 * the warehouse and the same key under two orgs produces two unrelated hashes.
 * Ingest reads the encrypted triple from its existing `org_ingest_keys` SELECT
 * on the cached auth path and decrypts it with the same
 * `MAPLE_INGEST_KEY_ENCRYPTION_KEY` — that read is wired up in a later stage;
 * this service only provisions the value.
 *
 * The salt is deliberately AAD-free (like the private-key triple) so the Rust
 * side decrypts with a plain AES-256-GCM primitive, and the plaintext is the
 * base64url text itself — ingest concatenates the decrypted string verbatim,
 * with no decoding step, so both languages agree on the bytes without a
 * shared codec.
 *
 * **There is no rotation path, on purpose.** Re-salting changes every hash, so
 * the SessionsApprox HLL sketches stop deduplicating across the boundary: one
 * live session counts twice, and every session-count series gets a permanent
 * step at the rotation instant. Treat the salt as write-once per org; if it must
 * ever change (key compromise), accept the discontinuity explicitly rather than
 * adding a reroll button. It is never exposed over HTTP and never enters the
 * AI registry.
 */
const generateSessionSalt = () => randomBytes(SESSION_SALT_BYTES).toString("base64url")

const readSessionSalt = (row: typeof orgIngestKeys.$inferSelect): Option.Option<EncryptedValue> =>
	row.sessionSaltCiphertext === null || row.sessionSaltIv === null || row.sessionSaltTag === null
		? Option.none()
		: Option.some({
				ciphertext: row.sessionSaltCiphertext,
				iv: row.sessionSaltIv,
				tag: row.sessionSaltTag,
			})

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

			/**
			 * Backfills the session salt for rows created before the column existed.
			 *
			 * Race safety: the fill is a conditional `UPDATE … WHERE
			 * session_salt_ciphertext IS NULL` with `RETURNING`, so at most one writer
			 * ever lands a salt for an org — Postgres serializes the concurrent
			 * updates on the row lock and the loser's predicate no longer matches, so
			 * it returns zero rows and re-reads the winner's value instead of keeping
			 * its own. Two simultaneous fills therefore cannot hand two readers
			 * different salts, which would silently split an org's session hashes.
			 *
			 * `updatedAt`/`updatedBy` are intentionally left alone: this is a system
			 * backfill, not an edit by whichever user's request happened to trigger it.
			 */
			const ensureSessionSalt = Effect.fnUntraced(function* (row: typeof orgIngestKeys.$inferSelect) {
				if (Option.isSome(readSessionSalt(row))) return row

				const encryptedSalt = yield* encryptSessionSalt(generateSessionSalt(), encryptionKey)
				const claimed = yield* database
					.execute((db) =>
						db
							.update(orgIngestKeys)
							.set({
								sessionSaltCiphertext: encryptedSalt.ciphertext,
								sessionSaltIv: encryptedSalt.iv,
								sessionSaltTag: encryptedSalt.tag,
							})
							.where(
								and(
									eq(orgIngestKeys.orgId, row.orgId),
									isNull(orgIngestKeys.sessionSaltCiphertext),
								),
							)
							.returning(),
					)
					.pipe(Effect.mapError(toPersistenceError))

				const won = Option.fromNullishOr(claimed[0])
				if (Option.isSome(won)) return won.value

				const reread = yield* selectRow(row.orgId)
				if (Option.isNone(reread)) {
					return yield* Effect.fail(
						new IngestKeyPersistenceError({
							message: "Failed to load org session salt after backfill",
						}),
					)
				}

				return reread.value
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
					// Backfill BEFORE memoizing, so the memo never caches a saltless row
					// and re-runs the fill for the rest of the TTL.
					const filled = yield* ensureSessionSalt(existing.value)
					ingestKeysMemo.set(orgId, {
						row: filled,
						expiresAt: now + ORG_INGEST_KEYS_MEMO_TTL_MS,
					})
					return filled
				}

				const publicKey = generatePublicKey()
				const privateKey = generatePrivateKey()
				const publicKeyHash = hashIngestKey(publicKey, lookupHmacKey)
				const privateKeyHash = hashIngestKey(privateKey, lookupHmacKey)
				const encryptedPrivate = yield* encryptPrivateKey(privateKey, encryptionKey)
				const encryptedSalt = yield* encryptSessionSalt(generateSessionSalt(), encryptionKey)

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
								sessionSaltCiphertext: encryptedSalt.ciphertext,
								sessionSaltIv: encryptedSalt.iv,
								sessionSaltTag: encryptedSalt.tag,
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
				// Our own insert always carries a salt, but `onConflictDoNothing` may
				// have lost to an isolate still running pre-salt code mid-deploy — in
				// which case the row we just read has none. No-op otherwise.
				const filled = yield* ensureSessionSalt(row.value)
				ingestKeysMemo.set(orgId, {
					row: filled,
					expiresAt: now + ORG_INGEST_KEYS_MEMO_TTL_MS,
				})

				return filled
			})

			const getOrCreate = Effect.fn("OrgIngestKeysService.getOrCreate")(function* (
				orgId: OrgId,
				userId: UserId,
			) {
				const row = yield* ensureRow(orgId, userId)
				return yield* toResponse(row)
			})

			/**
			 * The org's decrypted session salt, provisioning it if the row predates the
			 * column. Server-internal only — see {@link generateSessionSalt} for what
			 * it salts and why it must not be rotated. Returned `Redacted` because it
			 * has no user-facing surface and must never reach a log or a response.
			 */
			const getSessionSalt = Effect.fn("OrgIngestKeysService.getSessionSalt")(function* (
				orgId: OrgId,
				userId: UserId,
			) {
				const row = yield* ensureRow(orgId, userId)
				const encrypted = readSessionSalt(row)
				if (Option.isNone(encrypted)) {
					return yield* Effect.fail(
						new IngestKeyPersistenceError({
							message: "Org session salt is missing after provisioning",
						}),
					)
				}

				return Redacted.make(yield* decryptSessionSalt(encrypted.value, encryptionKey))
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
				getSessionSalt,
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

	static readonly getSessionSalt = (orgId: OrgId, userId: UserId) =>
		this.use((service) => service.getSessionSalt(orgId, userId))

	static readonly rerollPublic = (orgId: OrgId, userId: UserId) =>
		this.use((service) => service.rerollPublic(orgId, userId))

	static readonly rerollPrivate = (orgId: OrgId, userId: UserId) =>
		this.use((service) => service.rerollPrivate(orgId, userId))

	static readonly resolveIngestKey = (rawKey: string) =>
		this.use((service) => service.resolveIngestKey(rawKey))
}
