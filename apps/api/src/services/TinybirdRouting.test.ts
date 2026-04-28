import { afterEach, describe, expect, it } from "vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { OrgId, RoleName, UserId } from "@maple/domain/http"
import { DatabaseLibsqlLive } from "./DatabaseLibsqlLive"
import { Env } from "./Env"
import { OrgTinybirdSettingsService } from "./OrgTinybirdSettingsService"
import { SelfManagedCollectorConfigService } from "./SelfManagedCollectorConfigService"
import { TinybirdService, __testables as tinybirdTestables } from "./TinybirdService"
import {
	makeTestTinybirdSyncClientLayer,
	type TinybirdSyncClientOverrides,
} from "./TinybirdSyncClient.testing"
import { cleanupTempDirs, createTempDbUrl as makeTempDb, executeSql, queryFirstRow } from "./test-sqlite"

const createdTempDirs: string[] = []

afterEach(() => {
	tinybirdTestables.reset()
	cleanupTempDirs(createdTempDirs)
})

const createTempDbUrl = () => {
	const { url, dbPath } = makeTempDb("maple-tinybird-routing-", createdTempDirs)
	return { url, dbPath }
}

const makeConfig = (url: string) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://managed.tinybird.co",
			TINYBIRD_TOKEN: "managed-token",
			MAPLE_DB_URL: url,
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

const makeTinybirdLayer = (url: string, overrides: TinybirdSyncClientOverrides = {}) =>
	TinybirdService.Default.pipe(
		Layer.provide(
			OrgTinybirdSettingsService.Live.pipe(
				Layer.provide(makeTestTinybirdSyncClientLayer(overrides)),
				Layer.provide(SelfManagedCollectorConfigService.Live),
				Layer.provide(DatabaseLibsqlLive),
			),
		),
		Layer.provide(Env.Default),
		Layer.provide(makeConfig(url)),
	)

const makeOrgTinybirdLayer = (url: string, overrides: TinybirdSyncClientOverrides = {}) =>
	OrgTinybirdSettingsService.Live.pipe(
		Layer.provide(makeTestTinybirdSyncClientLayer(overrides)),
		Layer.provide(
			SelfManagedCollectorConfigService.Live.pipe(
				Layer.provide(DatabaseLibsqlLive),
				Layer.provide(Env.Default),
				Layer.provide(makeConfig(url)),
			),
		),
		Layer.provide(DatabaseLibsqlLive),
		Layer.provide(Env.Default),
		Layer.provide(makeConfig(url)),
	)

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asRoleName = Schema.decodeUnknownSync(RoleName)

const tenant = {
	orgId: asOrgId("org_a"),
	userId: asUserId("user_a"),
	roles: [asRoleName("root")],
	authMode: "self_hosted" as const,
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("Tinybird routing", () => {
	it("uses the env-backed Tinybird client by default for raw queries", async () => {
		const { url } = createTempDbUrl()
		const calls: Array<{ baseUrl: string; token: string }> = []

		tinybirdTestables.setClientFactory((baseUrl, token) => {
			calls.push({ baseUrl, token })
			return {
				sql: async () => ({
					data: [{ message: "managed" }],
				}),
			}
		})

		const result = await Effect.runPromise(
			TinybirdService.query(tenant, {
				pipe: "list_logs",
				params: {},
			}).pipe(Effect.provide(makeTinybirdLayer(url))),
		)

		expect(result.data).toBeDefined()
		expect(calls).toEqual([{ baseUrl: "https://managed.tinybird.co", token: "managed-token" }])
	})

	it("sqlQuery rejects SQL without OrgId filter", async () => {
		const { url } = createTempDbUrl()

		tinybirdTestables.setClientFactory(() => ({
			sql: async () => ({ data: [] }),
		}))

		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* TinybirdService
				return yield* service.sqlQuery(tenant, "SELECT 1").pipe(Effect.flip)
			}).pipe(Effect.provide(makeTinybirdLayer(url))),
		)

		expect(error.message).toContain("OrgId filter")
	})

	it("sqlQuery accepts SQL with OrgId filter", async () => {
		const { url } = createTempDbUrl()

		tinybirdTestables.setClientFactory(() => ({
			sql: async () => ({ data: [{ result: 1 }] }),
		}))

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* TinybirdService
				return yield* service.sqlQuery(tenant, "SELECT 1 FROM traces WHERE OrgId = 'org_a'")
			}).pipe(Effect.provide(makeTinybirdLayer(url))),
		)

		expect(result).toEqual([{ result: 1 }])
	})

	it("uses the org-specific Tinybird client for raw queries when an override exists", async () => {
		const { url, dbPath } = createTempDbUrl()

		// Simulate the Tinybird sync workflow completing: write both the sync-run
		// "succeeded" row and the active settings row so TinybirdService picks up
		// the BYO override on subsequent queries.
		const completeSync = async (orgId: string) => {
			const now = Date.now()
			const existing = await queryFirstRow<{
				requested_by: string
				target_token_ciphertext: string
				target_token_iv: string
				target_token_tag: string
				target_host: string
			}>(
				dbPath,
				"SELECT requested_by, target_host, target_token_ciphertext, target_token_iv, target_token_tag FROM org_tinybird_sync_runs WHERE org_id = ?",
				[orgId],
			)
			if (!existing) return

			await executeSql(
				dbPath,
				`INSERT INTO org_tinybird_settings (
          org_id, host, token_ciphertext, token_iv, token_tag, sync_status,
          last_sync_at, last_sync_error, project_revision, last_deployment_id,
          created_at, updated_at, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, 'rev-1', 'dep-1', ?, ?, ?, ?)
        ON CONFLICT(org_id) DO UPDATE SET
          host=excluded.host,
          token_ciphertext=excluded.token_ciphertext,
          token_iv=excluded.token_iv,
          token_tag=excluded.token_tag,
          project_revision='rev-1',
          last_deployment_id='dep-1',
          updated_at=excluded.updated_at`,
				[
					orgId,
					existing.target_host,
					existing.target_token_ciphertext,
					existing.target_token_iv,
					existing.target_token_tag,
					now,
					now,
					now,
					existing.requested_by,
					existing.requested_by,
				],
			)

			await executeSql(
				dbPath,
				`UPDATE org_tinybird_sync_runs SET run_status='succeeded', phase='succeeded', deployment_id='dep-1', deployment_status='live', finished_at=?, updated_at=? WHERE org_id = ?`,
				[now, now, orgId],
			)
		}

		const overrides: TinybirdSyncClientOverrides = {
			getProjectRevision: async () => "rev-1",
			startWorkflow: async (orgId) => {
				// The real workflow is async; queue the state mutation the same way.
				void Promise.resolve().then(() => completeSync(orgId))
			},
		}

		const calls: Array<{ baseUrl: string; token: string; method: string }> = []
		tinybirdTestables.setClientFactory((baseUrl, token) => ({
			sql: async () => {
				calls.push({ baseUrl, token, method: "sql" })
				return { data: [{ message: "byo" }] }
			},
		}))

		const combinedLayer = Layer.mergeAll(
			makeOrgTinybirdLayer(url, overrides),
			makeTinybirdLayer(url, overrides),
		)

		const rawResult = await Effect.runPromise(
			Effect.gen(function* () {
				yield* OrgTinybirdSettingsService.upsert(tenant.orgId, tenant.userId, tenant.roles, {
					host: "https://customer.tinybird.co",
					token: "customer-token",
				})
				yield* Effect.promise(() => sleep(50))

				return yield* TinybirdService.query(tenant, {
					pipe: "list_logs",
					params: {},
				})
			}).pipe(Effect.provide(combinedLayer)),
		)

		expect(rawResult.data).toEqual([{ message: "byo" }])
		expect(calls).toEqual([
			{
				baseUrl: "https://customer.tinybird.co",
				token: "customer-token",
				method: "sql",
			},
		])
	})
})
