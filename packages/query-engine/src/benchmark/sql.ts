import { Effect } from "effect"
import { maskLiteralsAndComments, parseStatement, renderStatement } from "@maple-dev/clickhouse-builder/sql"
import { BenchmarkError } from "./model"

const withoutTrailingTerminator = (sql: string): string => {
	const match = /;\s*$/.exec(maskLiteralsAndComments(sql))
	return match ? sql.slice(0, match.index) + sql.slice(match.index + 1) : sql
}

/** Guard mistakes in local replay files; server-side readonly is also mandatory.
 * This is deliberately not a security parser for arbitrary untrusted SQL. */
export const validateReplaySql = (sql: string) => {
	const masked = maskLiteralsAndComments(sql).trim().replace(/;\s*$/, "")
	return !/^(SELECT|WITH)\b/i.test(masked) || masked.includes(";") || /\bINTO\s+OUTFILE\b/i.test(masked)
		? Effect.fail(
				new BenchmarkError({ message: "Benchmark cases must be single SELECT/WITH statements." }),
			)
		: Effect.succeed(sql)
}

/** Existing settings are preserved, with experiment controls last. */
export const benchmarkSql = (
	sql: string,
	settings: Readonly<Record<string, string>>,
	format?: string,
): string => {
	const statement = parseStatement(withoutTrailingTerminator(sql))
	const overrides = Object.entries(settings).map(([key, value]) => `${key}=${value}`)
	const existing = statement.settings?.replace(/^SETTINGS\s+/i, "")
	return renderStatement({
		body: statement.body,
		settings: [existing, ...overrides].filter(Boolean).length
			? `SETTINGS ${[existing, ...overrides].filter(Boolean).join("\n, ")}`
			: undefined,
		format: format ? `FORMAT ${format}` : statement.format,
	})
}

export const explainSql = (sql: string, kind: "indexes" | "pipeline") => {
	const statement = parseStatement(withoutTrailingTerminator(sql))
	const base = benchmarkSql(
		renderStatement({ body: statement.body, settings: statement.settings }),
		kind === "indexes" ? { use_query_condition_cache: "0", use_skip_indexes_on_data_read: "0" } : {},
		"TabSeparatedRaw",
	)
	return `${kind === "indexes" ? "EXPLAIN indexes = 1, projections = 1" : "EXPLAIN PIPELINE"}\n${base}`
}
