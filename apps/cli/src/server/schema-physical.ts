import { Chdb } from "./chdb"
import { LOCAL_SCHEMA_MANIFEST } from "./schema-identity"
import {
	comparePhysicalSchema,
	type LocalSchemaColumn,
	type PhysicalSchema,
	type PhysicalSchemaObject,
} from "./schema-manifest"

const parseJsonEachRow = <A>(value: string): A[] =>
	value
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as A)

interface ColumnRow {
	table: string
	name: string
	type: string
	position: number
	default_kind: string
	default_expression: string
	compression_codec: string
}

/** Inspect the physical definitions chDB reports, including the objects that
 * are easy to miss when relying on a bundled DDL fingerprint alone. */
export const inspectPhysicalSchema = (db: Chdb): PhysicalSchema => {
	const tables = parseJsonEachRow<{
		name: string
		engine: string
		partition_key: string
		sorting_key: string
		create_table_query: string
	}>(
		db.query(
			"SELECT name, engine, partition_key, sorting_key, create_table_query FROM system.tables WHERE database = 'default'",
		),
	)
	const columns = parseJsonEachRow<ColumnRow>(
		db.query(
			"SELECT table, name, type, position, default_kind, default_expression, compression_codec FROM system.columns WHERE database = 'default' ORDER BY table, position",
		),
	)
	let indexes: Array<{ table: string; name: string }> = []
	try {
		indexes = parseJsonEachRow<{ table: string; name: string }>(
			db.query("SELECT table, name FROM system.data_skipping_indices WHERE database = 'default'"),
		)
	} catch {
		// Older supported libchdb builds may not expose this system table. The
		// CREATE TABLE definitions below still provide a strict index-name fallback.
	}
	const columnsByTable = new Map<string, LocalSchemaColumn[]>()
	for (const column of columns) {
		const list = columnsByTable.get(column.table) ?? []
		list.push({
			name: column.name,
			type: column.type,
			...(!column.default_kind ? {} : { defaultKind: column.default_kind }),
			...(!column.default_expression ? {} : { defaultExpression: column.default_expression }),
			...(!column.compression_codec || column.compression_codec === "NONE"
				? {}
				: { codec: column.compression_codec }),
		})
		columnsByTable.set(column.table, list)
	}
	const indexesByTable = new Map<string, string[]>()
	for (const index of indexes) {
		const list = indexesByTable.get(index.table) ?? []
		list.push(index.name)
		indexesByTable.set(index.table, list)
	}
	const ttlFromDefinition = (definition: string): string | undefined =>
		definition.match(/\bTTL\s+(.+?)(?=\bSETTINGS\b|$)/is)?.[1]?.trim()
	const indexesFromDefinition = (definition: string): string[] =>
		[...definition.matchAll(/\bINDEX\s+([A-Za-z_][A-Za-z0-9_]*)\b/gi)].map((match) => match[1]!)
	return {
		objects: tables.map(
			(table): PhysicalSchemaObject => ({
				name: table.name,
				kind: table.engine.toLowerCase().includes("materializedview")
					? "materialized_view"
					: table.engine.toLowerCase() === "view"
						? "view"
						: "table",
				columns: columnsByTable.get(table.name) ?? [],
				engine: table.engine,
				partitionBy: table.partition_key,
				orderBy: table.sorting_key,
				ttl: ttlFromDefinition(table.create_table_query),
				indexes: Array.from(
					new Set([
						...(indexesByTable.get(table.name) ?? []),
						...indexesFromDefinition(table.create_table_query),
					]),
				),
				definition: table.create_table_query,
			}),
		),
	}
}

export const assertCurrentPhysicalSchema = (db: Chdb): void => {
	const mismatches = comparePhysicalSchema(LOCAL_SCHEMA_MANIFEST, inspectPhysicalSchema(db))
	if (mismatches.length > 0) {
		throw new Error(
			`physical local schema does not match the bundled schema: ${mismatches
				.slice(0, 8)
				.map((mismatch) => `${mismatch.object}: ${mismatch.reason}`)
				.join("; ")}`,
		)
	}
}
