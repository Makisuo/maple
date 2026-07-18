import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option } from "effect"
import {
	MAX_RAW_SQL_CELL_LENGTH,
	MAX_RAW_SQL_LENGTH,
	MAX_RAW_SQL_RESULT_BYTES,
	MAX_RAW_SQL_RESULT_ROWS,
	RawSqlValidationError,
} from "@maple/domain/http"
import { makeExecuteRawSql, prepareRawSql } from "./raw-sql"

const baseInput = {
	orgId: "org_abc",
	startTime: "2026-05-14 00:00:00",
	endTime: "2026-05-14 06:00:00",
	granularitySeconds: 60,
	workload: "interactive" as const,
}

const getError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
	if (!Exit.isFailure(exit)) return undefined
	return Option.getOrElse(Exit.findErrorOption(exit), () => Cause.squash(exit.cause))
}

const prepareOk = (sql: string) => prepareRawSql({ ...baseInput, sql })

const prepareFail = (sql: string, workload: "interactive" | "alert" = "interactive") =>
	Effect.gen(function* () {
		const exit = yield* Effect.exit(prepareRawSql({ ...baseInput, sql, workload }))
		const error = getError(exit)
		if (!(error instanceof RawSqlValidationError)) {
			throw new Error(`expected RawSqlValidationError, got: ${String(error)}`)
		}
		return error
	})

describe("prepareRawSql", () => {
	it.effect("rejects SQL missing $__orgFilter", () =>
		Effect.gen(function* () {
			const error = yield* prepareFail("SELECT 1 FROM Logs")
			assert.strictEqual(error.code, "MissingOrgFilter")
		}),
	)

	it.effect("requires a time filter for alerts only", () =>
		Effect.gen(function* () {
			yield* prepareOk("SELECT 1 FROM Logs WHERE $__orgFilter")
			const error = yield* prepareFail("SELECT 1 FROM Logs WHERE $__orgFilter", "alert")
			assert.strictEqual(error.code, "InvalidMacro")
		}),
	)

	it.effect("validates length and granularity", () =>
		Effect.gen(function* () {
			assert.strictEqual((yield* prepareFail("")).code, "ResourceLimit")
			assert.strictEqual(
				(yield* prepareFail(`SELECT '${"x".repeat(MAX_RAW_SQL_LENGTH)}' WHERE $__orgFilter`)).code,
				"ResourceLimit",
			)
			const exit = yield* Effect.exit(
				prepareRawSql({
					...baseInput,
					granularitySeconds: Number.NaN,
					sql: "SELECT 1 WHERE $__orgFilter",
				}),
			)
			assert.instanceOf(getError(exit), RawSqlValidationError)
		}),
	)

	it.effect("rejects multiple statements but ignores semicolons inside strings", () =>
		Effect.gen(function* () {
			assert.strictEqual(
				(yield* prepareFail("SELECT 1 WHERE $__orgFilter; SELECT 2")).code,
				"MultipleStatements",
			)
			const result = yield* prepareOk("SELECT 'a;b' AS value WHERE $__orgFilter")
			assert.include(result.sql, "'a;b'")
		}),
	)

	for (const keyword of [
		"INSERT",
		"UPDATE",
		"DELETE",
		"DROP",
		"ALTER",
		"TRUNCATE",
		"RENAME",
		"ATTACH",
		"DETACH",
		"CREATE",
		"GRANT",
		"REVOKE",
		"OPTIMIZE",
		"SYSTEM",
		"KILL",
	]) {
		it.effect(`rejects deny-listed keyword ${keyword}`, () =>
			Effect.gen(function* () {
				const error = yield* prepareFail(`${keyword} TABLE Logs WHERE $__orgFilter`)
				assert.strictEqual(error.code, "DisallowedStatement")
			}),
		)
	}

	it.effect("accepts SELECT/WITH and rejects other query forms", () =>
		Effect.gen(function* () {
			yield* prepareOk("SELECT 1 WHERE $__orgFilter")
			yield* prepareOk("WITH 1 AS value SELECT value WHERE $__orgFilter")
			assert.strictEqual(
				(yield* prepareFail("EXPLAIN SELECT 1 WHERE $__orgFilter")).code,
				"DisallowedStatement",
			)
		}),
	)

	it.effect("validates and expands macros", () =>
		Effect.gen(function* () {
			assert.strictEqual(
				(yield* prepareFail(
					"SELECT $__bogus FROM Logs WHERE $__orgFilter AND $__timeFilter(Timestamp)",
				)).code,
				"UnresolvedMacro",
			)
			assert.strictEqual(
				(yield* prepareFail("SELECT 1 FROM Logs WHERE $__orgFilter AND $__timeFilter(1 OR 1=1)"))
					.code,
				"InvalidMacro",
			)

			const result = yield* prepareOk(
				"SELECT toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND) AS bucket FROM Logs WHERE $__orgFilter AND $__timeFilter(Timestamp)",
			)
			assert.include(result.sql, "OrgId = 'org_abc'")
			assert.include(result.sql, "toDateTime('2026-05-14 00:00:00')")
			assert.include(result.sql, "toDateTime('2026-05-14 06:00:00')")
			assert.include(result.sql, "INTERVAL 60 SECOND")
			assert.match(result.sql, /^SELECT \* FROM \(/)
			assert.match(result.sql, /LIMIT 1001\s*$/)
		}),
	)

	it.effect("escapes the org literal before validation", () =>
		Effect.gen(function* () {
			const result = yield* prepareRawSql({
				...baseInput,
				orgId: "org'); DROP TABLE Logs --",
				sql: "SELECT 1 FROM Logs WHERE $__orgFilter",
			})
			assert.include(result.sql, "OrgId = 'org\\'); DROP TABLE Logs --'")
		}),
	)
})

const executeRows = (rows: ReadonlyArray<Record<string, unknown>>) =>
	makeExecuteRawSql({
		rawSqlQuery: () => Effect.succeed(rows),
	})(
		{},
		{
			...baseInput,
			sql: "SELECT 1 AS value WHERE $__orgFilter",
			context: "test",
		},
	)

describe("makeExecuteRawSql", () => {
	it.effect("accepts exactly 1,000 rows and returns metadata", () =>
		Effect.gen(function* () {
			const rows = Array.from({ length: MAX_RAW_SQL_RESULT_ROWS }, (_, value) => ({ value }))
			const result = yield* executeRows(rows)
			assert.strictEqual(result.rowCount, MAX_RAW_SQL_RESULT_ROWS)
			assert.deepStrictEqual(result.columns, ["value"])
		}),
	)

	it.effect("rejects the 1,001-row sentinel", () =>
		Effect.gen(function* () {
			const rows = Array.from({ length: MAX_RAW_SQL_RESULT_ROWS + 1 }, (_, value) => ({ value }))
			const error = yield* Effect.flip(executeRows(rows))
			assert.strictEqual(error.code, "ResourceLimit")
			assert.include(error.message, "rows")
		}),
	)

	it.effect("rejects oversized cells, encoded output, and unserializable values", () =>
		Effect.gen(function* () {
			const cellError = yield* Effect.flip(
				executeRows([{ value: "x".repeat(MAX_RAW_SQL_CELL_LENGTH + 1) }]),
			)
			assert.include(cellError.message, "cells")

			const bytesError = yield* Effect.flip(
				executeRows(
					Array.from({ length: 100 }, (_, value) => ({
						value,
						payload: "x".repeat(Math.ceil(MAX_RAW_SQL_RESULT_BYTES / 100)),
					})),
				),
			)
			assert.include(bytesError.message, "bytes")

			const jsonError = yield* Effect.flip(executeRows([{ value: 1n }]))
			assert.include(jsonError.message, "JSON serializable")
		}),
	)
})
