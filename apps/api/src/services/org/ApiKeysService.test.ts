import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import { ApiKeyNotFoundError, OrgId, UserId } from "@maple/domain/http"
import { Env } from "@/platform/Env"
import { ApiKeysService } from "./ApiKeysService"
import { cleanupTestDbs, createTestDb, executeSql, queryFirstRow, type TestDb } from "@/platform/test-pglite"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

const makeConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			MCP_PORT: "3473",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

const makeLayer = (testDb: TestDb) =>
	ApiKeysService.layer.pipe(
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig()),
	)

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

describe("ApiKeysService.roll", () => {
	it.effect("revokes the old key and issues a new active key inheriting name/kind", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const svc = yield* ApiKeysService
			const orgId = asOrgId("org_a")

			const created = yield* svc.create(orgId, asUserId("user_a"), {
				name: "CI/CD Pipeline",
				description: "deploys",
				kind: "mcp",
			})
			assert.match(created.txid ?? "", /^\d+$/)

			const rolled = yield* svc.roll(orgId, asUserId("user_b"), created.id, {
				createdByEmail: "roller@example.com",
			})

			// New, distinct key that inherits identity but gets a fresh secret/prefix.
			assert.notStrictEqual(rolled.id, created.id)
			assert.strictEqual(rolled.name, created.name)
			assert.strictEqual(rolled.kind, "mcp")
			assert.notStrictEqual(rolled.keyPrefix, created.keyPrefix)
			assert.notStrictEqual(rolled.secret, created.secret)
			assert.strictEqual(rolled.revoked, false)
			assert.strictEqual(rolled.lastUsedAt, null)
			assert.strictEqual(rolled.expiresAt, null)
			assert.match(rolled.txid ?? "", /^\d+$/)

			const { keys } = yield* svc.list(orgId)
			const oldRow = keys.find((k) => k.id === created.id)
			const newRow = keys.find((k) => k.id === rolled.id)

			assert.isDefined(oldRow)
			assert.strictEqual(oldRow?.revoked, true)
			assert.isNumber(oldRow?.revokedAt)
			assert.isDefined(newRow)
			assert.strictEqual(newRow?.revoked, false)

			// The new secret authenticates; the old one no longer does.
			const resolvedNew = yield* svc.resolveByKey(rolled.secret)
			const resolvedOld = yield* svc.resolveByKey(created.secret)
			assert.isTrue(Option.isSome(resolvedNew))
			if (Option.isSome(resolvedNew)) {
				assert.strictEqual(resolvedNew.value.keyId, rolled.id)
				assert.strictEqual(resolvedNew.value.kind, "mcp")
			}
			assert.deepStrictEqual(resolvedOld, Option.none())
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("fails to roll an already-revoked key", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const svc = yield* ApiKeysService
			const orgId = asOrgId("org_a")

			const created = yield* svc.create(orgId, asUserId("user_a"), { name: "temp" })
			yield* svc.revoke(orgId, created.id)

			const exit = yield* Effect.exit(svc.roll(orgId, asUserId("user_a"), created.id, {}))

			assert.isTrue(Exit.isFailure(exit))
			const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
			assert.instanceOf(failure, ApiKeyNotFoundError)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	/**
	 * Both concurrency barriers live in one place: the conditional
	 * `UPDATE … WHERE revoked = false` that opens the roll transaction. Each caller
	 * reads the key as live before anyone writes (the reads interleave on the
	 * async boundary), so without that predicate every caller would go on to
	 * insert a successor — two live keys from one roll/roll race, and a live
	 * successor for a key a concurrent revoke had already retired.
	 */
	describe("concurrency barriers", () => {
		const countKeys = (testDb: TestDb, orgId: string) =>
			Effect.promise(async () => {
				const row = await queryFirstRow<{ total: number; active: number }>(
					testDb,
					`select count(*)::int as total, count(*) filter (where revoked = false)::int as active
					 from api_keys where org_id = $1`,
					[orgId],
				)
				return row
			})

		it.effect("roll vs roll: only one successor is ever created", () => {
			const testDb = createTestDb(trackedDbs)

			return Effect.gen(function* () {
				const svc = yield* ApiKeysService
				const orgId = asOrgId("org_roll_race")
				const created = yield* svc.create(orgId, asUserId("user_a"), { name: "contended" })

				const exits = yield* Effect.all(
					[
						Effect.exit(svc.roll(orgId, asUserId("user_a"), created.id, {})),
						Effect.exit(svc.roll(orgId, asUserId("user_b"), created.id, {})),
					],
					{ concurrency: 2 },
				)

				const succeeded = exits.filter(Exit.isSuccess)
				assert.strictEqual(succeeded.length, 1, "exactly one roll may win the source row")
				const losers = exits.filter(Exit.isFailure)
				assert.strictEqual(losers.length, 1)
				assert.instanceOf(Option.getOrUndefined(Exit.findErrorOption(losers[0])), ApiKeyNotFoundError)

				const counts = yield* countKeys(testDb, orgId)
				assert.deepStrictEqual(
					{ total: counts?.total, active: counts?.active },
					{ total: 2, active: 1 },
					"one successor, and the source is revoked",
				)
			}).pipe(Effect.provide(makeLayer(testDb)))
		})

		it.effect("revoke vs roll: a revoked key never gets a successor", () => {
			const testDb = createTestDb(trackedDbs)

			return Effect.gen(function* () {
				const svc = yield* ApiKeysService
				const orgId = asOrgId("org_revoke_race")
				const created = yield* svc.create(orgId, asUserId("user_a"), { name: "contended" })

				const [revoked, rollExit] = yield* Effect.all(
					[
						svc.revoke(orgId, created.id),
						Effect.exit(svc.roll(orgId, asUserId("user_b"), created.id, {})),
					],
					{ concurrency: 2 },
				)

				assert.strictEqual(revoked.revoked, true)
				assert.isTrue(Exit.isFailure(rollExit), "the roll must lose to the committed revoke")
				assert.instanceOf(Option.getOrUndefined(Exit.findErrorOption(rollExit)), ApiKeyNotFoundError)

				const counts = yield* countKeys(testDb, orgId)
				assert.deepStrictEqual(
					{ total: counts?.total, active: counts?.active },
					{ total: 1, active: 0 },
					"no successor row exists for the revoked key",
				)
			}).pipe(Effect.provide(makeLayer(testDb)))
		})
	})

	it.effect("returns a reconciliation txid when revoking", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const svc = yield* ApiKeysService
			const orgId = asOrgId("org_a")
			const created = yield* svc.create(orgId, asUserId("user_a"), { name: "temp" })

			const revoked = yield* svc.revoke(orgId, created.id)

			assert.strictEqual(revoked.revoked, true)
			assert.match(revoked.txid ?? "", /^\d+$/)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})

/**
 * `api_keys` is Electric-synced and carries `last_used_at` in the browser shape, so an
 * unconditional touch per request replicates a full row out of PlanetScale on every
 * authenticated call. Both gates are asserted here because they cover different failure
 * modes: the memo handles a warm isolate, the SQL predicate handles a cold one. Losing
 * either silently restores per-request WAL traffic — invisible until the egress bill.
 */
describe("ApiKeysService.touchLastUsed", () => {
	const readLastUsed = (testDb: TestDb, keyId: string) =>
		Effect.promise(() =>
			queryFirstRow<{ lastUsedAt: Date | null }>(
				testDb,
				`select last_used_at as "lastUsedAt" from api_keys where id = $1`,
				[keyId],
			),
		)

	it.effect("skips the write within the heartbeat window, on a warm and a cold isolate", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const svc = yield* ApiKeysService
			const orgId = asOrgId("org_touch")
			const created = yield* svc.create(orgId, asUserId("user_touch"), {
				name: "hot path",
				kind: "mcp",
			})

			// Driven directly rather than through `resolveByBearer` so the assertions
			// stay on the memo and the SQL gate, not on key resolution.
			yield* svc.touchLastUsed(created.id)
			const afterFirst = yield* readLastUsed(testDb, created.id)
			assert.isOk(afterFirst?.lastUsedAt, "the first touch stamps last_used_at")

			// Warm isolate: clear the column behind the service's back. A second touch on
			// the same instance must not rewrite it — the memo should short-circuit
			// before the query is ever issued.
			yield* Effect.promise(() =>
				executeSql(testDb, `update api_keys set last_used_at = null where id = $1`, [created.id]),
			)
			yield* svc.touchLastUsed(created.id)
			const afterMemoized = yield* readLastUsed(testDb, created.id)
			assert.isNull(afterMemoized?.lastUsedAt ?? null, "memo suppresses the second write")

			// Cold isolate: a fresh service instance over the same database has an empty
			// memo, so the round trip happens — but the SQL predicate must make it a
			// zero-row UPDATE while the stored stamp is inside the heartbeat window.
			const stamped = new Date()
			yield* Effect.promise(() =>
				executeSql(testDb, `update api_keys set last_used_at = $2 where id = $1`, [
					created.id,
					stamped,
				]),
			)
			yield* Effect.gen(function* () {
				const coldSvc = yield* ApiKeysService
				yield* coldSvc.touchLastUsed(created.id)
			}).pipe(Effect.provide(makeLayer(testDb)))

			const afterCold = yield* readLastUsed(testDb, created.id)
			assert.strictEqual(
				afterCold?.lastUsedAt?.getTime(),
				stamped.getTime(),
				"SQL gate makes the cold-isolate touch a zero-row update",
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
