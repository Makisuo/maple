import { afterEach, assert, describe, it } from "@effect/vitest"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Redacted, Schema } from "effect"
import { IngestKeyEncryptionError, IngestKeyPersistenceError, OrgId, UserId } from "@maple/domain/http"
import { hashIngestKey } from "@maple/db"
import { encryptAes256Gcm } from "@/platform/Crypto"
import { type DatabaseClient, Database, DatabaseError } from "@/platform/DatabaseLive"
import { Env } from "@/platform/Env"
import { OrgIngestKeysService } from "./OrgIngestKeysService"
import { cleanupTestDbs, createTestDb, executeSql, queryFirstRow, type TestDb } from "@/platform/test-pglite"

// A Database layer that builds successfully (so migrations are never attempted)
// but fails every query, exercising the service's `mapError(toPersistenceError)`
// path. Pointing a real client at an unreachable URL instead fails during
// migration in layer construction, surfacing a raw DatabaseError that never
// reaches the service's mapping — which is exactly the regression the previous
// `String(failure).toContain("DatabaseError")` escape hatch hid.
const failingDatabaseLayer = Layer.succeed(
	Database,
	Database.of({
		execute: () =>
			Effect.fail(new DatabaseError({ message: "simulated query failure", cause: new Error("boom") })),
	}),
)

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

const getError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
	if (!Exit.isFailure(exit)) return undefined

	const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
	if (failure !== undefined) return failure

	return Cause.squash(exit.cause)
}

const makeConfig = (encryptionKey?: string) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			MCP_PORT: "3473",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			...(encryptionKey === undefined ? {} : { MAPLE_INGEST_KEY_ENCRYPTION_KEY: encryptionKey }),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

const makeLayerFrom = (
	databaseLayer: Layer.Layer<Database>,
	encryptionKey = Buffer.alloc(32, 7).toString("base64"),
) =>
	OrgIngestKeysService.layer.pipe(
		Layer.provide(databaseLayer),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig(encryptionKey)),
	)

const makeLayer = (testDb: TestDb, encryptionKey = Buffer.alloc(32, 7).toString("base64")) =>
	makeLayerFrom(testDb.layer, encryptionKey)

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7)

interface SaltColumns {
	session_salt_ciphertext: string | null
	session_salt_iv: string | null
	session_salt_tag: string | null
}

const readSaltColumns = (testDb: TestDb, orgId = "org_a") =>
	Effect.promise(() =>
		queryFirstRow<SaltColumns>(
			testDb,
			"SELECT session_salt_ciphertext, session_salt_iv, session_salt_tag FROM org_ingest_keys WHERE org_id = $1",
			[orgId],
		),
	)

/** Puts an existing row back into the pre-migration shape the backfill targets. */
const clearSalt = (testDb: TestDb, orgId = "org_a") =>
	Effect.promise(() =>
		executeSql(
			testDb,
			"UPDATE org_ingest_keys SET session_salt_ciphertext = NULL, session_salt_iv = NULL, session_salt_tag = NULL WHERE org_id = $1",
			[orgId],
		),
	)

/**
 * Wraps the test Database so a competing writer deterministically WINS the
 * backfill race. `getSessionSalt` over a saltless row issues exactly three
 * statements — select, conditional update, re-read — so firing the interloper
 * just before the second one guarantees the service's own
 * `WHERE session_salt_ciphertext IS NULL` update matches zero rows. Racing two
 * real fibers would only exercise this branch by scheduling luck.
 */
const racingDatabaseLayer = (testDb: TestDb, interlope: () => Promise<void>) =>
	Layer.effect(
		Database,
		Effect.gen(function* () {
			const base = yield* Database
			let calls = 0

			return Database.of({
				execute: <T>(fn: (db: DatabaseClient) => Promise<T>) =>
					Effect.gen(function* () {
						calls += 1
						if (calls === 2) yield* Effect.promise(interlope)
						return yield* base.execute(fn)
					}),
			})
		}),
	).pipe(Layer.provide(testDb.layer))

describe("OrgIngestKeysService", () => {
	it.effect("lazily creates keys for a new org", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const result = yield* OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a"))

			assert.isTrue(result.publicKey.startsWith("maple_pk_"))
			assert.isTrue(result.privateKey.startsWith("maple_sk_"))
			assert.isFalse(Number.isNaN(Date.parse(result.publicRotatedAt)))
			assert.isFalse(Number.isNaN(Date.parse(result.privateRotatedAt)))
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("returns stable keys when called repeatedly without reroll", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const first = yield* OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a"))
			const second = yield* OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a"))

			assert.deepStrictEqual(second, first)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("rerolls only the public key", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const first = yield* OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a"))
			const rerolled = yield* OrgIngestKeysService.rerollPublic(asOrgId("org_a"), asUserId("user_a"))

			assert.notStrictEqual(rerolled.publicKey, first.publicKey)
			assert.strictEqual(rerolled.privateKey, first.privateKey)
			assert.isTrue(Date.parse(rerolled.publicRotatedAt) >= Date.parse(first.publicRotatedAt))
			assert.strictEqual(rerolled.privateRotatedAt, first.privateRotatedAt)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("rerolls only the private key", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const first = yield* OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a"))
			const rerolled = yield* OrgIngestKeysService.rerollPrivate(asOrgId("org_a"), asUserId("user_a"))

			assert.strictEqual(rerolled.publicKey, first.publicKey)
			assert.notStrictEqual(rerolled.privateKey, first.privateKey)
			assert.strictEqual(rerolled.publicRotatedAt, first.publicRotatedAt)
			assert.isTrue(Date.parse(rerolled.privateRotatedAt) >= Date.parse(first.privateRotatedAt))
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("keeps keys isolated by org", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const orgA = yield* OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a"))
			const orgB = yield* OrgIngestKeysService.getOrCreate(asOrgId("org_b"), asUserId("user_b"))

			assert.notStrictEqual(orgA.publicKey, orgB.publicKey)
			assert.notStrictEqual(orgA.privateKey, orgB.privateKey)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("stores private key encrypted at rest", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const created = yield* OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a"))

			const row = yield* Effect.promise(() =>
				queryFirstRow<{
					private_key_ciphertext: string
					private_key_iv: string
					private_key_tag: string
				}>(
					testDb,
					"SELECT private_key_ciphertext, private_key_iv, private_key_tag FROM org_ingest_keys WHERE org_id = $1",
					["org_a"],
				),
			)

			assert.isDefined(row)
			assert.isTrue(Boolean(row?.private_key_ciphertext))
			assert.isTrue(Boolean(row?.private_key_iv))
			assert.isTrue(Boolean(row?.private_key_tag))
			assert.notStrictEqual(row?.private_key_ciphertext, created.privateKey)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("stores deterministic HMAC hashes for public/private keys", () => {
		const testDb = createTestDb(trackedDbs)
		const lookupHmacKey = "maple-test-lookup-secret"

		return Effect.gen(function* () {
			const created = yield* OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a"))

			const row = yield* Effect.promise(() =>
				queryFirstRow<{
					public_key_hash: string
					private_key_hash: string
				}>(
					testDb,
					"SELECT public_key_hash, private_key_hash FROM org_ingest_keys WHERE org_id = $1",
					["org_a"],
				),
			)

			assert.isDefined(row)
			assert.strictEqual(row?.public_key_hash, hashIngestKey(created.publicKey, lookupHmacKey))
			assert.strictEqual(row?.private_key_hash, hashIngestKey(created.privateKey, lookupHmacKey))
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("resolves keys by hash and key type", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const created = yield* OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a"))
			const publicResolved = yield* OrgIngestKeysService.resolveIngestKey(created.publicKey)
			const privateResolved = yield* OrgIngestKeysService.resolveIngestKey(created.privateKey)
			const invalidResolved = yield* OrgIngestKeysService.resolveIngestKey("not-a-maple-key")

			assert.isTrue(Option.isSome(publicResolved))
			assert.isTrue(Option.isSome(privateResolved))
			if (Option.isSome(publicResolved)) {
				assert.strictEqual(publicResolved.value.orgId, asOrgId("org_a"))
				assert.strictEqual(publicResolved.value.keyType, "public")
			}
			if (Option.isSome(privateResolved)) {
				assert.strictEqual(privateResolved.value.orgId, asOrgId("org_a"))
				assert.strictEqual(privateResolved.value.keyType, "private")
			}
			assert.deepStrictEqual(invalidResolved, Option.none())
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("reroll invalidates previous key hashes immediately", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const first = yield* OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a"))
			const rerolledPublic = yield* OrgIngestKeysService.rerollPublic(
				asOrgId("org_a"),
				asUserId("user_a"),
			)
			const oldPublic = yield* OrgIngestKeysService.resolveIngestKey(first.publicKey)
			const newPublic = yield* OrgIngestKeysService.resolveIngestKey(rerolledPublic.publicKey)
			const rerolledPrivate = yield* OrgIngestKeysService.rerollPrivate(
				asOrgId("org_a"),
				asUserId("user_a"),
			)
			const oldPrivate = yield* OrgIngestKeysService.resolveIngestKey(first.privateKey)
			const newPrivate = yield* OrgIngestKeysService.resolveIngestKey(rerolledPrivate.privateKey)

			assert.deepStrictEqual(oldPublic, Option.none())
			assert.isTrue(Option.isSome(newPublic))
			if (Option.isSome(newPublic)) {
				assert.strictEqual(newPublic.value.orgId, asOrgId("org_a"))
				assert.strictEqual(newPublic.value.keyType, "public")
			}
			assert.deepStrictEqual(oldPrivate, Option.none())
			assert.isTrue(Option.isSome(newPrivate))
			if (Option.isSome(newPrivate)) {
				assert.strictEqual(newPrivate.value.orgId, asOrgId("org_a"))
				assert.strictEqual(newPrivate.value.keyType, "private")
			}
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("fails fast on invalid encryption key configuration", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const layer = makeLayer(testDb, "invalid-base64-key")

			const exit = yield* Effect.exit(
				OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a")).pipe(
					Effect.provide(layer),
				),
			)
			const failure = getError(exit)

			assert.isTrue(Exit.isFailure(exit))
			assert.instanceOf(failure, IngestKeyEncryptionError)
		}),
	)

	it.effect("fails when encryption key config is missing", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const layer = OrgIngestKeysService.layer.pipe(
				Layer.provide(testDb.layer),
				Layer.provide(Env.layer),
				Layer.provide(makeConfig()),
			)

			const exit = yield* Effect.exit(
				OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a")).pipe(
					Effect.provide(layer),
				),
			)

			assert.isTrue(Exit.isFailure(exit))
		}),
	)

	it.effect("provisions an encrypted session salt when creating keys", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			yield* OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a"))

			const row = yield* readSaltColumns(testDb)
			const salt = yield* OrgIngestKeysService.getSessionSalt(asOrgId("org_a"), asUserId("user_a"))

			assert.isTrue(Boolean(row?.session_salt_ciphertext))
			assert.isTrue(Boolean(row?.session_salt_iv))
			assert.isTrue(Boolean(row?.session_salt_tag))
			// 32 random bytes, base64url — and the plaintext is never what is stored.
			assert.strictEqual(Buffer.from(Redacted.value(salt), "base64url").length, 32)
			assert.notStrictEqual(Redacted.value(salt), row?.session_salt_ciphertext)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("keeps session salts distinct per org and stable across reads", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const first = yield* OrgIngestKeysService.getSessionSalt(asOrgId("org_a"), asUserId("user_a"))
			const again = yield* OrgIngestKeysService.getSessionSalt(asOrgId("org_a"), asUserId("user_a"))
			const other = yield* OrgIngestKeysService.getSessionSalt(asOrgId("org_b"), asUserId("user_b"))

			assert.strictEqual(Redacted.value(again), Redacted.value(first))
			assert.notStrictEqual(Redacted.value(other), Redacted.value(first))
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("survives a reroll of either key", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const before = yield* OrgIngestKeysService.getSessionSalt(asOrgId("org_a"), asUserId("user_a"))
			yield* OrgIngestKeysService.rerollPublic(asOrgId("org_a"), asUserId("user_a"))
			yield* OrgIngestKeysService.rerollPrivate(asOrgId("org_a"), asUserId("user_a"))
			const after = yield* OrgIngestKeysService.getSessionSalt(asOrgId("org_a"), asUserId("user_a"))

			// Rerolling a key must not re-salt: that would break session-count
			// continuity for an unrelated operation.
			assert.strictEqual(Redacted.value(after), Redacted.value(before))
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("lazily backfills the salt for rows created before the column existed", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			yield* OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a")).pipe(
				Effect.provide(makeLayer(testDb)),
			)
			yield* clearSalt(testDb)
			const cleared = yield* readSaltColumns(testDb)

			// Fresh instance: an empty memo is what a saltless row actually meets.
			const salt = yield* OrgIngestKeysService.getSessionSalt(
				asOrgId("org_a"),
				asUserId("user_a"),
			).pipe(Effect.provide(makeLayer(testDb)))
			const filled = yield* readSaltColumns(testDb)

			assert.isNull(cleared?.session_salt_ciphertext)
			assert.isTrue(Boolean(filled?.session_salt_ciphertext))
			assert.isTrue(Boolean(filled?.session_salt_iv))
			assert.isTrue(Boolean(filled?.session_salt_tag))
			assert.strictEqual(Buffer.from(Redacted.value(salt), "base64url").length, 32)
		})
	})

	it.effect("hands concurrent readers the same salt when backfilling", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			yield* OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a")).pipe(
				Effect.provide(makeLayer(testDb)),
			)
			yield* clearSalt(testDb)

			// Two independent service instances (separate memos), as two isolates
			// hitting the same row would be.
			const [saltA, saltB] = yield* Effect.all(
				[
					OrgIngestKeysService.getSessionSalt(asOrgId("org_a"), asUserId("user_a")).pipe(
						Effect.provide(makeLayer(testDb)),
					),
					OrgIngestKeysService.getSessionSalt(asOrgId("org_a"), asUserId("user_b")).pipe(
						Effect.provide(makeLayer(testDb)),
					),
				],
				{ concurrency: "unbounded" },
			)
			const stored = yield* OrgIngestKeysService.getSessionSalt(
				asOrgId("org_a"),
				asUserId("user_a"),
			).pipe(Effect.provide(makeLayer(testDb)))

			assert.strictEqual(Redacted.value(saltB), Redacted.value(saltA))
			assert.strictEqual(Redacted.value(stored), Redacted.value(saltA))
		})
	})

	it.effect("adopts the winner's salt when it loses the backfill race", () => {
		const testDb = createTestDb(trackedDbs)
		const winnerSalt = Buffer.alloc(32, 9).toString("base64url")
		const encrypted = Effect.runSync(
			encryptAes256Gcm(winnerSalt, TEST_ENCRYPTION_KEY, (message) => new Error(message)),
		)

		return Effect.gen(function* () {
			yield* OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a")).pipe(
				Effect.provide(makeLayer(testDb)),
			)
			yield* clearSalt(testDb)

			const interlope = () =>
				executeSql(
					testDb,
					"UPDATE org_ingest_keys SET session_salt_ciphertext = $1, session_salt_iv = $2, session_salt_tag = $3 WHERE org_id = $4",
					[encrypted.ciphertext, encrypted.iv, encrypted.tag, "org_a"],
				)

			const salt = yield* OrgIngestKeysService.getSessionSalt(
				asOrgId("org_a"),
				asUserId("user_a"),
			).pipe(Effect.provide(makeLayerFrom(racingDatabaseLayer(testDb, interlope))))
			const stored = yield* readSaltColumns(testDb)

			// The loser must discard its own generated salt entirely — both the value
			// it returns and the value left in the row are the winner's.
			assert.strictEqual(Redacted.value(salt), winnerSalt)
			assert.strictEqual(stored?.session_salt_ciphertext, encrypted.ciphertext)
		})
	})

	it.effect("maps database errors to IngestKeyPersistenceError", () =>
		Effect.gen(function* () {
			const layer = OrgIngestKeysService.layer.pipe(
				Layer.provide(failingDatabaseLayer),
				Layer.provide(Env.layer),
				Layer.provide(makeConfig(Buffer.alloc(32, 3).toString("base64"))),
			)

			const exit = yield* Effect.exit(
				OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a")).pipe(
					Effect.provide(layer),
				),
			)
			const failure = getError(exit)

			assert.isTrue(Exit.isFailure(exit))
			assert.instanceOf(failure, IngestKeyPersistenceError)
		}),
	)
})
