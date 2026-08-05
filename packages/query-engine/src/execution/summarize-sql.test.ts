import { DB_QUERY_LABEL_SQL } from "@maple/domain/tinybird/db-query-shape-sql"
import { describe, expect, it } from "vitest"
import { SQL_TABLE_RE, SQL_VERB_RE, summarizeSql } from "./fingerprint"

/**
 * Statements pulled verbatim from production `Database.execute` spans
 * (`db.query.text`, 2026-08-03). These are what the Postgres client span will
 * actually summarize, so they are the corpus that matters.
 */
const PRODUCTION_STATEMENTS: ReadonlyArray<readonly [sql: string, summary: string]> = [
	[
		`update "alert_rule_states" set "last_error" = $1, "updated_at" = $2 where ("alert_rule_states"."org_id" = $3)`,
		"UPDATE alert_rule_states",
	],
	[
		`select "org_id", "enabled", "max_runs_per_day" from "ai_triage_settings" where "ai_triage_settings"."org_id" = $1 limit $2`,
		"SELECT ai_triage_settings",
	],
	[
		`delete from "alert_rule_states" where ("alert_rule_states"."org_id" = $1 and "alert_rule_states"."rule_id" = $2)`,
		"DELETE alert_rule_states",
	],
	[
		`insert into "error_incidents" ("id", "org_id", "issue_id") values ($1, $2, $3)`,
		"INSERT error_incidents",
	],
	[
		`insert into "alert_rule_claims" ("rule_id", "org_id") values ($1, $2) on conflict ("rule_id") do update set "last_scheduled_at" = $3`,
		"INSERT alert_rule_claims",
	],
	// A join picks the FROM table, not the joined one — the first clause wins.
	[
		`select distinct "alert_incidents"."rule_id" from "alert_incidents" inner join "alert_rules" on "alert_incidents"."rule_id" = "alert_rules"."id"`,
		"SELECT alert_incidents",
	],
	[`select distinct "org_id" from "org_ingest_keys"`, "SELECT org_ingest_keys"],
	// selectDistinctOrgIds' loose index scan: the leading verb is WITH.
	[
		`\n\t\twith recursive t as (\n\t\t\t(\n\t\t\t\tselect "error_issues"."org_id" as org_id\n\t\t\t\tfrom "error_issues"\n\t\t\t)\n\t\t)`,
		"WITH error_issues",
	],
	// A transaction lands as several statements joined by ";\n"; the first wins.
	[`begin;\nupdate "error_issues" set "error_label" = $1;\ncommit`, "BEGIN error_issues"],
]

describe("summarizeSql", () => {
	it.each(PRODUCTION_STATEMENTS)("summarizes %#", (sql, summary) => {
		expect(summarizeSql(sql).summary).toBe(summary)
	})

	it("splits the summary into its OTEL parts", () => {
		expect(summarizeSql(`select "id" from "actors" where "actors"."org_id" = $1`)).toEqual({
			operation: "SELECT",
			collection: "actors",
			summary: "SELECT actors",
		})
	})

	it("omits the collection when no table clause is present", () => {
		expect(summarizeSql("commit")).toEqual({
			operation: "COMMIT",
			collection: "",
			summary: "COMMIT",
		})
	})

	it("returns empty parts for empty SQL", () => {
		expect(summarizeSql("")).toEqual({ operation: "", collection: "", summary: "" })
	})

	it("does not mistake a column ending in `from` for a FROM clause", () => {
		// `"copied_from"` is followed by `"`, not whitespace — the read-side regex
		// requires `\s+` after the keyword, and so must this one.
		expect(summarizeSql(`select "copied_from", "id" from "actors"`).collection).toBe("actors")
	})
})

/**
 * The read side derives this same label from raw statement text when
 * `db.query.summary` is absent (precedence 3 of `DB_QUERY_LABEL_SQL`), and
 * prefers the emitted summary (precedence 1) once we start sending it. If the
 * two derivations drift, every existing shape in
 * `service_map_db_query_shapes_hourly` forks into a duplicate at the cutover —
 * so pin the patterns to the ones embedded in the ClickHouse fragment.
 */
describe("summarizeSql / ClickHouse parity", () => {
	/** A JS regex source as it appears inside a ClickHouse string literal (CH halves `\\` for RE2). */
	const asClickHouseLiteral = (re: RegExp) => re.source.replaceAll("\\", "\\\\")

	it("uses the same verb pattern as derivedStatementSummarySql", () => {
		expect(DB_QUERY_LABEL_SQL).toContain(asClickHouseLiteral(SQL_VERB_RE))
	})

	it("uses the same table pattern as derivedStatementSummarySql", () => {
		expect(DB_QUERY_LABEL_SQL).toContain(`(?i)${asClickHouseLiteral(SQL_TABLE_RE)}`)
	})
})
