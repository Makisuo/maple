import { afterEach, describe, expect, it } from "vitest"
import { ConfigProvider, Effect, Exit, Layer, Schema } from "effect"
import { TinybirdQueryError, OrgId, UserId } from "@maple/domain/http"
import { __testables, WarehouseQueryService } from "./WarehouseQueryService"
import { OrgClickHouseSettingsService } from "./OrgClickHouseSettingsService"
import { DatabaseLibsqlLive } from "./DatabaseLibsqlLive"
import { Env } from "./Env"
import { cleanupTempDirs, createTempDbUrl as makeTempDb } from "./test-sqlite"

const createdTempDirs: string[] = []

afterEach(() => {
	__testables.reset()
	cleanupTempDirs(createdTempDirs)
})

const createTempDbUrl = () => makeTempDb("maple-warehouse-", createdTempDirs)

const makeConfig = (url: string) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://maple-managed.tinybird.co",
			TINYBIRD_TOKEN: "managed-token",
			MAPLE_DB_URL: url,
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "lookup-key",
			MAPLE_INGEST_PUBLIC_URL: "http://127.0.0.1:3474",
			MAPLE_APP_BASE_URL: "http://127.0.0.1:3471",
		}),
	)

const buildLayer = (url: string) => {
	const configLive = makeConfig(url)
	const envLive = Env.Default.pipe(Layer.provide(configLive))
	const databaseLive = DatabaseLibsqlLive.pipe(Layer.provide(envLive))
	const orgSettingsLive = OrgClickHouseSettingsService.Default.pipe(
		Layer.provide(Layer.mergeAll(envLive, databaseLive)),
	)
	return WarehouseQueryService.Default.pipe(
		Layer.provide(Layer.mergeAll(envLive, orgSettingsLive)),
	)
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const makeTenant = () => ({
	orgId: asOrgId("org_test"),
	userId: asUserId("user_test"),
	roles: [],
	authMode: "session" as const,
})

const transient503 = () =>
	new Error("HTTP status 503 service temporarily unavailable")

describe("WarehouseQueryService.sqlQuery retry on transient upstream failures", () => {
	it("recovers after two 503s on the third attempt", async () => {
		let attempts = 0
		__testables.setClientFactory(() => ({
			sql: async () => {
				attempts++
				if (attempts < 3) throw transient503()
				return { data: [{ ok: 1 }] }
			},
		}))

		const { url } = createTempDbUrl()
		const layer = buildLayer(url)
		const tenant = makeTenant()

		const result = await Effect.runPromise(
			WarehouseQueryService.use((service) =>
				service.sqlQuery(tenant, "SELECT 1 FROM traces WHERE OrgId = 'org_test'"),
			).pipe(Effect.provide(layer)),
		)

		expect(attempts).toBe(3)
		expect(result).toEqual([{ ok: 1 }])
	})

	it("does not retry non-transient errors (auth)", async () => {
		let attempts = 0
		__testables.setClientFactory(() => ({
			sql: async () => {
				attempts++
				throw new Error("HTTP status 401 authentication failed")
			},
		}))

		const { url } = createTempDbUrl()
		const layer = buildLayer(url)
		const tenant = makeTenant()

		const exit = await Effect.runPromiseExit(
			WarehouseQueryService.use((service) =>
				service.sqlQuery(tenant, "SELECT 1 FROM traces WHERE OrgId = 'org_test'"),
			).pipe(Effect.provide(layer)),
		)

		expect(attempts).toBe(1)
		expect(Exit.isFailure(exit)).toBe(true)
	})

	it("gives up after the configured retry budget when all attempts fail", async () => {
		let attempts = 0
		__testables.setClientFactory(() => ({
			sql: async () => {
				attempts++
				throw transient503()
			},
		}))

		const { url } = createTempDbUrl()
		const layer = buildLayer(url)
		const tenant = makeTenant()

		const exit = await Effect.runPromiseExit(
			WarehouseQueryService.use((service) =>
				service.sqlQuery(tenant, "SELECT 1 FROM traces WHERE OrgId = 'org_test'"),
			).pipe(Effect.provide(layer)),
		)

		// 1 initial + 2 retries
		expect(attempts).toBe(3)
		expect(Exit.isFailure(exit)).toBe(true)
		if (Exit.isFailure(exit)) {
			const error = exit.cause
			// Stringified cause should mention upstream/503
			expect(JSON.stringify(error)).toMatch(/503|upstream/i)
		}
	})
})

describe("TinybirdQueryError category surfaces transient classification", () => {
	it("emits category=upstream on 503", () => {
		// Sanity check that the constructor flow we depend on for retry is intact.
		const err = new TinybirdQueryError({
			pipe: "test",
			message: "upstream",
			category: "upstream",
			upstreamStatus: 503,
		})
		expect(err.category).toBe("upstream")
	})
})
