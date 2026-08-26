import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { isValidRawSql, RawSqlText, rawSqlIssue } from "./raw-sql"

const ok = "SELECT count() FROM logs WHERE $__orgFilter AND $__timeFilter(Timestamp)"

describe("rawSqlIssue", () => {
	it("accepts a well-formed query", () => {
		expect(rawSqlIssue(ok)).toBeNull()
		expect(rawSqlIssue(ok, { workload: "alert" })).toBeNull()
	})

	it("requires $__orgFilter", () => {
		expect(rawSqlIssue("SELECT 1 FROM logs")?.code).toBe("MissingOrgFilter")
	})

	it("requires $__timeFilter for alerts only", () => {
		const sql = "SELECT count() FROM logs WHERE $__orgFilter"
		expect(rawSqlIssue(sql)).toBeNull()
		expect(rawSqlIssue(sql, { workload: "alert" })?.code).toBe("InvalidMacro")
	})

	it("rejects an empty or oversized query", () => {
		expect(rawSqlIssue("")?.code).toBe("ResourceLimit")
		expect(rawSqlIssue(`SELECT '${"x".repeat(32_768)}' WHERE $__orgFilter`)?.code).toBe("ResourceLimit")
	})

	it("rejects a non-identifier macro argument", () => {
		const issue = rawSqlIssue("SELECT 1 WHERE $__orgFilter AND $__timeFilter(toDate(t))")
		expect(issue?.code).toBe("InvalidMacro")
		expect(issue?.message).toContain("column identifier")
	})

	it("rejects an unknown macro", () => {
		expect(rawSqlIssue("SELECT $__nope WHERE $__orgFilter")?.code).toBe("UnresolvedMacro")
	})

	it("rejects multiple statements but tolerates one trailing terminator", () => {
		expect(rawSqlIssue("SELECT 1 WHERE $__orgFilter; SELECT 2")?.code).toBe("MultipleStatements")
		expect(rawSqlIssue("SELECT 1 WHERE $__orgFilter;")).toBeNull()
	})

	it("ignores semicolons inside strings and comments", () => {
		expect(rawSqlIssue("SELECT ';' WHERE $__orgFilter -- ; here")).toBeNull()
	})

	it("rejects deny-listed statement keywords", () => {
		for (const keyword of ["INSERT", "DROP", "ALTER", "SYSTEM", "KILL"]) {
			expect(rawSqlIssue(`${keyword} something WHERE $__orgFilter`)?.code).toBe("DisallowedStatement")
		}
	})

	it("rejects INTO OUTFILE", () => {
		expect(rawSqlIssue("SELECT 1 WHERE $__orgFilter INTO OUTFILE '/tmp/x'")?.message).toContain(
			"INTO OUTFILE",
		)
	})

	it("rejects a non-SELECT query", () => {
		expect(rawSqlIssue("EXPLAIN SELECT 1 WHERE $__orgFilter")?.code).toBe("DisallowedStatement")
	})

	it("accepts a leading WITH", () => {
		expect(rawSqlIssue("WITH x AS (SELECT 1) SELECT * FROM x WHERE $__orgFilter")).toBeNull()
	})

	it("rejects an author-supplied SETTINGS clause", () => {
		const issue = rawSqlIssue("SELECT 1 WHERE $__orgFilter SETTINGS max_execution_time=3000")
		expect(issue?.code).toBe("DisallowedStatement")
		expect(issue?.message).toContain("SETTINGS is managed by Maple")
	})

	it("accepts a trailing FORMAT — the driver owns the wire format", () => {
		expect(rawSqlIssue("SELECT 1 WHERE $__orgFilter FORMAT JSONEachRow")).toBeNull()
	})

	it("does not mistake a column named settings or format for a clause", () => {
		expect(rawSqlIssue("SELECT settings, format FROM t WHERE $__orgFilter")).toBeNull()
	})
})

describe("isValidRawSql", () => {
	it("mirrors rawSqlIssue", () => {
		expect(isValidRawSql(ok)).toBe(true)
		expect(isValidRawSql("SELECT 1")).toBe(false)
		expect(isValidRawSql("SELECT count() FROM logs WHERE $__orgFilter", "alert")).toBe(false)
	})
})

describe("RawSqlText", () => {
	const decode = Schema.decodeUnknownSync(RawSqlText)

	it("accepts a valid query", () => {
		expect(decode(ok)).toBe(ok)
	})

	it("surfaces the validator's own message", () => {
		expect(() => decode("SELECT 1")).toThrow(/\$__orgFilter/)
		expect(() => decode("SELECT 1 WHERE $__orgFilter SETTINGS max_threads=8")).toThrow(
			/SETTINGS is managed by Maple/,
		)
	})
})
