import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { MAX_RAW_SQL_RESULT_ROWS } from "@maple/domain/http"
import { computeBucketSecondsForRange } from "@maple/query-engine"
import { runRawSql, autoBucketSeconds } from "./run-raw-sql"
import {
	WarehouseQueryService,
	type WarehouseQueryServiceApi,
} from "@/services/warehouse/WarehouseQueryService"
import { AuditLogService } from "@/services/audit/AuditLogService"
import type { TenantContext } from "@/services/auth/tenant-context"

const tenant = { orgId: "org_test" } as TenantContext

const makeStub = (
	rows: ReadonlyArray<Record<string, unknown>>,
	captured?: { sql?: string; profile?: string; context?: string },
): WarehouseQueryServiceApi =>
	({
		rawSqlQuery: (
			_t: unknown,
			sql: string,
			options?: { readonly profile?: string; readonly context?: string },
		) => {
			if (captured) {
				captured.sql = sql
				captured.profile = options?.profile
				captured.context = options?.context
			}
			return Effect.succeed(rows)
		},
	}) as WarehouseQueryServiceApi

// `runRawSql` records `telemetry.sql_executed` on every path, rejections
// included, so the audit service is part of every harness here — the in-memory
// one, since what is asserted below is the SQL, not the audit row.
const provide = (stub: WarehouseQueryServiceApi) =>
	Layer.merge(Layer.succeed(WarehouseQueryService, stub), AuditLogService.layerMemory)

const range = { startTime: "2026-04-01 00:00:00", endTime: "2026-04-01 01:00:00" }

describe("runRawSql", () => {
	it.effect("expands macros and returns rows + column metadata", () =>
		Effect.gen(function* () {
			const captured: {
				sql?: string
				profile?: string
				context?: string
			} = {} satisfies {
				sql?: string
				profile?: string
				context?: string
			}
			const result = yield* runRawSql({
				tenant,
				sql: "SELECT ServiceName, count() AS c FROM traces WHERE $__orgFilter GROUP BY ServiceName",
				...range,
				granularitySeconds: 60,
			}).pipe(Effect.provide(provide(makeStub([{ ServiceName: "api", c: 3 }], captured))))

			// $__orgFilter expanded to the scoped predicate before execution.
			assert.include(captured.sql ?? "", "OrgId = 'org_test'")
			assert.strictEqual(captured.profile, "rawInteractive")
			assert.strictEqual(captured.context, "mcp.run_sql")
			assert.strictEqual(result.rowCount, 1)
			assert.deepStrictEqual([...result.columns], ["ServiceName", "c"])
		}),
	)

	it.effect("fails with RawSqlValidationError when $__orgFilter is missing", () =>
		Effect.gen(function* () {
			const exit = yield* runRawSql({
				tenant,
				sql: "SELECT count() FROM traces",
				...range,
				granularitySeconds: 60,
			}).pipe(Effect.provide(provide(makeStub([]))), Effect.exit)

			assert.isTrue(exit._tag === "Failure")
			if (exit._tag === "Failure") {
				const err = exit.cause
				assert.include(JSON.stringify(err), "MissingOrgFilter")
			}
		}),
	)

	it.effect("rejects DDL/DML keywords", () =>
		Effect.gen(function* () {
			const exit = yield* runRawSql({
				tenant,
				sql: "DROP TABLE traces WHERE $__orgFilter",
				...range,
				granularitySeconds: 60,
			}).pipe(Effect.provide(provide(makeStub([]))), Effect.exit)

			assert.isTrue(exit._tag === "Failure")
		}),
	)

	it.effect("rejects results above the hard row cap", () =>
		Effect.gen(function* () {
			const rows = Array.from({ length: MAX_RAW_SQL_RESULT_ROWS + 1 }, (_, value) => ({ value }))
			const exit = yield* runRawSql({
				tenant,
				sql: "SELECT value FROM traces WHERE $__orgFilter",
				...range,
				granularitySeconds: 60,
			}).pipe(Effect.provide(provide(makeStub(rows))), Effect.exit)

			assert.isTrue(exit._tag === "Failure")
			assert.include(JSON.stringify(exit), "ResourceLimit")
		}),
	)
})

describe("autoBucketSeconds", () => {
	it("is the signed-in raw-SQL policy: 300s floor, coarser for long windows", () => {
		const short = autoBucketSeconds("2026-04-01 00:00:00", "2026-04-01 00:05:00")
		const long = autoBucketSeconds("2026-04-01 00:00:00", "2026-04-08 00:00:00")
		assert.isTrue(short < long)
		assert.strictEqual(short, 300)
		assert.strictEqual(
			long,
			computeBucketSecondsForRange("2026-04-01 00:00:00", "2026-04-08 00:00:00", "rawSql"),
		)
	})

	it("falls back to 300 for invalid ranges", () => {
		assert.strictEqual(autoBucketSeconds("nonsense", "also-bad"), 300)
	})
})
