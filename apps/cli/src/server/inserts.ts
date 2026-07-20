// Per-datasource INSERT templates for the embedded chDB, built from the
// generated `local-inserts.json` so the snake_case NDJSON the OTLP encoders
// emit maps to the PascalCase table columns with zero divergence. Direct port
// of `Templates::build` in the former `apps/ingest/src/chdb.rs`.

import insertMappings from "./schema/local-inserts.json"

/** Pinned single-tenant org id; every row is written under it. */
const LOCAL_ORG_ID = "local"

interface DatasourceMapping {
	readonly table: string
	readonly columns: ReadonlyArray<string>
	readonly selects: ReadonlyArray<string>
	readonly inputSchema: string
}
interface InsertMappingsFile {
	readonly orgPlaceholder: string
	readonly datasources: Record<string, DatasourceMapping>
}

const mappings = insertMappings as InsertMappingsFile

/** Escape a value for a single-quoted ClickHouse SQL string literal. */
const escapeSqlLiteral = (value: string): string => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")

interface InsertTemplate {
	readonly prefix: string
	readonly suffix: string
}

const templates: Map<string, InsertTemplate> = (() => {
	const orgLiteral = `'${escapeSqlLiteral(LOCAL_ORG_ID)}'`
	const out = new Map<string, InsertTemplate>()
	for (const [name, mapping] of Object.entries(mappings.datasources)) {
		// Pin OrgId to the local tenant; every other select references a column
		// produced by the format() table function.
		const selects = mapping.selects.map((s) => (s === mappings.orgPlaceholder ? orgLiteral : s))
		const prefix =
			`INSERT INTO ${mapping.table} (${mapping.columns.join(", ")}) ` +
			`SELECT ${selects.join(", ")} FROM format(JSONEachRow, '${mapping.inputSchema}', '`
		out.set(name, { prefix, suffix: "')" })
	}
	return out
})()

/**
 * Build an `INSERT … SELECT … FROM format(JSONEachRow, '<schema>', '<data>')`
 * statement for one datasource's NDJSON batch.
 */
export function buildInsertSql(datasource: string, ndjson: string): string {
	const template = templates.get(datasource)
	if (!template) throw new Error(`no insert mapping for datasource '${datasource}'`)
	return template.prefix + escapeSqlLiteral(ndjson) + template.suffix
}

/**
 * chDB parses the entire statement — inlined data literal included — against
 * its default `max_query_size` (~256KB), so a large batch in one statement
 * fails with "Code: 62 … Max query size exceeded". Budget for the escaped
 * payload per statement, leaving headroom for the template prefix/suffix.
 */
const MAX_ESCAPED_PAYLOAD_BYTES = 200_000

export interface InsertStatement {
	readonly sql: string
	readonly rowCount: number
}

/**
 * Like {@link buildInsertSql}, but splits the NDJSON batch on line boundaries
 * into as many statements as needed so each stays under chDB's query-size
 * limit. A single line larger than the budget is emitted as its own statement
 * (never split mid-line).
 */
export function buildInsertStatements(datasource: string, ndjson: string): InsertStatement[] {
	const template = templates.get(datasource)
	if (!template) throw new Error(`no insert mapping for datasource '${datasource}'`)
	const out: InsertStatement[] = []
	let chunk: string[] = []
	let chunkBytes = 0
	const flush = () => {
		if (chunk.length === 0) return
		out.push({ sql: template.prefix + chunk.join("\n") + template.suffix, rowCount: chunk.length })
		chunk = []
		chunkBytes = 0
	}
	for (const line of ndjson.split("\n")) {
		if (line.length === 0) continue
		// Escaping is per-character, so escaping line-by-line and joining with
		// "\n" is identical to escaping the whole batch at once.
		const escaped = escapeSqlLiteral(line)
		const bytes = Buffer.byteLength(escaped, "utf8") + 1
		if (chunkBytes > 0 && chunkBytes + bytes > MAX_ESCAPED_PAYLOAD_BYTES) flush()
		chunk.push(escaped)
		chunkBytes += bytes
	}
	flush()
	return out
}
