import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { spawn } from "node:child_process"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { OrgId, RawSqlValidationError, UserId } from "@maple/domain/http"
import { prepareRawSql } from "@maple/query-engine/runtime"
import { OrgClickHouseSettingsService } from "../services/OrgClickHouseSettingsService"
import { TinybirdOrgTokenService } from "../services/TinybirdOrgTokenService"
import type { TenantContext } from "../services/AuthService"
import { Env } from "./Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "./test-pglite"
import { WarehouseQueryService } from "./WarehouseQueryService"

const enabled = process.env.CLICKHOUSE_E2E === "1"
const clickhouseUrl = process.env.CLICKHOUSE_E2E_URL ?? "http://127.0.0.1:8123"
const clickhouseUser = process.env.CLICKHOUSE_E2E_USER ?? "maple"
const clickhousePassword = process.env.CLICKHOUSE_E2E_PASSWORD ?? "maple"
const database = `maple_raw_sql_e2e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const orgId = "org_raw_sql_e2e"
const repoRoot = new URL("../../../..", import.meta.url).pathname

const clickhouseExec = async (sql: string, targetDatabase = "default"): Promise<string> => {
	const response = await fetch(
		`${clickhouseUrl.replace(/\/$/, "")}/?database=${encodeURIComponent(targetDatabase)}`,
		{
			method: "POST",
			redirect: "manual",
			headers: {
				"Content-Type": "text/plain",
				"X-ClickHouse-User": clickhouseUser,
				"X-ClickHouse-Key": clickhousePassword,
				"X-ClickHouse-Database": targetDatabase,
			},
			body: sql,
		},
	)
	const body = await response.text()
	if (!response.ok) throw new Error(`ClickHouse ${response.status}: ${body.slice(0, 500)}`)
	return body
}

const applyRealMigrations = async (): Promise<void> => {
	const child = spawn(
		"bun",
		[
			"run",
			"--cwd",
			"packages/clickhouse-cli",
			"start",
			"apply",
			`--url=${clickhouseUrl}`,
			`--user=${clickhouseUser}`,
			`--password=${clickhousePassword}`,
			`--database=${database}`,
		],
		{ cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
	)
	let stdout = ""
	let stderr = ""
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk
	})
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk
	})
	const exitCode = await new Promise<number>((resolve, reject) => {
		child.once("error", reject)
		child.once("close", (code) => resolve(code ?? 1))
	})
	if (exitCode !== 0) throw new Error(`Migration CLI failed (${exitCode}): ${stderr || stdout}`)
}

const trackedDbs: TestDb[] = []
const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const tenant: TenantContext = {
	orgId: asOrgId(orgId),
	userId: asUserId("user_raw_sql_e2e"),
	roles: [],
	authMode: "self_hosted",
}

const buildLayer = () => {
	const testDb = createTestDb(trackedDbs)
	const configLive = ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "http://127.0.0.1:7181",
			TINYBIRD_TOKEN: "unused-for-vanilla-clickhouse",
			CLICKHOUSE_URL: clickhouseUrl,
			CLICKHOUSE_PROVIDER: "clickhouse",
			CLICKHOUSE_USER: clickhouseUser,
			CLICKHOUSE_PASSWORD: clickhousePassword,
			CLICKHOUSE_DATABASE: database,
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: orgId,
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "raw-sql-e2e-lookup-key",
			MAPLE_INGEST_PUBLIC_URL: "http://127.0.0.1:3474",
			MAPLE_APP_BASE_URL: "http://127.0.0.1:3471",
		}),
	)
	const envLive = Env.layer.pipe(Layer.provide(configLive))
	const orgSettingsLive = OrgClickHouseSettingsService.layer.pipe(
		Layer.provide(Layer.mergeAll(envLive, testDb.layer)),
	)
	const tokensLive = TinybirdOrgTokenService.layer.pipe(Layer.provide(envLive))
	return WarehouseQueryService.layer.pipe(
		Layer.provide(Layer.mergeAll(envLive, orgSettingsLive, tokensLive)),
	)
}

const expand = (sql: string) =>
	prepareRawSql({
		sql,
		orgId,
		startTime: "2026-01-01 00:00:00",
		endTime: "2026-01-01 01:00:00",
		granularitySeconds: 60,
		workload: "interactive",
	})

describe.skipIf(!enabled)("WarehouseQueryService ClickHouse raw-SQL E2E", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations()
		await clickhouseExec(
			`INSERT INTO traces
			 (OrgId, Timestamp, TraceId, SpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode)
			 VALUES
			 ('${orgId}', now64(9), 'trace-a', 'span-a', 'GET /a', 'Server', 'api', 1000, 'Ok'),
			 ('${orgId}', now64(9), 'trace-b', 'span-b', 'GET /b', 'Server', 'worker', 2000, 'Error')`,
			database,
		)
	}, 120_000)

	afterAll(async () => {
		await cleanupTestDbs(trackedDbs)
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it.effect(
		"uses the configured ClickHouse password for raw SQL",
		() => {
			const layer = buildLayer()
			return Effect.gen(function* () {
				const query = yield* expand(
					"SELECT TraceId, ServiceName FROM traces WHERE $__orgFilter ORDER BY TraceId",
				)
				const rows = yield* WarehouseQueryService.use((service) =>
					service.rawSqlQuery(tenant, query.sql, {
						profile: "rawInteractive",
						context: "clickhouse.e2e.fixture",
					}),
				)
				assert.deepStrictEqual(rows, [
					{ TraceId: "trace-a", ServiceName: "api" },
					{ TraceId: "trace-b", ServiceName: "worker" },
				])
			}).pipe(Effect.provide(layer))
		},
		120_000,
	)

	it.effect(
		"accepts exactly 1,000 rows and aborts on the 1,001st streamed row",
		() => {
			const layer = buildLayer()
			return Effect.gen(function* () {
				const exact = yield* expand(
					`SELECT number, '${orgId}' AS OrgId FROM numbers(1000) WHERE $__orgFilter`,
				)
				const rows = yield* WarehouseQueryService.use((service) =>
					service.rawSqlQuery(tenant, exact.sql),
				)
				assert.strictEqual(rows.length, 1000)

				const overflow = yield* expand(
					`SELECT number, '${orgId}' AS OrgId FROM numbers(50000) WHERE $__orgFilter LIMIT 50000`,
				)
				const error = yield* Effect.flip(
					WarehouseQueryService.use((service) => service.rawSqlQuery(tenant, overflow.sql)),
				)
				assert.instanceOf(error, RawSqlValidationError)
				assert.strictEqual(error.code, "ResourceLimit")
			}).pipe(Effect.provide(layer))
		},
		120_000,
	)

	it.effect(
		"aborts a streamed JSONEachRow response above five megabytes",
		() => {
			const layer = buildLayer()
			return Effect.gen(function* () {
				const query = yield* expand(
					`SELECT number, repeat('x', 10000) AS payload, '${orgId}' AS OrgId FROM numbers(600) WHERE $__orgFilter`,
				)
				const error = yield* Effect.flip(
					WarehouseQueryService.use((service) => service.rawSqlQuery(tenant, query.sql)),
				)
				assert.instanceOf(error, RawSqlValidationError)
				assert.match(error.message, /5000000 encoded bytes/)
			}).pipe(Effect.provide(layer))
		},
		120_000,
	)
})
