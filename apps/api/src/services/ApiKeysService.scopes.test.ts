import { afterEach, describe, expect, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect"
import { Env } from "../lib/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "../lib/test-pglite"
import { ApiKeysService } from "./ApiKeysService"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3478",
			MCP_PORT: "3479",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

const makeLayer = () => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	return ApiKeysService.layer.pipe(Layer.provide(Layer.mergeAll(envLive, testDb.layer)))
}

const ORG = Schema.decodeUnknownSync(OrgId)("org_test")
const USER = Schema.decodeUnknownSync(UserId)("user_test")

describe("ApiKeysService scopes", () => {
	it.effect("persists scopes on create and resolves them by key", () =>
		Effect.gen(function* () {
			const service = yield* ApiKeysService

			const created = yield* service.create(ORG, USER, {
				name: "restricted",
				scopes: ["api_keys:read", "dashboards:write"],
			})
			expect(created.scopes).toEqual(["api_keys:read", "dashboards:write"])

			const resolved = yield* service.resolveByKey(created.secret)
			expect(Option.isSome(resolved)).toBe(true)
			if (Option.isSome(resolved)) {
				expect(resolved.value.scopes).toEqual(["api_keys:read", "dashboards:write"])
			}

			const fetched = yield* service.get(ORG, created.id)
			expect(fetched.scopes).toEqual(["api_keys:read", "dashboards:write"])
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("legacy keys without scopes resolve with scopes null (full access)", () =>
		Effect.gen(function* () {
			const service = yield* ApiKeysService

			const created = yield* service.create(ORG, USER, { name: "legacy" })
			expect(created.scopes).toBeNull()

			const resolved = yield* service.resolveByKey(created.secret)
			expect(Option.isSome(resolved)).toBe(true)
			if (Option.isSome(resolved)) {
				expect(resolved.value.scopes).toBeNull()
			}
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("roll preserves the original key's scopes", () =>
		Effect.gen(function* () {
			const service = yield* ApiKeysService

			const created = yield* service.create(ORG, USER, {
				name: "ci",
				scopes: ["telemetry:read"],
			})
			const rolled = yield* service.roll(ORG, USER, created.id, {})
			expect(rolled.scopes).toEqual(["telemetry:read"])

			// old secret is dead, new secret carries the scopes
			const oldResolved = yield* service.resolveByKey(created.secret)
			expect(Option.isNone(oldResolved)).toBe(true)
			const newResolved = yield* service.resolveByKey(rolled.secret)
			expect(Option.isSome(newResolved)).toBe(true)
			if (Option.isSome(newResolved)) {
				expect(newResolved.value.scopes).toEqual(["telemetry:read"])
			}
		}).pipe(Effect.provide(makeLayer())),
	)
})
