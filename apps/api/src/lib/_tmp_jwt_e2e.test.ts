import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { __testables, WarehouseQueryService } from "./WarehouseQueryService"
import { OrgClickHouseSettingsService } from "../services/OrgClickHouseSettingsService"
import { TinybirdOrgTokenService } from "../services/TinybirdOrgTokenService"
import type { TenantContext } from "../services/AuthService"
import { Env } from "./Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "./test-pglite"

const ADMIN = (process.env.TB_ADMIN ?? "").trim()
const dbs: TestDb[] = []
afterEach(async () => {
	__testables.reset()
	await cleanupTestDbs(dbs)
})

const ORG = "org_39lDNgEjuXrOi0obeLpFSfyVSDo"
const T = "traces_aggregates_hourly"
const W = "Hour > now() - INTERVAL 48 HOUR"

const buildLayer = () => {
	const config = ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: ADMIN,
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "lookup-key",
			MAPLE_INGEST_PUBLIC_URL: "http://127.0.0.1:3474",
			MAPLE_APP_BASE_URL: "http://127.0.0.1:3471",
		}),
	)
	const envLive = Env.layer.pipe(Layer.provide(config))
	const db = createTestDb(dbs)
	const orgSettings = OrgClickHouseSettingsService.layer.pipe(Layer.provide(Layer.mergeAll(envLive, db.layer)))
	const tokens = TinybirdOrgTokenService.layer.pipe(Layer.provide(envLive))
	// NOTE: no setClientFactory — real Tinybird driver hits cloud /v0/sql.
	return WarehouseQueryService.layer.pipe(Layer.provide(Layer.mergeAll(envLive, orgSettings, tokens)))
}

const tenant = { orgId: ORG, userId: "user_e2e", authMode: "self_hosted" } as unknown as TenantContext

describe("raw-SQL JWT e2e (live Tinybird)", () => {
	it.live("scopes a real raw query to the org through the assembled path", () =>
		Effect.gen(function* () {
			const svc = yield* WarehouseQueryService
			const run = (sql: string) =>
				svc.sqlQuery(tenant, sql, { profile: "rawInteractive", context: "e2e", scopeToOrgJwt: true })

			const plain = yield* run(`SELECT count() c, count(DISTINCT OrgId) o FROM ${T} WHERE ${W}`)
			const bypass = yield* run(`SELECT count() c FROM ${T} WHERE ${W} AND (OrgId != '' OR 1=1)`)

			console.log("E2E plain:", plain[0], "bypass:", bypass[0])
			assert.strictEqual(Number(plain[0].o), 1, "query saw exactly one org")
			assert.isAbove(Number(plain[0].c), 0, "org has rows")
			assert.strictEqual(Number(bypass[0].c), Number(plain[0].c), "OR 1=1 did not widen the result")
		}).pipe(Effect.provide(buildLayer())),
	)
})
