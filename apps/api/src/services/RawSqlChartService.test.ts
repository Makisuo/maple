import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { RawSqlChartService } from "./RawSqlChartService"

const baseInput = {
	orgId: "org_abc",
	startTime: "2026-05-14 00:00:00",
	endTime: "2026-05-14 06:00:00",
	granularitySeconds: 60,
}

function run<A, E>(effect: Effect.Effect<A, E, RawSqlChartService>) {
	return Effect.runPromiseExit(effect.pipe(Effect.provide(RawSqlChartService.Default)))
}

async function expandOk(sql: string) {
	const exit = await run(
		Effect.gen(function* () {
			const svc = yield* RawSqlChartService
			return yield* svc.expandMacros({ ...baseInput, sql })
		}),
	)
	if (Exit.isFailure(exit)) {
		throw new Error(`expected success, got failure: ${JSON.stringify(exit.cause)}`)
	}
	return exit.value
}

async function expandFail(sql: string) {
	const exit = await run(
		Effect.gen(function* () {
			const svc = yield* RawSqlChartService
			return yield* svc.expandMacros({ ...baseInput, sql })
		}),
	)
	if (Exit.isSuccess(exit)) {
		throw new Error(`expected failure, got success: ${JSON.stringify(exit.value)}`)
	}
	return exit
}

describe("RawSqlChartService.expandMacros", () => {
	it("rejects SQL missing $__orgFilter", async () => {
		const exit = await run(
			Effect.gen(function* () {
				const svc = yield* RawSqlChartService
				return yield* svc.expandMacros({
					...baseInput,
					sql: "SELECT 1 FROM Logs",
				})
			}),
		)
		expect(Exit.isFailure(exit)).toBe(true)
		const json = JSON.stringify(exit)
		expect(json).toContain("MissingOrgFilter")
	})

	it("rejects SQL with multiple statements", async () => {
		const exit = await run(
			Effect.gen(function* () {
				const svc = yield* RawSqlChartService
				return yield* svc.expandMacros({
					...baseInput,
					sql: "SELECT 1 FROM Logs WHERE $__orgFilter; SELECT 2",
				})
			}),
		)
		expect(Exit.isFailure(exit)).toBe(true)
		expect(JSON.stringify(exit)).toContain("MultipleStatements")
	})

	it("does not flag semicolons inside string literals", async () => {
		const result = await expandOk(
			"SELECT 'a;b' AS x FROM Logs WHERE $__orgFilter AND $__timeFilter(Timestamp)",
		)
		expect(result.sql).toContain("OrgId = 'org_abc'")
	})

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
		it(`rejects deny-listed keyword ${keyword}`, async () => {
			const failure = await expandFail(
				`SELECT 1 FROM Logs WHERE $__orgFilter; ${keyword} TABLE Logs`,
			)
			// Either MultipleStatements (because of ';') or DisallowedStatement —
			// both correctly block the dangerous query. Tighten by also testing without ';'.
			expect(JSON.stringify(failure)).toMatch(/MultipleStatements|DisallowedStatement/)
		})

		it(`rejects standalone ${keyword} statement`, async () => {
			const failure = await expandFail(`${keyword} TABLE Logs WHERE $__orgFilter`)
			expect(JSON.stringify(failure)).toContain("DisallowedStatement")
		})
	}

	it("rejects unknown macros", async () => {
		const failure = await expandFail(
			"SELECT $__bogus FROM Logs WHERE $__orgFilter AND $__timeFilter(Timestamp)",
		)
		expect(JSON.stringify(failure)).toContain("UnresolvedMacro")
	})

	it("rejects malformed $__timeFilter column identifier", async () => {
		const failure = await expandFail(
			"SELECT 1 FROM Logs WHERE $__orgFilter AND $__timeFilter(1 OR 1=1)",
		)
		expect(JSON.stringify(failure)).toContain("InvalidMacro")
	})

	it("expands the documented happy-path query", async () => {
		const result = await expandOk(
			"SELECT toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND) AS bucket, count() FROM Logs WHERE $__orgFilter AND $__timeFilter(Timestamp) GROUP BY bucket ORDER BY bucket",
		)
		expect(result.sql).toContain("OrgId = 'org_abc'")
		expect(result.sql).toContain("toDateTime('2026-05-14 00:00:00')")
		expect(result.sql).toContain("toDateTime('2026-05-14 06:00:00')")
		expect(result.sql).toContain("INTERVAL 60 SECOND")
		expect(result.sql).toContain("Timestamp >= toDateTime('2026-05-14 00:00:00')")
		expect(result.sql).toContain("Timestamp <= toDateTime('2026-05-14 06:00:00')")
		expect(result.granularitySeconds).toBe(60)
	})

	it("appends a default LIMIT when the user did not specify one", async () => {
		const result = await expandOk(
			"SELECT 1 FROM Logs WHERE $__orgFilter AND $__timeFilter(Timestamp)",
		)
		expect(result.sql).toMatch(/LIMIT 10000\s*$/)
	})

	it("preserves the user's LIMIT if already present", async () => {
		const result = await expandOk(
			"SELECT 1 FROM Logs WHERE $__orgFilter AND $__timeFilter(Timestamp) LIMIT 7",
		)
		expect(result.sql).not.toContain("LIMIT 10000")
		expect(result.sql).toMatch(/LIMIT 7/)
	})

	it("escapes single quotes in the orgId", async () => {
		const exit = await run(
			Effect.gen(function* () {
				const svc = yield* RawSqlChartService
				return yield* svc.expandMacros({
					...baseInput,
					orgId: "org'); DROP TABLE Logs --",
					sql: "SELECT 1 FROM Logs WHERE $__orgFilter",
				})
			}),
		)
		expect(Exit.isSuccess(exit)).toBe(true)
		if (Exit.isSuccess(exit)) {
			expect(exit.value.sql).toContain("OrgId = 'org\\'); DROP TABLE Logs --'")
			// Crucially the masked deny-list scan now sees an empty literal, so the
			// DROP inside the literal does NOT trip the check.
		}
	})
})
