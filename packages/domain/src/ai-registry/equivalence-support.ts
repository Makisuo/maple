// Plumbing shared by the Rust↔SQL equivalence e2e legs.
//
// The suites here replay rows that `apps/ingest` actually wrote — captured by its
// fixture generator (`apps/ingest/src/ai_equivalence_fixtures.rs`) — into a real
// ClickHouse, then evaluate the SQL compiled from `registry.json` over them. Three
// things have to be faithful for that to prove anything:
//
//  1. **The schema is the real one.** Migrations are replayed through the shipped
//     `packages/clickhouse-cli`, not a test-local DDL copy, so the suite sees the
//     column set customers get (including `AiVendor`/`AiSessionKeyState`, which the
//     compiled SQL is compared against).
//  2. **The INSERT is the real one.** The statement is rebuilt from
//     `apps/cli/src/server/schema/local-inserts.json` — the checked-in artifact
//     `scripts/generate-clickhouse-insert-mappings.ts` emits alongside
//     `apps/ingest/src/clickhouse_insert_mappings.rs`, from the same Tinybird manifest.
//     Reading the JSON rather than the Rust constant means both sides are pinned to one
//     generator, and it is the only form a TypeScript test can consume. The query
//     parameters mirror `TelemetryPipeline`'s ClickHouse export
//     (`date_time_input_format=best_effort`, `input_format_skip_unknown_fields=1`).
//  3. **The row bytes are the real ones.** Fixture records carry the writer's NDJSON
//     line verbatim as a string, replayed unmodified. Re-serialising a parsed row would
//     corrupt `ai_session_key_hash` (a UInt64 above 2^53) on the way through
//     `JSON.parse`.
//
// This file deliberately does not import `apps/api`'s ClickHouse harness: a package may
// not depend on a deployable. The migration spawn is the same shape, kept in sync by
// hand — it is twenty lines and changing rarely.

import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const clickhouseE2eEnabled = process.env.CLICKHOUSE_E2E === "1"
export const clickhouseUrl = process.env.CLICKHOUSE_E2E_URL ?? "http://127.0.0.1:8123"
export const clickhouseUser = process.env.CLICKHOUSE_E2E_USER ?? "maple"
export const clickhousePassword = process.env.CLICKHOUSE_E2E_PASSWORD ?? "maple"

/**
 * Managed Tinybird is ClickHouse 24.12 with `use_variant_as_common_type = 0`, where a
 * type mismatch between `multiIf` branches is a hard error; modern servers default it on
 * and quietly resolve the same expression to a `Variant`. Pinned for the same reason the
 * apps/api harness pins it.
 */
export const ANALYZER_STRICTNESS: Readonly<Record<string, string>> = {
	use_variant_as_common_type: "0",
}

/** Walk up to the workspace root rather than counting `../` segments. */
const findRepoRoot = (): string => {
	let dir = dirname(fileURLToPath(import.meta.url))
	while (!existsSync(join(dir, "turbo.json"))) {
		const parent = dirname(dir)
		if (parent === dir)
			throw new Error("Could not locate the workspace root: no turbo.json above this file")
		dir = parent
	}
	return dir
}

const repoRoot = findRepoRoot()

export const uniqueDatabase = (prefix: string): string =>
	`${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

const endpoint = (targetDatabase: string, settings: Readonly<Record<string, string>>): string => {
	const query = new URLSearchParams({ database: targetDatabase, ...settings })
	return `${clickhouseUrl.replace(/\/$/, "")}/?${query.toString()}`
}

const clickhouseHeaders = (targetDatabase: string): Readonly<Record<string, string>> => ({
	"X-ClickHouse-User": clickhouseUser,
	"X-ClickHouse-Key": clickhousePassword,
	"X-ClickHouse-Database": targetDatabase,
})

export const clickhouseExec = async (
	sql: string,
	targetDatabase = "default",
	settings: Readonly<Record<string, string>> = {},
): Promise<string> => {
	const response = await fetch(endpoint(targetDatabase, settings), {
		method: "POST",
		redirect: "manual",
		headers: { "Content-Type": "text/plain", ...clickhouseHeaders(targetDatabase) },
		body: sql,
	})
	const body = await response.text()
	if (!response.ok) throw new Error(`ClickHouse ${response.status}: ${body.slice(0, 1500)}`)
	return body
}

/** `SELECT … FORMAT JSONEachRow` into typed rows. */
export const clickhouseSelect = async <A>(
	sql: string,
	targetDatabase: string,
	settings: Readonly<Record<string, string>> = ANALYZER_STRICTNESS,
): Promise<ReadonlyArray<A>> => {
	const body = await clickhouseExec(`${sql}\nFORMAT JSONEachRow`, targetDatabase, settings)
	return body
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as A)
}

export const createDatabase = async (database: string): Promise<void> => {
	await clickhouseExec(`CREATE DATABASE ${database}`)
}

export const dropDatabase = async (database: string): Promise<void> => {
	await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
}

/** Replay the real migration set through the shipped CLI. */
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

/**
 * Drop `traces`' 30-day TTL in the ephemeral test database.
 *
 * Not a nicety: ClickHouse evaluates row TTL **at insert time** for a new part, so every
 * fixture row lands and is dropped in the same request — `INSERT` returns 200 and
 * `count()` returns 0, which is how this was found. Both replay corpora are historical by
 * construction (the synthetic fixture pins a fixed 2023 timestamp so regeneration is
 * byte-stable; the capture corpus is a recorded artifact), and retention has nothing to do
 * with the classification algebra under test. The migration itself is untouched.
 */
export const dropTracesRetentionTtl = async (database: string): Promise<void> => {
	await clickhouseExec("ALTER TABLE traces REMOVE TTL", database)
}

// ---------------------------------------------------------------------------
// the generated insert mapping
// ---------------------------------------------------------------------------

interface DatasourceInsertMapping {
	readonly table: string
	readonly columns: ReadonlyArray<string>
	readonly selects: ReadonlyArray<string>
	readonly inputSchema: string
}

interface LocalInsertsDocument {
	readonly orgPlaceholder: string
	readonly datasources: Readonly<Record<string, DatasourceInsertMapping>>
}

const localInsertsPath = join(repoRoot, "apps/cli/src/server/schema/local-inserts.json")

const readLocalInserts = (): LocalInsertsDocument => {
	const parsed: unknown = JSON.parse(readFileSync(localInsertsPath, "utf8"))
	if (typeof parsed !== "object" || parsed === null) throw new Error(`${localInsertsPath} is not an object`)
	const document = parsed as LocalInsertsDocument
	if (typeof document.orgPlaceholder !== "string" || typeof document.datasources !== "object")
		throw new Error(`${localInsertsPath} is missing orgPlaceholder/datasources`)
	return document
}

/** Backslash first, or the quote escape is re-escaped — the Rust writer's rule. */
const escapeSqlLiteral = (value: string): string => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")

/**
 * The exact INSERT statement `build_clickhouse_insert_sql` produces for `traces`:
 * column list, `SELECT` list with the org placeholder replaced by a quoted literal, and
 * `input(<schema>)` over `FORMAT JSONEachRow` data.
 */
export const buildTracesInsertSql = (orgId: string): string => {
	const document = readLocalInserts()
	const mapping = document.datasources.traces
	if (mapping === undefined) throw new Error(`${localInsertsPath} has no traces datasource`)
	const orgLiteral = `'${escapeSqlLiteral(orgId)}'`
	const selects = mapping.selects
		.map((select) => (select === document.orgPlaceholder ? orgLiteral : select))
		.join(", ")
	return `INSERT INTO ${mapping.table} (${mapping.columns.join(", ")}) SELECT ${selects} FROM input('${escapeSqlLiteral(mapping.inputSchema)}') FORMAT JSONEachRow`
}

/** The export settings `TelemetryPipeline` sends with every ClickHouse insert. */
const INGEST_INSERT_SETTINGS: Readonly<Record<string, string>> = {
	input_format_skip_unknown_fields: "1",
	date_time_input_format: "best_effort",
}

/**
 * Replay NDJSON rows through the ingest INSERT shape. Rows are written verbatim; batches
 * keep any single request under a few MB, because the corpus contains multi-megabyte
 * spans.
 */
export const insertTracesRows = async (
	database: string,
	orgId: string,
	rows: ReadonlyArray<string>,
	batchBytes = 4 * 1024 * 1024,
	extraSettings: Readonly<Record<string, string>> = {},
): Promise<number> => {
	const sql = buildTracesInsertSql(orgId)
	const url = endpoint(database, { ...INGEST_INSERT_SETTINGS, ...extraSettings, query: sql })
	let batch: string[] = []
	let batchSize = 0
	let inserted = 0

	const flush = async (): Promise<void> => {
		if (batch.length === 0) return
		const response = await fetch(url, {
			method: "POST",
			redirect: "manual",
			headers: { "Content-Type": "application/x-ndjson", ...clickhouseHeaders(database) },
			body: `${batch.join("\n")}\n`,
		})
		const body = await response.text()
		if (!response.ok) throw new Error(`ClickHouse insert ${response.status}: ${body.slice(0, 1500)}`)
		inserted += batch.length
		batch = []
		batchSize = 0
	}

	for (const row of rows) {
		batch.push(row)
		batchSize += row.length + 1
		if (batchSize >= batchBytes) await flush()
	}
	await flush()
	return inserted
}

// ---------------------------------------------------------------------------
// fixture records
// ---------------------------------------------------------------------------

export interface FixtureVerdict {
	readonly vendor: string
	readonly session_state: number
	/** A decimal string: a UInt64 hash above 2^53 does not survive `JSON.parse`. */
	readonly session_key_hash: string
	readonly rules_version: number
	/** Hex of the raw winning session-key value, or null below state 5. */
	readonly session_key_hex: string | null
}

export interface FixtureRecord {
	readonly id: string
	readonly category: string
	readonly note?: string
	/** Present on synthetic fixtures; the corpus artifact carries rows only. */
	readonly rust?: FixtureVerdict
	readonly capture?: string
	/** The exact NDJSON line the row writer produced. */
	readonly row: string
}

export const parseFixtureJsonl = (body: string): ReadonlyArray<FixtureRecord> =>
	body
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as FixtureRecord)

export const syntheticFixturePath = join(
	dirname(fileURLToPath(import.meta.url)),
	"__fixtures__/equivalence-spans.jsonl",
)

export const loadSyntheticFixtures = (): ReadonlyArray<FixtureRecord> =>
	parseFixtureJsonl(readFileSync(syntheticFixturePath, "utf8"))

/** The span id a row carries, used to name the offending span when a verdict differs. */
export const rowSpanId = (record: FixtureRecord): string => {
	const row: unknown = JSON.parse(record.row)
	if (typeof row !== "object" || row === null) return ""
	const spanId = (row as { span_id?: unknown }).span_id
	return typeof spanId === "string" ? spanId : ""
}

/** A readable dump of one row, for mismatch reports. */
export const describeRow = (rowJson: string): string => {
	const row: unknown = JSON.parse(rowJson)
	if (typeof row !== "object" || row === null) return rowJson
	const fields = row as Readonly<Record<string, unknown>>
	const truncate = (value: unknown): string => {
		const text = typeof value === "string" ? value : JSON.stringify(value)
		return text !== undefined && text.length > 600 ? `${text.slice(0, 600)}…` : (text ?? "")
	}
	return [
		`  span_name        = ${truncate(fields.span_name)}`,
		`  scope_name       = ${truncate(fields.scope_name)}`,
		`  span_attributes  = ${truncate(fields.span_attributes)}`,
		`  scope_attributes = ${truncate(fields.scope_attributes)}`,
		`  resource_attrs   = ${truncate(fields.resource_attributes)}`,
	].join("\n")
}
