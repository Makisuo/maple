import { afterEach, assert, describe, it } from "@effect/vitest"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import { IngestKeyEncryptionError, IngestKeyPersistenceError, OrgId, UserId } from "@maple/domain/http"
import { hashIngestKey } from "@maple/db"
import { Database, DatabaseError } from "@/platform/DatabaseLive"
import { Env } from "@/platform/Env"
import { OrgIngestKeysService } from "./OrgIngestKeysService"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@/platform/test-pglite"

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

const makeLayer = (testDb: TestDb, encryptionKey = Buffer.alloc(32, 7).toString("base64")) =>
	OrgIngestKeysService.layer.pipe(
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig(encryptionKey)),
	)

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

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
