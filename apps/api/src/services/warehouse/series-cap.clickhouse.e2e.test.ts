// SAFETY-FILE: JSON is emitted by the isolated ClickHouse fixture and decoded by the real query schema.
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { compileUnsafe, from, param, table } from "@maple-dev/clickhouse-builder"
import * as T from "@maple-dev/clickhouse-builder/types"
import { finalizeTimeseries } from "../../../../../packages/query-engine/src/ch/queries/series-cap"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import { clickhouseE2eEnabled, clickhouseExec, uniqueDatabase } from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_series_cap_e2e")
const outputColumns = { bucket: T.string, groupName: T.string, value: T.nullable(T.float64), flag: T.bool }
const inputs = table("series_inputs", { OrgId: T.string, ...outputColumns }, { tenantColumn: "OrgId" })
const inner = from(inputs)
	.select(($) => ({ bucket: $.bucket, groupName: $.groupName, value: $.value, flag: $.flag }))
	.where(($) => [$.OrgId.eq(param.string("orgId"))])
	.orderBy(["bucket", "asc"], ["groupName", "asc"])

describe.skipIf(!clickhouseE2eEnabled)("series cap result parity", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await clickhouseExec(
			"CREATE TABLE series_inputs (OrgId String, bucket String, groupName String, value Nullable(Float64), flag Bool) ENGINE=Memory",
			database,
		)
		await clickhouseExec(
			`INSERT INTO series_inputs VALUES
			('test', '1', 'peak', 20, true), ('test', '2', 'peak', 0, false),
			('test', '1', 'total', 11, false), ('test', '2', 'total', 11, true),
			('test', '1', 'tie-a', 10, true), ('test', '2', 'tie-a', 1, false),
			('test', '1', 'tie-b', 10, false), ('test', '2', 'tie-b', 2, true),
			('test', '1', 'negative', -10, false), ('test', '2', 'negative', -1, true),
			('test', '1', 'null', NULL, false), ('test', '2', 'null', NULL, true),
			('other', '1', 'cross-tenant', 100000, true),
			('nonfinite', '1', 'nan', nan, false), ('nonfinite', '2', 'nan', nan, true),
			('nonfinite', '1', 'infinity', inf, true), ('nonfinite', '2', 'infinity', 1, false),
			('nonfinite', '1', 'finite', 10, false), ('nonfinite', '2', 'finite', -inf, true)`,
			database,
		)
		await clickhouseExec(
			`INSERT INTO series_inputs
			SELECT 'large', toString(intDiv(number, 5000)), concat('service-', toString(number % 5000)),
			toFloat64(number % 5000), number % 2 = 0 FROM numbers(50000)`,
			database,
		)
	})

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	})

	const run = async (orgId: string, seriesLimit: number) => {
		const compiled = compileUnsafe(
			finalizeTimeseries(inner, outputColumns, "value", { seriesLimit, groupBy: ["service"] }),
			{ orgId },
		)
		assert.strictEqual(compiled.tenantScope, "single-tenant")
		const body = JSON.parse(
			await clickhouseExec(normalizeSqlForClickHouseClient(compiled.sql) + " FORMAT JSON", database, {
				max_threads: "2",
				max_memory_usage: "134217728",
			}),
		)
		assert.isDefined(compiled.rowSchema)
		return Schema.decodeUnknownSync(Schema.Array(compiled.rowSchema!))(body.data)
	}

	for (const seriesLimit of [1, 2, 3, 4, 5, 6, 20]) {
		it(`returns every bucket of the top ${seriesLimit} groups with stable ties`, async () => {
			const rows = await run("test", seriesLimit)
			const selectedGroups = ["peak", "total", "tie-a", "tie-b", "negative", "null"].slice(
				0,
				seriesLimit,
			)
			const original = JSON.parse(
				await clickhouseExec(
					"SELECT bucket, groupName, value, flag FROM series_inputs WHERE OrgId = 'test' ORDER BY bucket, groupName FORMAT JSON",
					database,
				),
			).data
			assert.deepEqual(
				rows,
				original.filter((row: { groupName: string }) => selectedGroups.includes(row.groupName)),
			)
			assert.strictEqual(rows.length, Math.min(seriesLimit, 6) * 2)
		})
	}

	it("matches the prior top-group selection for non-finite metric values", async () => {
		const base = normalizeSqlForClickHouseClient(compileUnsafe(inner, { orgId: "nonfinite" }).sql)
		for (const seriesLimit of [1, 2, 3]) {
			const rows = await run("nonfinite", seriesLimit)
			const reference = JSON.parse(
				await clickhouseExec(
					`WITH base AS (${base}) SELECT * FROM base
				WHERE groupName IN (SELECT groupName FROM base GROUP BY groupName ORDER BY max(value) DESC, groupName ASC LIMIT ${seriesLimit})
				ORDER BY bucket, groupName FORMAT JSON`,
					database,
				),
			).data
			assert.deepEqual(rows, reference)
		}
	})

	it("caps a populated 5,000-group chart within the memory budget", async () => {
		const rows = await run("large", 3)
		assert.strictEqual(rows.length, 30)
		assert.deepEqual([...new Set(rows.map((row) => row.groupName))].sort(), [
			"service-4997",
			"service-4998",
			"service-4999",
		])
	})

	it("handles empty tenants and preserves the uncapped query", async () => {
		assert.deepEqual(await run("missing", 3), [])
		assert.strictEqual((await run("test", 0)).length, 12)
		assert.strictEqual((await run("test", 2.9)).length, 4)
	})
})
