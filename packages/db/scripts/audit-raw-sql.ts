/**
 * Report every stored raw query the shared validator would now reject.
 *
 * Read-only. Point it at a stage's Postgres and it walks `alert_rules` and the
 * `dashboards` payload documents, running the same `rawSqlIssue` the API runs,
 * and prints what would fail — so tightening raw-SQL validation is a decision
 * made against real data rather than a hope.
 *
 *   bun run scripts/audit-raw-sql.ts [branch]     # mints an ephemeral PS credential
 *   DATABASE_URL=postgres://… bun run scripts/audit-raw-sql.ts
 *   … --json                                      # machine-readable
 *
 * Exits non-zero when anything would be rejected, so CI can gate on it.
 */
import postgres from "postgres"
import { rawSqlIssue, type RawSqlIssue } from "@maple/domain/raw-sql"
import { dataSourceRawSql } from "@maple/widgets/dashboard"
import { withBranchConnection } from "./planetscale-connection"

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
 * Reads each candidate through `dataSourceRawSql` — the same accessor the render
 * path uses — rather than matching a shape here, so the audit cannot drift from
 * what actually gets executed. Stored documents are v3 (`{ kind: "raw_sql" }`);
 * the accessor also reads the pre-v3 `{ endpoint: "raw_sql_chart", params }`
 * form, which covers any row that predates the v3 backfill.
 */
export interface FoundRawSql {
	readonly widgetId: string
	readonly sql: string
	/**
	 * Which of the two accepted forms carries the SQL. `route` is the pre-v3
	 * `{ endpoint: "raw_sql_chart", params: { sql } }`, still a valid v3 storage
	 * shape and still accepted by `/v2/dashboards`. Reported for every raw-SQL
	 * source, valid or not, because "does anything actually use it?" is what
	 * decides whether that door can be closed — and closing it is only safe if
	 * nothing has come through.
	 */
	readonly sourceForm: "kind" | "route"
}

export const rawSqlWidgets = (payload: unknown): Array<FoundRawSql> => {
	const found: Array<FoundRawSql> = []
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
			found.push({
				widgetId: id,
				sql: rawSql.sql,
				sourceForm: record.kind === "raw_sql" ? "kind" : "route",
			})
			return
		}
		for (const value of Object.values(record)) walk(value, id)
	}
	walk(payload, "<unknown>")
	return found
}

const audit = async (databaseUrl: string, asJson: boolean): Promise<number> => {
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
		const sourceFormCounts = { kind: 0, route: 0 }
		for (const dashboard of dashboards) {
			for (const widget of rawSqlWidgets(dashboard.payload_json)) {
				sourceFormCounts[widget.sourceForm] += 1
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

		// Printed whether or not anything failed, because it answers a second
		// question: whether `/v2/dashboards` can stop accepting the route form.
		// Closing that door is only safe if nothing has come through it.
		const sourceFormLine = `raw-SQL widgets by source form: ${sourceFormCounts.kind} kind:"raw_sql", ${sourceFormCounts.route} route:"raw_sql_chart"`

		if (asJson) {
			console.log(
				JSON.stringify({ findings, total: findings.length, sourceForms: sourceFormCounts }, null, 2),
			)
		} else if (findings.length === 0) {
			console.log(
				`No stored raw SQL would be rejected (${rules.length} alert rules, ${dashboards.length} dashboards scanned).`,
			)
			console.log(sourceFormLine)
		} else {
			console.log(`${sourceFormLine}\n`)
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

	return findings.length
}

/**
 * `DATABASE_URL` when one is supplied; otherwise the same ephemeral-credential
 * broker the other PlanetScale scripts use, so running the audit needs no
 * credential handling of its own — `pscale` mints one and revokes it after.
 */
const main = async (): Promise<void> => {
	const asJson = process.argv.includes("--json")
	const branch = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "main"
	const databaseUrl = process.env.DATABASE_URL

	let rejected = 0
	if (databaseUrl !== undefined && databaseUrl !== "") {
		rejected = await audit(databaseUrl, asJson)
	} else {
		await withBranchConnection(branch, async (connectionUrl) => {
			rejected = await audit(connectionUrl, asJson)
		})
	}
	process.exit(rejected === 0 ? 0 : 1)
}

// Importable for tests; only the direct invocation touches a database.
if (import.meta.main) await main()
