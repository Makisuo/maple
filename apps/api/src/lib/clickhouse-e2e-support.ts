// ---------------------------------------------------------------------------
// Shared plumbing for the ClickHouse-backed e2e tests.
//
// Both suites need the same three things: connection settings from the CI job's
// env, a raw HTTP exec, and a database with every migration replayed into it.
// Gated on `CLICKHOUSE_E2E=1` so a plain `bun run test` never reaches for a
// server that isn't running.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process"

export const clickhouseE2eEnabled = process.env.CLICKHOUSE_E2E === "1"
export const clickhouseUrl = process.env.CLICKHOUSE_E2E_URL ?? "http://127.0.0.1:8123"
export const clickhouseUser = process.env.CLICKHOUSE_E2E_USER ?? "maple"
export const clickhousePassword = process.env.CLICKHOUSE_E2E_PASSWORD ?? "maple"

const repoRoot = new URL("../../../..", import.meta.url).pathname

/** Unique per suite so parallel test files never share (or drop) a database. */
export const uniqueDatabase = (prefix: string): string =>
	`${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

export const clickhouseExec = async (
	sql: string,
	targetDatabase = "default",
	settings: Record<string, string> = {},
): Promise<string> => {
	const query = new URLSearchParams({ database: targetDatabase, ...settings })
	const response = await fetch(`${clickhouseUrl.replace(/\/$/, "")}/?${query.toString()}`, {
		method: "POST",
		redirect: "manual",
		headers: {
			"Content-Type": "text/plain",
			"X-ClickHouse-User": clickhouseUser,
			"X-ClickHouse-Key": clickhousePassword,
			"X-ClickHouse-Database": targetDatabase,
		},
		body: sql,
	})
	const body = await response.text()
	if (!response.ok) throw new Error(`ClickHouse ${response.status}: ${body.slice(0, 500)}`)
	return body
}

/**
 * Replay the real migration set through the shipped CLI rather than a test-only
 * DDL copy — the point is to validate against the schema customers get.
 */
export const applyRealMigrations = async (database: string): Promise<void> => {
	const child = spawn(
		"bun",
		[
			"run",
			"--cwd",
			"packages/clickhouse-cli",
			"start",
			"apply",
			`--url=${clickhouseUrl}`,
			`--user=${clickhouseUser}`,
			`--password=${clickhousePassword}`,
			`--database=${database}`,
		],
		{ cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
	)
	let stdout = ""
	let stderr = ""
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk
	})
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk
	})
	const exitCode = await new Promise<number>((resolve, reject) => {
		child.once("error", reject)
		child.once("close", (code) => resolve(code ?? 1))
	})
	if (exitCode !== 0) throw new Error(`Migration CLI failed (${exitCode}): ${stderr || stdout}`)
}

export interface DescribedColumn {
	readonly name: string
	readonly type: string
}

/**
 * Settings that make a modern local/CI ClickHouse type-check as strictly as the
 * warehouse we actually run on.
 *
 * This is load-bearing, and it is not a nicety. Managed Tinybird is ClickHouse
 * **24.12** with `use_variant_as_common_type = 0`, so a `Float64`/`UInt64`
 * mismatch is a hard `NO_COMMON_TYPE`. ClickHouse 26.2 — what the CI service
 * container and `docker-compose.development.yml` run — defaults that setting ON
 * and quietly resolves the same expression to `Variant(Float64, UInt64)`.
 *
 * Without this pin the sweep passes on the exact expression that took prod down,
 * which was measured, not assumed: reverting the fix left all 82 shapes green
 * until the setting was applied.
 */
export const ANALYZER_STRICTNESS: Record<string, string> = {
	use_variant_as_common_type: "0",
}

/**
 * Run a query through ClickHouse's analyzer without reading a row.
 *
 * `DESCRIBE (SELECT …)` type-checks the whole query — it is what surfaces
 * `NO_COMMON_TYPE`, `ILLEGAL_TYPE_OF_ARGUMENT` and unknown identifiers — and
 * returns each output column's resolved type, which is the only way to tell from
 * the outside that a column arrives as a 64-bit integer.
 */
export const describeQuery = async (
	sql: string,
	database: string,
): Promise<ReadonlyArray<DescribedColumn>> => {
	const body = await clickhouseExec(
		`DESCRIBE (\n${sql}\n) FORMAT TabSeparated`,
		database,
		ANALYZER_STRICTNESS,
	)
	return body
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			const [name, type] = line.split("\t")
			return { name: name ?? "", type: type ?? "" }
		})
}

/**
 * ClickHouse's `FORMAT JSON` renders 64-bit integers as JSON *strings* so they
 * survive the round trip intact. Managed Tinybird hands back numbers, so a query
 * whose row schema uses a bare `Schema.Number` works there and 500s for every
 * BYO-ClickHouse org. `CH.CHNumber` accepts both.
 */
export const isSixtyFourBitInt = (type: string): boolean => /\b(?:U?Int64|U?Int128|U?Int256)\b/.test(type)

/** A row shaped like `FORMAT JSON` output for the described columns. */
export const syntheticRow = (columns: ReadonlyArray<DescribedColumn>): Record<string, unknown> => {
	const row: Record<string, unknown> = {}
	for (const column of columns) {
		row[column.name] = sampleValue(column.type)
	}
	return row
}

const sampleValue = (type: string): unknown => {
	const inner = type.replace(/^(?:Nullable|LowCardinality)\((.*)\)$/, "$1")
	if (inner.startsWith("Array(")) return []
	if (inner.startsWith("Map(")) return {}
	if (inner.startsWith("Tuple(")) return []
	// The whole point: 64-bit ints come over the wire quoted.
	if (isSixtyFourBitInt(inner)) return "1"
	if (/^(?:U?Int|Float|Decimal|Bool)/.test(inner)) return 1
	if (/^(?:Date|DateTime)/.test(inner)) return "2026-01-01 00:00:00"
	return ""
}
