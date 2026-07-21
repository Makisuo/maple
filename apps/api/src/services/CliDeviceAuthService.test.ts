import { afterEach, describe, expect, it } from "@effect/vitest"
import { OrgId, RoleName, UserId } from "@maple/domain/http"
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect"
import { Env } from "../lib/Env"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "../lib/test-pglite"
import { ApiKeysService } from "./ApiKeysService"
import { CliDeviceAuthService } from "./CliDeviceAuthService"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const config = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_APP_BASE_URL: "https://app.example.com",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

const makeLayer = (testDb: TestDb) => {
	const base = Layer.mergeAll(testDb.layer, Env.layer.pipe(Layer.provide(config())))
	const apiKeys = ApiKeysService.layer.pipe(Layer.provide(base))
	return CliDeviceAuthService.layer.pipe(Layer.provideMerge(apiKeys), Layer.provide(base))
}

const orgId = Schema.decodeUnknownSync(OrgId)("org_cli")
const userId = Schema.decodeUnknownSync(UserId)("user_cli")
const memberRole = Schema.decodeUnknownSync(RoleName)("org:member")

describe("CliDeviceAuthService", () => {
	it.effect("runs an idempotent browser approval flow and preserves roles", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const auth = yield* CliDeviceAuthService
			const apiKeys = yield* ApiKeysService
			const started = yield* auth.start("Maple CLI on laptop", "127.0.0.1")
			expect(started.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
			expect(started.verificationUriComplete).toContain(encodeURIComponent(started.userCode))

			const pending = yield* auth.poll(started.deviceCode)
			expect(pending.status).toBe("pending")
			const inspected = yield* auth.inspect(started.userCode.toLowerCase())
			expect(inspected.deviceName).toBe("Maple CLI on laptop")

			yield* auth.approve(started.userCode, {
				orgId,
				userId,
				roles: [memberRole],
				userEmail: "member@example.com",
			})
			const [first, second] = yield* Effect.all(
				[auth.poll(started.deviceCode), auth.poll(started.deviceCode)],
				{ concurrency: 2 },
			)
			expect(first.status).toBe("complete")
			expect(second.status).toBe("complete")
			if (first.status !== "complete" || second.status !== "complete") return
			expect(second.token).toBe(first.token)

			const resolved = yield* apiKeys.resolveByKey(first.token)
			expect(Option.isSome(resolved)).toBe(true)
			if (Option.isSome(resolved)) {
				expect(resolved.value.cliManaged).toBe(true)
				expect(resolved.value.roles).toEqual([memberRole])
			}
		}).pipe(Effect.provide(makeLayer(db)))
	})

	it.effect("returns denied and expired terminal states without creating credentials", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const auth = yield* CliDeviceAuthService
			const denied = yield* auth.start("Maple CLI", "127.0.0.1")
			yield* auth.deny(denied.userCode)
			expect((yield* auth.poll(denied.deviceCode)).status).toBe("denied")

			const expired = yield* auth.start("Maple CLI", "127.0.0.2")
			yield* Effect.promise(() =>
				executeSql(db, "UPDATE cli_device_authorizations SET expires_at = '1969-01-01T00:00:00Z'"),
			)
			expect((yield* auth.poll(expired.deviceCode)).status).toBe("expired")
		}).pipe(Effect.provide(makeLayer(db)))
	})
})
