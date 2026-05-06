/**
 * Native ClickHouse DDL emitter.
 *
 * Consumes the Tinybird `.datasource` / `.pipe` text resources produced by the
 * existing `buildTinybirdProjectManifest()` and translates them into vanilla
 * ClickHouse `CREATE TABLE` / `CREATE MATERIALIZED VIEW` statements suitable
 * for a self-managed ClickHouse server.
 *
 * The Tinybird text format is already mostly ClickHouse-native — column types,
 * engine names, sorting/partition keys all use ClickHouse syntax. The pieces
 * we strip / rewrite are:
 *
 *   - `\`json:$.path\`` annotations on columns (Tinybird ingestion hint)
 *   - `FORWARD_QUERY` blocks (Tinybird-only schema-evolution backfill)
 *   - `INDEXES >` blocks (Tinybird-only top-level section; folded into CREATE TABLE)
 *   - `TYPE MATERIALIZED` + `DATASOURCE` (folded into CREATE MATERIALIZED VIEW … TO …)
 *
 * Materialized views must be created after both their source and target tables
 * exist — `orderForCreation()` returns datasources first, then MVs.
 */

export type EngineFlavor = "MergeTree" | "ReplicatedMergeTree" | "SharedMergeTree"

export interface EmitterOptions {
	readonly database?: string
	readonly engineFlavor?: EngineFlavor
	readonly ifNotExists?: boolean
}

const defaultOptions: Required<EmitterOptions> = {
	database: "",
	engineFlavor: "MergeTree",
	ifNotExists: true,
}

const resolve = (options?: EmitterOptions): Required<EmitterOptions> => ({
	...defaultOptions,
	...(options ?? {}),
})

const qualified = (name: string, database: string): string =>
	database.length > 0 ? `${quoteIdent(database)}.${quoteIdent(name)}` : quoteIdent(name)

const quoteIdent = (name: string): string =>
	/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replace(/`/g, "``")}\``

const stripJsonPathAnnotations = (line: string): string =>
	line.replace(/\s*`json:[^`]*`/g, "")

const indent = (lines: ReadonlyArray<string>, prefix = "    "): string =>
	lines.map((line) => `${prefix}${line}`).join("\n")

interface ParsedDatasourceSchema {
	readonly description: string
	readonly columns: ReadonlyArray<string>
	readonly engine: string
	readonly partitionKey: string
	readonly sortingKey: string
	readonly ttl: string | undefined
	readonly indexes: ReadonlyArray<string>
}

interface ParsedPipe {
	readonly description: string
	readonly sql: string
	readonly target: string
}

const SECTION_HEADER = /^([A-Z_][A-Z0-9_]*)\s*(>|".*"|.+)?\s*$/

const parseDatasource = (content: string): ParsedDatasourceSchema => {
	const lines = content.split("\n")

	let description = ""
	const schemaLines: string[] = []
	let engine = ""
	let partitionKey = ""
	let sortingKey = ""
	let ttl: string | undefined
	const indexLines: string[] = []

	let currentBlock: "DESCRIPTION" | "SCHEMA" | "INDEXES" | "FORWARD_QUERY" | null = null
	const blockBuffer: string[] = []

	const flushBlock = () => {
		const body = blockBuffer.map((l) => l.replace(/^    /, "")).join("\n").trim()
		switch (currentBlock) {
			case "DESCRIPTION":
				description = body
				break
			case "SCHEMA": {
				const cols = body
					.split(/,\s*\n/)
					.map((c) => c.replace(/\n\s+/g, " ").trim())
					.filter((c) => c.length > 0)
				schemaLines.push(...cols)
				break
			}
			case "INDEXES":
				indexLines.push(
					...body.split("\n").map((l) => l.trim()).filter((l) => l.length > 0),
				)
				break
			case "FORWARD_QUERY":
				// Intentionally ignored for self-managed ClickHouse — see file header.
				break
			default:
				break
		}
		blockBuffer.length = 0
		currentBlock = null
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? ""
		const trimmed = line.trim()
		if (trimmed.length === 0) {
			if (currentBlock !== null) {
				blockBuffer.push(line)
			}
			continue
		}

		const startsBlockOrField = !line.startsWith(" ") && !line.startsWith("\t")
		if (startsBlockOrField && currentBlock !== null) {
			flushBlock()
		}

		const match = SECTION_HEADER.exec(line)
		if (startsBlockOrField && match) {
			const key = match[1] ?? ""
			const valueRaw = (match[2] ?? "").trim()

			switch (key) {
				case "DESCRIPTION":
				case "SCHEMA":
				case "INDEXES":
				case "FORWARD_QUERY":
					currentBlock = key
					continue
				case "ENGINE":
					engine = stripQuotes(valueRaw)
					continue
				case "ENGINE_PARTITION_KEY":
					partitionKey = stripQuotes(valueRaw)
					continue
				case "ENGINE_SORTING_KEY":
					sortingKey = stripQuotes(valueRaw)
					continue
				case "ENGINE_TTL":
					ttl = stripQuotes(valueRaw)
					continue
				default:
					// Unknown top-level keys are intentionally swallowed; the
					// Tinybird format includes some that don't affect ClickHouse
					// (KAFKA_*, IMPORTING, SHARED_WITH). Log nothing — generator
					// CI catches drift via snapshot diff.
					continue
			}
		}

		if (currentBlock !== null) {
			blockBuffer.push(line)
		}
	}

	if (currentBlock !== null) {
		flushBlock()
	}

	if (engine.length === 0) {
		throw new Error("Datasource is missing an ENGINE declaration")
	}
	if (sortingKey.length === 0) {
		throw new Error("Datasource is missing an ENGINE_SORTING_KEY declaration")
	}

	return {
		description,
		columns: schemaLines.map(stripJsonPathAnnotations),
		engine,
		partitionKey,
		sortingKey,
		ttl,
		indexes: indexLines,
	}
}

const stripQuotes = (raw: string): string => {
	const trimmed = raw.trim()
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1)
	}
	return trimmed
}

const parsePipe = (content: string): ParsedPipe => {
	const lines = content.split("\n")

	let description = ""
	let sql = ""
	let target = ""

	let currentBlock: "DESCRIPTION" | "SQL" | null = null
	const blockBuffer: string[] = []

	const flushBlock = () => {
		const body = blockBuffer.map((l) => l.replace(/^    /, "")).join("\n").trim()
		switch (currentBlock) {
			case "DESCRIPTION":
				description = body
				break
			case "SQL":
				sql = body
				break
			default:
				break
		}
		blockBuffer.length = 0
		currentBlock = null
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? ""
		const trimmed = line.trim()
		if (trimmed.length === 0) {
			if (currentBlock !== null) blockBuffer.push(line)
			continue
		}

		const startsBlockOrField = !line.startsWith(" ") && !line.startsWith("\t")
		if (startsBlockOrField && currentBlock !== null) {
			flushBlock()
		}

		const match = SECTION_HEADER.exec(line)
		if (startsBlockOrField && match) {
			const key = match[1] ?? ""
			const valueRaw = (match[2] ?? "").trim()

			switch (key) {
				case "DESCRIPTION":
				case "SQL":
					currentBlock = key
					continue
				case "NODE":
					// Tinybird requires a NODE name; ClickHouse MVs don't.
					continue
				case "TYPE":
					if (stripQuotes(valueRaw).toUpperCase() !== "MATERIALIZED") {
						throw new Error(`Unsupported pipe TYPE: ${valueRaw}`)
					}
					continue
				case "DATASOURCE":
					target = stripQuotes(valueRaw)
					continue
				default:
					continue
			}
		}

		if (currentBlock !== null) blockBuffer.push(line)
	}

	if (currentBlock !== null) flushBlock()

	if (sql.length === 0) {
		throw new Error("Pipe is missing a SQL block")
	}
	if (target.length === 0) {
		throw new Error("Pipe is missing a DATASOURCE target")
	}

	return { description, sql, target }
}

const formatEngine = (parsedEngine: string, flavor: EngineFlavor): string => {
	// Most Tinybird engines map 1:1 to ClickHouse engines.
	// `MergeTree` itself is the only one we substitute when targeting
	// ReplicatedMergeTree / SharedMergeTree clusters; the *MergeTree variants
	// (Aggregating/Summing/Replacing) are kept as-is.
	if (parsedEngine === "MergeTree" && flavor !== "MergeTree") {
		return flavor
	}
	return parsedEngine
}

const buildIndexClause = (raw: string): string => {
	// Input form (Tinybird):
	//   idx_trace_id TraceId TYPE bloom_filter(0.01) GRANULARITY 1
	// Output form (ClickHouse inside the column list):
	//   INDEX idx_trace_id TraceId TYPE bloom_filter(0.01) GRANULARITY 1
	return `INDEX ${raw}`
}

export interface ResourceContent {
	readonly name: string
	readonly content: string
}

/**
 * Emit a CREATE TABLE statement for a single Tinybird datasource resource.
 */
export const emitCreateTable = (
	datasource: ResourceContent,
	options?: EmitterOptions,
): string => {
	const opts = resolve(options)
	const parsed = parseDatasource(datasource.content)

	const ifNotExists = opts.ifNotExists ? "IF NOT EXISTS " : ""
	const tableRef = qualified(datasource.name, opts.database)

	const innerLines = [
		...parsed.columns.map((col, i) => `${col}${i < parsed.columns.length - 1 || parsed.indexes.length > 0 ? "," : ""}`),
		...parsed.indexes.map((idx, i) => `${buildIndexClause(idx)}${i < parsed.indexes.length - 1 ? "," : ""}`),
	]

	const lines = [
		`CREATE TABLE ${ifNotExists}${tableRef} (`,
		indent(innerLines),
		`)`,
		`ENGINE = ${formatEngine(parsed.engine, opts.engineFlavor)}`,
	]

	if (parsed.partitionKey.length > 0) {
		lines.push(`PARTITION BY ${parsed.partitionKey}`)
	}
	lines.push(`ORDER BY (${parsed.sortingKey})`)
	if (parsed.ttl !== undefined && parsed.ttl.length > 0) {
		lines.push(`TTL ${parsed.ttl}`)
	}

	return lines.join("\n")
}

/**
 * Emit a CREATE MATERIALIZED VIEW statement for a single Tinybird pipe resource.
 *
 * Materialized views in ClickHouse are decoupled from their target table —
 * `… TO <target>` references a pre-existing table. The Tinybird `.pipe`
 * format encodes the target via `DATASOURCE <name>`.
 */
export const emitCreateMaterializedView = (
	pipe: ResourceContent,
	options?: EmitterOptions,
): string => {
	const opts = resolve(options)
	const parsed = parsePipe(pipe.content)

	const ifNotExists = opts.ifNotExists ? "IF NOT EXISTS " : ""
	const viewRef = qualified(pipe.name, opts.database)
	const targetRef = qualified(parsed.target, opts.database)

	return [`CREATE MATERIALIZED VIEW ${ifNotExists}${viewRef} TO ${targetRef} AS`, parsed.sql].join(
		"\n",
	)
}

/**
 * Emit the JSONPath ingestion spec for a single datasource as plain JSON.
 *
 * Each entry maps a column name → its `$.path` (or `null` if the column has
 * no JSONPath, e.g. it's populated by a materialized view rather than direct
 * ingest). Useful for downstream consumers that want to reproduce Tinybird's
 * NDJSON ingestion mapping when bringing their own ingest path.
 */
export const emitJsonPathSpec = (
	datasource: ResourceContent,
): ReadonlyArray<{ readonly column: string; readonly type: string; readonly jsonPath: string | null }> => {
	const parsed = parseDatasource(datasource.content)
	const original = datasource.content.split("\n")

	const colJsonPath = new Map<string, string>()
	for (const line of original) {
		const m = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s+.*?`json:([^`]+)`/.exec(line)
		if (m) {
			const colName = m[1]
			const path = m[2]
			if (colName && path) colJsonPath.set(colName, path)
		}
	}

	return parsed.columns.map((col) => {
		const colMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s+(.+?)(?:\s+DEFAULT\s+.*)?$/.exec(col)
		const name = colMatch?.[1] ?? col.split(/\s+/)[0] ?? ""
		const type = colMatch?.[2] ?? ""
		return {
			column: name,
			type,
			jsonPath: colJsonPath.get(name) ?? null,
		}
	})
}

// --- Runtime parsers for already-emitted statements --------------------------
//
// `parseEmittedCreateTable` and `parseEmittedCreateMaterializedView` consume
// the *output* of the emitters (i.e. the SQL strings we ship in
// `latestSnapshotStatements`) and reconstruct a structured shape suitable for
// drift diffs against a customer's live ClickHouse `system.columns` snapshot.
//
// We do NOT parse arbitrary ClickHouse DDL — only the format produced by
// `emitCreateTable` / `emitCreateMaterializedView`. The grammar is therefore
// tightly bounded and the parser stays small.

export interface EmittedTableColumn {
	readonly name: string
	readonly type: string
}

export interface EmittedTable {
	readonly kind: "table"
	readonly name: string
	readonly columns: ReadonlyArray<EmittedTableColumn>
}

export interface EmittedMaterializedView {
	readonly kind: "materialized_view"
	readonly name: string
	readonly target: string
}

export type EmittedStatement = EmittedTable | EmittedMaterializedView

const COLUMN_CLAUSE_KEYWORDS = /^(DEFAULT|MATERIALIZED|ALIAS|CODEC|COMMENT|TTL|EPHEMERAL)\b/i

/**
 * Parse a single column-definition line (i.e. one entry inside the
 * parenthesised column list of a CREATE TABLE statement). Walks the type
 * expression while tracking parenthesis depth — necessary because
 * `Map(LowCardinality(String), String)` contains spaces and commas that would
 * confuse a naive split.
 *
 * Returns `null` for non-column lines (e.g. an `INDEX …` clause).
 */
const parseColumnDefinitionLine = (line: string): EmittedTableColumn | null => {
	const trimmed = line.trim().replace(/,$/, "")
	if (trimmed.length === 0) return null
	if (/^INDEX\s/i.test(trimmed)) return null

	const nameMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s+/.exec(trimmed)
	if (!nameMatch) return null
	const name = nameMatch[1] ?? ""
	const rest = trimmed.slice(nameMatch[0].length)

	let depth = 0
	let typeEnd = rest.length
	for (let i = 0; i < rest.length; i++) {
		const ch = rest[i]
		if (ch === "(") depth++
		else if (ch === ")") depth--
		else if (ch === " " && depth === 0) {
			const remainder = rest.slice(i + 1)
			if (COLUMN_CLAUSE_KEYWORDS.test(remainder)) {
				typeEnd = i
				break
			}
		}
	}

	const type = rest.slice(0, typeEnd).trim()
	if (type.length === 0) return null
	return { name, type }
}

const CREATE_TABLE_HEADER = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/i
const CREATE_MV_HEADER =
	/^CREATE\s+MATERIALIZED\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+TO\s+([A-Za-z_][A-Za-z0-9_]*)\s+AS/i

/**
 * Reconstruct the structural shape of a previously-emitted CREATE TABLE or
 * CREATE MATERIALIZED VIEW statement. Returns `null` for any other shape (so
 * callers can skip miscellaneous statements without crashing).
 *
 * For tables, columns are returned with the same type strings ClickHouse
 * stores in `system.columns.type`, which makes string-equality comparisons
 * sufficient for drift detection.
 */
export const parseEmittedStatement = (sql: string): EmittedStatement | null => {
	const tableMatch = CREATE_TABLE_HEADER.exec(sql)
	if (tableMatch) {
		const name = tableMatch[1] ?? ""
		const openIndex = sql.indexOf("(")
		// Match the closing paren of the column list (track depth so nested
		// parens inside types like Map(...) don't terminate us early).
		let depth = 0
		let closeIndex = -1
		for (let i = openIndex; i < sql.length; i++) {
			const ch = sql[i]
			if (ch === "(") depth++
			else if (ch === ")") {
				depth--
				if (depth === 0) {
					closeIndex = i
					break
				}
			}
		}
		if (closeIndex < 0) return null
		const body = sql.slice(openIndex + 1, closeIndex)
		const columns: EmittedTableColumn[] = []
		// Split on commas at the top level only.
		let lineDepth = 0
		let lineStart = 0
		const segments: string[] = []
		for (let i = 0; i < body.length; i++) {
			const ch = body[i]
			if (ch === "(") lineDepth++
			else if (ch === ")") lineDepth--
			else if (ch === "," && lineDepth === 0) {
				segments.push(body.slice(lineStart, i))
				lineStart = i + 1
			}
		}
		segments.push(body.slice(lineStart))
		for (const segment of segments) {
			const col = parseColumnDefinitionLine(segment)
			if (col) columns.push(col)
		}
		return { kind: "table", name, columns }
	}

	const mvMatch = CREATE_MV_HEADER.exec(sql)
	if (mvMatch) {
		return {
			kind: "materialized_view",
			name: mvMatch[1] ?? "",
			target: mvMatch[2] ?? "",
		}
	}

	return null
}

/**
 * Extract a single column's *original* definition line — including any
 * `DEFAULT` / `MATERIALIZED` / `CODEC` / `COMMENT` / `TTL` clauses — from a
 * CREATE TABLE statement.
 *
 * Used by `OrgClickHouseSettingsService.applySchema` to emit
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS <line>` against drifted tables
 * without losing column defaults. (`parseEmittedStatement` strips the clauses
 * because string-equality on the bare type is what drift detection wants;
 * here we need the opposite.)
 *
 * Returns `null` if `sql` is not a CREATE TABLE, the column doesn't appear in
 * the column list, or the matched line is an `INDEX` clause.
 */
export const extractColumnDefinition = (sql: string, columnName: string): string | null => {
	const tableMatch = CREATE_TABLE_HEADER.exec(sql)
	if (!tableMatch) return null

	const openIndex = sql.indexOf("(")
	let depth = 0
	let closeIndex = -1
	for (let i = openIndex; i < sql.length; i++) {
		const ch = sql[i]
		if (ch === "(") depth++
		else if (ch === ")") {
			depth--
			if (depth === 0) {
				closeIndex = i
				break
			}
		}
	}
	if (closeIndex < 0) return null

	const body = sql.slice(openIndex + 1, closeIndex)
	let lineDepth = 0
	let lineStart = 0
	const segments: string[] = []
	for (let i = 0; i < body.length; i++) {
		const ch = body[i]
		if (ch === "(") lineDepth++
		else if (ch === ")") lineDepth--
		else if (ch === "," && lineDepth === 0) {
			segments.push(body.slice(lineStart, i))
			lineStart = i + 1
		}
	}
	segments.push(body.slice(lineStart))

	for (const segment of segments) {
		const trimmed = segment.trim().replace(/,$/, "").trim()
		if (trimmed.length === 0) continue
		if (/^INDEX\s/i.test(trimmed)) continue
		const nameMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s+/.exec(trimmed)
		if (!nameMatch) continue
		if (nameMatch[1] === columnName) return trimmed
	}
	return null
}

/**
 * Build the full ordered list of DDL statements for a Tinybird project
 * manifest. Order is:
 *
 *   1. Target datasources (those without JSONPath; populated by MVs)
 *   2. Source datasources (direct ingest targets)
 *   3. Materialized views
 *
 * In ClickHouse, an MV must be created after both its source and its target
 * exist. We don't strictly need to separate target vs source datasources —
 * datasources have no inter-dependencies — but emitting them in two groups
 * makes the output easier to read.
 */
export const emitProjectDdl = (
	manifest: {
		readonly datasources: ReadonlyArray<ResourceContent>
		readonly pipes: ReadonlyArray<ResourceContent>
	},
	options?: EmitterOptions,
): ReadonlyArray<string> => {
	const datasourceStatements = [...manifest.datasources]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((ds) => emitCreateTable(ds, options))

	const mvStatements = [...manifest.pipes]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((pipe) => emitCreateMaterializedView(pipe, options))

	return [...datasourceStatements, ...mvStatements]
}
