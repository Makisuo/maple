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

	// Same masking bug the org filter had: a macro in a comment expands to nothing,
	// so the alert would rescan all of history on every evaluation.
	it.each([
		"SELECT count() AS v FROM traces WHERE $__orgFilter -- $__timeFilter(Timestamp)",
		"SELECT count() AS v FROM traces WHERE $__orgFilter /* $__timeFilter(Timestamp) */",
		"SELECT count() AS v, '$__timeFilter(Timestamp)' AS x FROM traces WHERE $__orgFilter",
	])("rejects an alert whose $__timeFilter is not executable: %s", (sql) => {
		expect(rawSqlIssue(sql, { workload: "alert" })?.code).toBe("InvalidMacro")
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

	// `$__orgFilter` used to be checked with a raw `includes`, so a mention in a
	// comment satisfied the requirement while expanding to nothing — the tenant
	// predicate became opt-out for anyone who noticed.
	it.each([
		"SELECT 1 FROM traces WHERE 1=1 -- $__orgFilter",
		"SELECT 1 FROM traces /* $__orgFilter */ WHERE 1=1",
		"SELECT '$__orgFilter' AS x FROM traces",
	])("rejects $__orgFilter hidden from the query: %s", (sql) => {
		expect(rawSqlIssue(sql)?.code).toBe("MissingOrgFilter")
	})

	// Statement-shape checks say nothing about where a SELECT reads from, and a
	// table function makes the *server* fetch — per-org credentials never see it.
	it.each([
		"SELECT * FROM url('http://169.254.169.254/', JSONEachRow) WHERE $__orgFilter",
		"SELECT * FROM remote('10.0.0.1:9000', default.traces) WHERE $__orgFilter",
		"SELECT * FROM s3('https://x/y.parquet') WHERE $__orgFilter",
		"SELECT * FROM mysql('h:3306','d','t','u','p') WHERE $__orgFilter",
		"SELECT * FROM postgresql('h:5432','d','t','u','p') WHERE $__orgFilter",
		"SELECT * FROM file('/etc/passwd', LineAsString) WHERE $__orgFilter",
		// A subquery is the documented way past the org-filter requirement: the
		// outer query supplies OrgId while the inner one does the fetching.
		"SELECT OrgId FROM traces WHERE $__orgFilter AND SpanId IN (SELECT * FROM url('http://internal/'))",
		// Case and whitespace are not a bypass.
		"SELECT * FROM URL ('http://internal/') WHERE $__orgFilter",
		// Suffixed variants: an exact-name list matched `iceberg` but not
		// `icebergS3`, so every lake-format reader walked straight through.
		"SELECT * FROM icebergS3('https://x/y', 'k', 's') WHERE $__orgFilter",
		"SELECT * FROM icebergAzure('https://x/y') WHERE $__orgFilter",
		"SELECT * FROM deltaLakeS3('https://x/y') WHERE $__orgFilter",
		"SELECT * FROM deltaLakeAzure('https://x/y') WHERE $__orgFilter",
		"SELECT * FROM icebergS3Cluster('c', 'https://x/y') WHERE $__orgFilter",
		"SELECT * FROM s3Cluster('c', 'https://x/y.parquet') WHERE $__orgFilter",
		"SELECT * FROM executablePool('script', TSV, 'x UInt32') WHERE $__orgFilter",
	])("rejects network and filesystem table functions: %s", (sql) => {
		expect(rawSqlIssue(sql)?.code).toBe("DisallowedFunction")
	})

	// The check is anchored on the call form, so ordinary names survive.
	it.each([
		"SELECT urlHash(Url) AS h FROM traces WHERE $__orgFilter",
		"SELECT file FROM traces WHERE $__orgFilter",
		"SELECT domain(Url) AS d FROM traces WHERE $__orgFilter",
		"SELECT 'url(' AS literal FROM traces WHERE $__orgFilter",
		// Scalar functions sharing a prefix with a blocked name. These are why
		// `url`, `file` and `hive` are matched exactly rather than as prefixes.
		"SELECT URLHash(Url) AS h FROM traces WHERE $__orgFilter",
		"SELECT URLPathHierarchy(Url) AS p FROM traces WHERE $__orgFilter",
		"SELECT filesystemAvailable() AS free FROM traces WHERE $__orgFilter",
		"SELECT hiveHash(SpanName) AS h FROM traces WHERE $__orgFilter",
	])("does not mistake a column or unrelated function for a table function: %s", (sql) => {
		expect(rawSqlIssue(sql)).toBeNull()
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
