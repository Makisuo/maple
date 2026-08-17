import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { clickHouseVersionAtLeast } from "@maple/domain/clickhouse"
import { OrgId, RawSqlValidationError, UserId } from "@maple/domain/http"
import { prepareRawSql } from "@maple/query-engine/runtime"
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import { OrgClickHouseSettingsService } from "@/services/org/OrgClickHouseSettingsService"
import { TinybirdOrgTokenService } from "@/services/integrations/TinybirdOrgTokenService"
import type { TenantContext } from "@/services/auth/AuthService"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { WarehouseQueryService, __testables } from "./WarehouseQueryService"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	clickhousePassword,
	clickhouseUrl,
	clickhouseUser,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const enabled = clickhouseE2eEnabled
const database = uniqueDatabase("maple_raw_sql_e2e")
const orgId = "org_raw_sql_e2e"
/** Isolates the 0016 default-readback probe row from the query tests' fixtures. */
const aiProbeOrgId = "org_raw_sql_e2e_ai_probe"

const assertSearchSchemaApplied = async (): Promise<void> => {
	const migrationRevision = (
		await clickhouseExec(
			"SELECT count() FROM _maple_schema_migrations WHERE version = 10 FORMAT TabSeparated",
			database,
		)
	).trim()
	assert.strictEqual(migrationRevision, "1", "performance migration 10 was not recorded")

	const portableIndexCount = (
		await clickhouseExec(
			`SELECT count()
FROM system.data_skipping_indices
WHERE database = currentDatabase()
  AND (
    (table = 'logs' AND name IN (
      'idx_resource_attr_keys', 'idx_resource_attr_vals',
      'idx_scope_attr_keys', 'idx_scope_attr_vals',
      'idx_log_attr_keys', 'idx_log_attr_vals', 'idx_lower_body'
    ))
    OR
    (table = 'traces' AND name IN ('idx_scope_attr_keys', 'idx_scope_attr_vals'))
  )
FORMAT TabSeparated`,
			database,
		)
	).trim()
	assert.strictEqual(portableIndexCount, "9", "portable search indexes are incomplete")

	const computedColumnCount = (
		await clickhouseExec(
			`SELECT count()
FROM system.columns
WHERE database = currentDatabase()
  AND (
    (table = 'logs' AND name IN ('ResourceAttributeItems', 'ScopeAttributeItems', 'LogAttributeItems'))
    OR
    (table = 'traces' AND name IN ('ResourceAttributeItems', 'ScopeAttributeItems', 'SpanAttributeItems'))
  )
FORMAT TabSeparated`,
			database,
		)
	).trim()
	assert.strictEqual(computedColumnCount, "6", "computed search columns are incomplete")

	const serverVersion = (await clickhouseExec("SELECT version() FORMAT TabSeparated", database)).trim()
	if (!clickHouseVersionAtLeast(serverVersion, "26.2.0")) return

	const textFeatureRevision = (
		await clickhouseExec(
			"SELECT max(revision) FROM _maple_schema_features WHERE id = 'search_text_v1' FORMAT TabSeparated",
			database,
		)
	).trim()
	assert.strictEqual(textFeatureRevision, "1", "text search feature was not recorded")

	const textIndexCount = (
		await clickhouseExec(
			`SELECT count()
FROM system.data_skipping_indices
WHERE database = currentDatabase()
  AND name IN (
    'idx_resource_attr_items_text', 'idx_scope_attr_items_text',
    'idx_log_attr_items_text', 'idx_span_attr_items_text', 'idx_lower_body_text'
  )
FORMAT TabSeparated`,
			database,
		)
	).trim()
	assert.strictEqual(textIndexCount, "7", "text search indexes are incomplete")

	await clickhouseExec(
		`INSERT INTO logs (
  OrgId, Timestamp, TimestampTime, TraceId, SpanId, TraceFlags,
  SeverityText, SeverityNumber, ServiceName, Body,
  ResourceSchemaUrl, ResourceAttributes,
  ScopeSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes, LogAttributes
) VALUES (
  '${orgId}', now64(9), now(), 'trace-search', 'span-search', 1,
  'ERROR', 17, 'api', 'Connection timeout while contacting database',
  '', map('deployment.environment', 'e2e'),
  '', 'e2e', '1', map(), map('db.system', 'postgresql')
)`,
		database,
	)
	const scanCount = (
		await clickhouseExec(
			`SELECT count()
FROM logs
WHERE OrgId = '${orgId}' AND Body ILIKE '%connection timeout%'
FORMAT TabSeparated`,
			database,
		)
	).trim()
	const indexedCount = (
		await clickhouseExec(
			`SELECT count()
FROM logs
WHERE OrgId = '${orgId}' AND hasAllTokens(lower(Body), 'connection timeout')
SETTINGS enable_full_text_index = 1
FORMAT TabSeparated`,
			database,
		)
	).trim()
	assert.strictEqual(indexedCount, scanCount, "indexed and fallback log search disagree")

	const explain = await clickhouseExec(
		`EXPLAIN indexes = 1
SELECT count()
FROM logs
WHERE OrgId = '${orgId}' AND hasAllTokens(lower(Body), 'connection timeout')
SETTINGS enable_full_text_index = 1`,
		database,
	)
	assert.include(explain, "idx_lower_body_text")
}

/**
 * Migration 0016 against a real server: `set(0)` and `tokenbf_v1` are the kind of
 * DDL a SQL-text test happily accepts and ClickHouse rejects.
 */
const assertAiClassificationSchemaApplied = async (): Promise<void> => {
	const migrationRevision = (
		await clickhouseExec(
			"SELECT count() FROM _maple_schema_migrations WHERE version = 15 FORMAT TabSeparated",
			database,
		)
	).trim()
	assert.strictEqual(migrationRevision, "1", "AI classification migration 15 was not recorded")

	const columns = (
		await clickhouseExec(
			`SELECT name, type, default_kind
FROM system.columns
WHERE database = currentDatabase()
  AND table = 'traces'
  AND name IN ('AiVendor', 'AiSessionKeyState', 'AiSessionKeyHash', 'AiRulesVersion', 'AiRollupHour')
ORDER BY name
FORMAT TabSeparated`,
			database,
		)
	)
		.trim()
		// TabSeparated escapes single quotes, so `DateTime('UTC')` arrives as
		// `DateTime(\'UTC\')`.
		.replaceAll("\\'", "'")
	assert.strictEqual(
		columns,
		[
			"AiRollupHour\tDateTime('UTC')\tDEFAULT",
			"AiRulesVersion\tUInt32\tDEFAULT",
			"AiSessionKeyHash\tUInt64\tDEFAULT",
			"AiSessionKeyState\tUInt8\tDEFAULT",
			"AiVendor\tLowCardinality(String)\tDEFAULT",
		].join("\n"),
		"AI classification columns are missing, mistyped, or not default-computed",
	)

	const indexes = (
		await clickhouseExec(
			`SELECT name, type_full, granularity
FROM system.data_skipping_indices
WHERE database = currentDatabase()
  AND table = 'traces'
  AND name IN ('idx_ai_vendor', 'idx_scope_name')
ORDER BY name
FORMAT TabSeparated`,
			database,
		)
	).trim()
	assert.strictEqual(
		indexes,
		["idx_ai_vendor\tset(0)\t4", "idx_scope_name\ttokenbf_v1(4096, 3, 0)\t4"].join("\n"),
		"AI classification skip indexes are missing or declared with the wrong type",
	)

	// A writer that names none of the new columns must still land a readable row.
	// Own org, so it stays out of the fixtures the tests below assert on.
	await clickhouseExec(
		`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode)
		 VALUES ('${aiProbeOrgId}', now64(9), 'trace-ai-default', 'span-ai-default', 'GET /ai', 'Server', 'api', 1, 'Ok')`,
		database,
	)
	const defaults = (
		await clickhouseExec(
			`SELECT AiVendor = '', AiSessionKeyState, AiSessionKeyHash, AiRulesVersion, toUnixTimestamp(AiRollupHour)
FROM traces
WHERE OrgId = '${aiProbeOrgId}' AND TraceId = 'trace-ai-default'
FORMAT TabSeparated`,
			database,
		)
	).trim()
	assert.strictEqual(defaults, "1\t0\t0\t0\t0", "AI classification defaults do not read back")
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
	const edgeCacheLive = EdgeCacheService.layer.pipe(Layer.provide(MemoryCacheBackendLive))
	const orgSettingsLive = OrgClickHouseSettingsService.layer.pipe(
		Layer.provide(Layer.mergeAll(envLive, testDb.layer, edgeCacheLive)),
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
		await applyRealMigrations(database)
		await assertSearchSchemaApplied()
		await assertAiClassificationSchemaApplied()
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

	// Pins the wire-format parity fix itself, independent of catalog coverage:
	// the production ClickHouse client must receive 64-bit ints as JSON numbers
	// (output_format_json_quote_64bit_integers=0), exactly like the Tinybird SDK,
	// so schema-less queries decode identically on both backends.
	it("returns 64-bit integers as JSON numbers through the production client", async () => {
		const client = __testables.createClickHouseSqlClient({
			kind: "clickhouse",
			url: clickhouseUrl,
			username: clickhouseUser,
			password: clickhousePassword,
			database,
		})
		// No trailing FORMAT: the client owns the output format (the executor's
		// normalizeSqlForClient strips it on the real path).
		const result = await client.sql("SELECT toUInt64(42) AS wide, count() AS c FROM system.one")
		const row = result.data[0]
		assert.isDefined(row)
		assert.strictEqual(typeof row!.wide, "number", "UInt64 arrived as a string — the quote pin is gone")
		assert.strictEqual(row!.wide, 42)
		assert.strictEqual(typeof row!.c, "number")
	}, 60_000)
})
