import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option } from "effect"
import { RawSqlValidationError } from "@maple/domain/http"
import { RawSqlChartService } from "./raw-sql"

const baseInput = {
	orgId: "org_abc",
	startTime: "2026-05-14 00:00:00",
	endTime: "2026-05-14 06:00:00",
	granularitySeconds: 60,
}

const getError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
	if (!Exit.isFailure(exit)) return undefined
	const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
	if (failure !== undefined) return failure
	return Cause.squash(exit.cause)
}

const expandOk = (sql: string) =>
	Effect.gen(function* () {
		const svc = yield* RawSqlChartService
		return yield* svc.expandMacros({ ...baseInput, sql })
	})

const expandFail = (sql: string) =>
	Effect.gen(function* () {
		const svc = yield* RawSqlChartService
		const exit = yield* Effect.exit(svc.expandMacros({ ...baseInput, sql }))
		if (Exit.isSuccess(exit)) {
			throw new Error(`expected failure, got success: ${JSON.stringify(exit.value)}`)
		}
		const failure = getError(exit)
		if (!(failure instanceof RawSqlValidationError)) {
			throw new Error(`expected RawSqlValidationError, got: ${String(failure)}`)
		}
		return failure
	})

describe("RawSqlChartService.expandMacros", () => {
	it.layer(RawSqlChartService.layer)((it) => {
		it.effect("rejects SQL missing $__orgFilter", () =>
			Effect.gen(function* () {
				const svc = yield* RawSqlChartService
				const exit = yield* Effect.exit(
					svc.expandMacros({
						...baseInput,
						sql: "SELECT 1 FROM Logs",
					}),
				)
				assert.isTrue(Exit.isFailure(exit))
				const failure = getError(exit)
				assert.instanceOf(failure, RawSqlValidationError)
				assert.strictEqual((failure as RawSqlValidationError).code, "MissingOrgFilter")
			}),
		)

		it.effect("rejects SQL with multiple statements", () =>
			Effect.gen(function* () {
				const svc = yield* RawSqlChartService
				const exit = yield* Effect.exit(
					svc.expandMacros({
						...baseInput,
						sql: "SELECT 1 FROM Logs WHERE $__orgFilter; SELECT 2",
					}),
				)
				assert.isTrue(Exit.isFailure(exit))
				const failure = getError(exit)
				assert.instanceOf(failure, RawSqlValidationError)
				assert.strictEqual((failure as RawSqlValidationError).code, "MultipleStatements")
			}),
		)

		it.effect("does not flag semicolons inside string literals", () =>
			Effect.gen(function* () {
				const result = yield* expandOk(
					"SELECT 'a;b' AS x FROM Logs WHERE $__orgFilter AND $__timeFilter(Timestamp)",
				)
				assert.include(result.sql, "OrgId = 'org_abc'")
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
					const failure = yield* expandFail(
						`SELECT 1 FROM Logs WHERE $__orgFilter; ${keyword} TABLE Logs`,
					)
					// Either MultipleStatements (because of ';') or DisallowedStatement —
					// both correctly block the dangerous query. Tighten by also testing without ';'.
					assert.include(["MultipleStatements", "DisallowedStatement"], failure.code)
				}),
			)

			it.effect(`rejects standalone ${keyword} statement`, () =>
				Effect.gen(function* () {
					const failure = yield* expandFail(`${keyword} TABLE Logs WHERE $__orgFilter`)
					assert.strictEqual(failure.code, "DisallowedStatement")
				}),
			)
		}

		it.effect("rejects unknown macros", () =>
			Effect.gen(function* () {
				const failure = yield* expandFail(
					"SELECT $__bogus FROM Logs WHERE $__orgFilter AND $__timeFilter(Timestamp)",
				)
				assert.strictEqual(failure.code, "UnresolvedMacro")
			}),
		)

		it.effect("rejects malformed $__timeFilter column identifier", () =>
			Effect.gen(function* () {
				const failure = yield* expandFail(
					"SELECT 1 FROM Logs WHERE $__orgFilter AND $__timeFilter(1 OR 1=1)",
				)
				assert.strictEqual(failure.code, "InvalidMacro")
			}),
		)

		it.effect("expands the documented happy-path query", () =>
			Effect.gen(function* () {
				const result = yield* expandOk(
					"SELECT toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND) AS bucket, count() FROM Logs WHERE $__orgFilter AND $__timeFilter(Timestamp) GROUP BY bucket ORDER BY bucket",
				)
				assert.include(result.sql, "OrgId = 'org_abc'")
				assert.include(result.sql, "toDateTime('2026-05-14 00:00:00')")
				assert.include(result.sql, "toDateTime('2026-05-14 06:00:00')")
				assert.include(result.sql, "INTERVAL 60 SECOND")
				assert.include(result.sql, "Timestamp >= toDateTime('2026-05-14 00:00:00')")
				assert.include(result.sql, "Timestamp <= toDateTime('2026-05-14 06:00:00')")
				assert.strictEqual(result.granularitySeconds, 60)
			}),
		)

		it.effect("wraps queries with the 1,001-row overflow sentinel", () =>
			Effect.gen(function* () {
				const result = yield* expandOk(
					"SELECT 1 FROM Logs WHERE $__orgFilter AND $__timeFilter(Timestamp)",
				)
				assert.match(result.sql, /^SELECT \* FROM \(/)
				assert.match(result.sql, /LIMIT 1001\s*$/)
			}),
		)

		it.effect("enforces the outer cap even when the user requests a larger LIMIT", () =>
			Effect.gen(function* () {
				const result = yield* expandOk(
					"SELECT 1 FROM Logs WHERE $__orgFilter AND $__timeFilter(Timestamp) LIMIT 50000",
				)
				assert.include(result.sql, "LIMIT 50000")
				assert.match(result.sql, /LIMIT 1001\s*$/)
			}),
		)

		it.effect("escapes single quotes in the orgId", () =>
			Effect.gen(function* () {
				const svc = yield* RawSqlChartService
				const exit = yield* Effect.exit(
					svc.expandMacros({
						...baseInput,
						orgId: "org'); DROP TABLE Logs --",
						sql: "SELECT 1 FROM Logs WHERE $__orgFilter",
					}),
				)
				assert.isTrue(Exit.isSuccess(exit))
				if (Exit.isSuccess(exit)) {
					assert.include(exit.value.sql, "OrgId = 'org\\'); DROP TABLE Logs --'")
					// Crucially the masked deny-list scan now sees an empty literal, so the
					// DROP inside the literal does NOT trip the check.
				}
			}),
		)
	})
})
