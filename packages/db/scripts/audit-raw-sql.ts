/**
 * Report every stored raw query the shared validator would now reject.
 *
 * Read-only. Point it at a stage's Postgres and it walks `alert_rules` and the
 * `dashboards` payload documents, running the same `rawSqlIssue` the API runs,
 * and prints what would fail — so tightening raw-SQL validation is a decision
 * made against real data rather than a hope.
 *
 *   DATABASE_URL=postgres://… bun run scripts/audit-raw-sql.ts
 *   DATABASE_URL=… bun run scripts/audit-raw-sql.ts --json
 *
 * Exits non-zero when anything would be rejected, so CI can gate on it.
 */
import postgres from "postgres"
import { rawSqlIssue, type RawSqlIssue } from "@maple/domain/raw-sql"
import { dataSourceRawSql } from "@maple/widgets/dashboard"

export interface Finding {
	readonly source: "alert_rule" | "dashboard_widget"
	readonly orgId: string
	readonly id: string
	readonly label: string
	readonly issue: RawSqlIssue
	readonly sql: string
}

/**
 * Every raw-SQL data source in a stored dashboard document.
 *
 * Reads each candidate through `dataSourceRawSql` rather than matching a shape
 * here: stored documents carry BOTH the v3 `{ kind: "raw_sql", sql }` and the
 * legacy v2 `{ endpoint: "raw_sql_chart", params: { sql } }`, and a walker that
 * knows only the current one reports "all clear" over a pile of legacy widgets.
 */
export const rawSqlWidgets = (payload: unknown): Array<{ widgetId: string; sql: string }> => {
	const found: Array<{ widgetId: string; sql: string }> = []
	const walk = (node: unknown, widgetId: string): void => {
		if (Array.isArray(node)) {
			for (const child of node) walk(child, widgetId)
			return
		}
		if (node === null || typeof node !== "object") return
		const record = node as Record<string, unknown>
		const id = typeof record.id === "string" ? record.id : widgetId
		const rawSql = dataSourceRawSql(record)
		if (rawSql !== null && rawSql.sql !== "") {
			found.push({ widgetId: id, sql: rawSql.sql })
			return
		}
		for (const value of Object.values(record)) walk(value, id)
	}
	walk(payload, "<unknown>")
	return found
}

const main = async (): Promise<void> => {
	const databaseUrl = process.env.DATABASE_URL
	if (databaseUrl === undefined || databaseUrl === "") {
		console.error("DATABASE_URL is required (a direct 5432 connection, not a pooler).")
		process.exit(2)
	}
	const asJson = process.argv.includes("--json")

	const sql = postgres(databaseUrl, { max: 1, connect_timeout: 15, prepare: false })
	const findings: Array<Finding> = []

	try {
		const rules = await sql<Array<{ org_id: string; id: string; name: string; raw_query_sql: string }>>`
			SELECT org_id, id, name, raw_query_sql
			FROM alert_rules
			WHERE raw_query_sql IS NOT NULL AND raw_query_sql <> ''
		`
		for (const rule of rules) {
			// Alert rules are the workload with the extra $__timeFilter requirement.
			const issue = rawSqlIssue(rule.raw_query_sql, { workload: "alert" })
			if (issue !== null) {
				findings.push({
					source: "alert_rule",
					orgId: rule.org_id,
					id: rule.id,
					label: rule.name,
					issue,
					sql: rule.raw_query_sql,
				})
			}
		}

		const dashboards = await sql<
			Array<{ org_id: string; id: string; name: string; payload_json: unknown }>
		>`
			SELECT org_id, id, name, payload_json FROM dashboards
		`
		for (const dashboard of dashboards) {
			for (const widget of rawSqlWidgets(dashboard.payload_json)) {
				const issue = rawSqlIssue(widget.sql)
				if (issue !== null) {
					findings.push({
						source: "dashboard_widget",
						orgId: dashboard.org_id,
						id: `${dashboard.id}#${widget.widgetId}`,
						label: dashboard.name,
						issue,
						sql: widget.sql,
					})
				}
			}
		}

		if (asJson) {
			console.log(JSON.stringify({ findings, total: findings.length }, null, 2))
		} else if (findings.length === 0) {
			console.log(
				`No stored raw SQL would be rejected (${rules.length} alert rules, ${dashboards.length} dashboards scanned).`,
			)
		} else {
			console.log(
				`${findings.length} stored raw ${findings.length === 1 ? "query" : "queries"} would be rejected:\n`,
			)
			for (const finding of findings) {
				console.log(`  [${finding.issue.code}] ${finding.source} ${finding.id}`)
				console.log(`    org:   ${finding.orgId}`)
				console.log(`    name:  ${finding.label}`)
				console.log(`    why:   ${finding.issue.message}`)
				console.log(`    sql:   ${finding.sql.replace(/\s+/g, " ").slice(0, 160)}`)
				console.log("")
			}
			const byCode = new Map<string, number>()
			for (const finding of findings)
				byCode.set(finding.issue.code, (byCode.get(finding.issue.code) ?? 0) + 1)
			console.log("By reason:")
			for (const [code, count] of [...byCode].sort((a, b) => b[1] - a[1])) {
				console.log(`  ${count}× ${code}`)
			}
		}
	} finally {
		await sql.end()
	}

	process.exit(findings.length === 0 ? 0 : 1)
}

// Importable for tests; only the direct invocation touches a database.
if (import.meta.main) await main()
