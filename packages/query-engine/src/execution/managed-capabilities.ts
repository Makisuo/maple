import { latestSnapshotStatements } from "@maple/domain/generated/clickhouse-schema"
import {
	deriveWarehouseCapabilities,
	type WarehouseCapabilities,
	type WarehouseColumnMetadataRow,
	type WarehouseIndexMetadataRow,
} from "../capabilities"

/**
 * Capabilities for the warehouses whose schema *we* deploy.
 *
 * Probing `system.columns` / `system.data_skipping_indices` at runtime is the
 * wrong question to ask a managed backend: Tinybird's `/v0/sql` answers `403`
 * for both (it does not expose `system.*` to workspace tokens), and its
 * ClickHouse-compatible gateway answers the `system.columns` scan in ~2.2s —
 * over the inspection budget. Every inspection therefore fell back to
 * `baselineWarehouseCapabilities()`, which pins `attributeIndexMode` to `"none"`
 * and `logBodySearchMode` to `"scan"` — so the bloom and tokenbf indices that
 * are in the deployed schema were never used by a single production query.
 *
 * For a schema we own, the indices are a compile-time fact. These are read out
 * of the generated snapshot rather than hand-listed so that adding an index to
 * `packages/domain/src/tinybird/datasources.ts` enables the matching feature
 * with no change here.
 */

/** The tables `deriveWarehouseCapabilities` reasons about. */
const CAPABILITY_TABLES = ["logs", "traces"] as const

/**
 * `INDEX <name> <expr> TYPE <type> [GRANULARITY <n>]`. Both `<expr>` and
 * `<type>` contain parentheses and commas (`mapKeys(SpanAttributes)`,
 * `tokenbf_v1(32768, 3, 0)`), so the keywords — not punctuation — delimit them.
 */
const INDEX_LINE = /^INDEX\s+(\S+)\s+(.+?)\s+TYPE\s+(.+?)(?:\s+GRANULARITY\s+\d+)?$/

interface TableMetadata {
	readonly columns: ReadonlyArray<WarehouseColumnMetadataRow>
	readonly indexes: ReadonlyArray<WarehouseIndexMetadataRow>
}

/**
 * Parse the column and index list out of one generated `CREATE TABLE`. The
 * statements are machine-generated with exactly one column or index per line,
 * so this stays a line scan rather than a DDL parser.
 */
const parseTableDdl = (table: string, ddl: string): TableMetadata => {
	const lines = ddl.split("\n")
	const end = lines.findIndex((line, index) => index > 0 && line.startsWith(")"))
	const body = lines.slice(1, end === -1 ? lines.length : end)

	const columns: Array<WarehouseColumnMetadataRow> = []
	const indexes: Array<WarehouseIndexMetadataRow> = []

	for (const line of body) {
		const entry = line.trim().replace(/,$/, "")
		if (entry === "") continue
		const index = INDEX_LINE.exec(entry)
		if (index) {
			indexes.push({ table, name: index[1]!, type: index[3]!, expression: index[2]! })
			continue
		}
		const name = entry.split(/\s+/)[0]
		if (name !== undefined) columns.push({ table, name })
	}

	return { columns, indexes }
}

const readManagedSchemaMetadata = (): TableMetadata => {
	const columns: Array<WarehouseColumnMetadataRow> = []
	const indexes: Array<WarehouseIndexMetadataRow> = []

	for (const table of CAPABILITY_TABLES) {
		const ddl = latestSnapshotStatements.find((statement) =>
			statement.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`),
		)
		if (ddl === undefined) continue
		const parsed = parseTableDdl(table, ddl)
		columns.push(...parsed.columns)
		indexes.push(...parsed.indexes)
	}

	return { columns, indexes }
}

let cached: WarehouseCapabilities | undefined

/**
 * Capabilities derived from the deployed managed schema. Computed once per
 * isolate — the generated snapshot cannot change at runtime.
 *
 * `settings` is deliberately empty: both managed backends set
 * `stripTinybirdRestrictedSettings`, so `enable_full_text_index` can never be
 * overridden inline and `fullTextSearchSetting` resolves to `"unavailable"`
 * either way. The managed schema carries no `text` indices, so no text feature
 * depends on it.
 */
export const managedWarehouseCapabilities = (): WarehouseCapabilities => {
	if (cached === undefined) {
		const { columns, indexes } = readManagedSchemaMetadata()
		cached = deriveWarehouseCapabilities({
			indexes,
			columns,
			settings: [],
			allowSettingOverrides: false,
		})
	}
	return cached
}
