import { describe, expect, it } from "vitest"
import { migrations } from "@maple/domain/clickhouse"
import {
	CLICKHOUSE_MV_SOURCE_TABLES,
	qualifyStatementForDatabase,
} from "./OrgTinybirdSettingsService"

const latestSnapshotStatements = migrations.flatMap((m) => m.statements)

describe("qualifyStatementForDatabase", () => {
	it("returns the statement unchanged when database is empty", () => {
		const stmt = "CREATE TABLE traces (OrgId String) ENGINE = MergeTree ORDER BY OrgId"
		expect(qualifyStatementForDatabase(stmt, "")).toBe(stmt)
	})

	it("qualifies CREATE TABLE [IF NOT EXISTS] <name>", () => {
		const stmt = "CREATE TABLE IF NOT EXISTS traces (OrgId String) ENGINE = MergeTree"
		expect(qualifyStatementForDatabase(stmt, "mydb")).toBe(
			"CREATE TABLE IF NOT EXISTS `mydb`.`traces` (OrgId String) ENGINE = MergeTree",
		)
	})

	it("qualifies CREATE MATERIALIZED VIEW <view> TO <target>", () => {
		const stmt = "CREATE MATERIALIZED VIEW IF NOT EXISTS error_events_mv TO error_events AS SELECT 1"
		expect(qualifyStatementForDatabase(stmt, "mydb")).toBe(
			"CREATE MATERIALIZED VIEW IF NOT EXISTS `mydb`.`error_events_mv` TO `mydb`.`error_events` AS SELECT 1",
		)
	})

	it("qualifies bare `FROM <table>` for every known source datasource", () => {
		for (const table of CLICKHOUSE_MV_SOURCE_TABLES) {
			const stmt = `CREATE MATERIALIZED VIEW v TO t AS SELECT 1 FROM ${table}`
			expect(qualifyStatementForDatabase(stmt, "mydb")).toContain(`FROM \`mydb\`.\`${table}\``)
		}
	})

	it("does not match `arrayJoin` or other JOIN-prefix functions", () => {
		const stmt = "SELECT arrayJoin(mapKeys(LogAttributes)) FROM logs"
		const result = qualifyStatementForDatabase(stmt, "mydb")
		// `arrayJoin` should remain untouched (no qualification on `Join`)
		expect(result).toContain("arrayJoin(mapKeys(LogAttributes))")
		// `FROM logs` should be qualified
		expect(result).toContain("FROM `mydb`.`logs`")
	})

	it("does not double-qualify already-qualified references", () => {
		const stmt = "CREATE TABLE `mydb`.`traces` (OrgId String) ENGINE = MergeTree"
		// Already-qualified \`mydb\`.\`traces\` should NOT match the regex (which requires
		// a bare identifier after CREATE TABLE).
		expect(qualifyStatementForDatabase(stmt, "mydb")).toBe(stmt)
	})

	it("qualifies every CREATE statement in the generated snapshot", () => {
		// Sanity: every statement in the snapshot is either CREATE TABLE or
		// CREATE MATERIALIZED VIEW, and after qualification each one carries the
		// database prefix on the identifier immediately after the keywords.
		for (const stmt of latestSnapshotStatements) {
			const qualified = qualifyStatementForDatabase(stmt, "customer_db")

			if (stmt.startsWith("CREATE TABLE")) {
				expect(qualified).toMatch(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?`customer_db`\.`\w+`/)
			} else if (stmt.startsWith("CREATE MATERIALIZED VIEW")) {
				expect(qualified).toMatch(
					/^CREATE MATERIALIZED VIEW\s+(?:IF NOT EXISTS\s+)?`customer_db`\.`\w+`\s+TO\s+`customer_db`\.`\w+`/,
				)
			} else {
				throw new Error(`Unexpected statement shape: ${stmt.split("\n")[0]}`)
			}
		}
	})

	it("qualifies all FROM/JOIN source-table references in the generated MV statements", () => {
		const mvStatements = latestSnapshotStatements.filter((s) =>
			s.startsWith("CREATE MATERIALIZED VIEW"),
		)

		for (const stmt of mvStatements) {
			const qualified = qualifyStatementForDatabase(stmt, "customer_db")
			// Find any bare `FROM <known_source>` or `JOIN <known_source>` in the
			// qualified output — there should be none. (Intentional negative match.)
			for (const table of CLICKHOUSE_MV_SOURCE_TABLES) {
				expect(qualified).not.toMatch(new RegExp(`\\b(?:FROM|JOIN)\\s+${table}\\b`))
			}
		}
	})
})
