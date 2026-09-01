// SAFETY-FILE: JSON rows here come from fixed internal formats and are validated before domain use.
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { decodeJsonEachRow, decodeJsonObjectRows } from "../chdb-rows"
import {
	LOCAL_SCHEMA_V1_MANIFEST,
	LOCAL_SCHEMA_V1_SQL,
	LEGACY_LOCAL_SCHEMA,
	LOCAL_SCHEMA_V1,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"
import { strictDecoder, UnsignedDecimal } from "./journal-codecs"
import type { LocalSchemaColumn } from "../schema-manifest"
import type {
	LocalStoreMigrationModule,
	MigrationModuleContext,
	MigrationOperation,
	StateDispositionEntry,
} from "../local-store-migration-module"

// Batch bounds keep memory bounded and the journal resumable. Consecutive
// same-side queries share one cached connection, but each batch still
// alternates a source SELECT with a target INSERT, and chDB allows one
// connection per process — so every batch pays one full store reopen per
// side, and bounds this size dominate real-store migration time.
export const LEGACY_RAW_TABLES = [
	{
		name: "logs",
		timeColumn: "TimestampTime",
		retentionDays: 30,
		batchRows: 2000,
		batchBytes: 4 * 1024 * 1024,
	},
	{
		name: "traces",
		timeColumn: "Timestamp",
		retentionDays: 30,
		batchRows: 2000,
		batchBytes: 4 * 1024 * 1024,
	},
	{
		name: "metrics_sum",
		timeColumn: "TimeUnix",
		retentionDays: 90,
		batchRows: 4000,
		batchBytes: 4 * 1024 * 1024,
	},
	{
		name: "metrics_gauge",
		timeColumn: "TimeUnix",
		retentionDays: 90,
		batchRows: 4000,
		batchBytes: 4 * 1024 * 1024,
	},
	{
		name: "metrics_histogram",
		timeColumn: "TimeUnix",
		retentionDays: 90,
		batchRows: 2000,
		batchBytes: 4 * 1024 * 1024,
	},
	{
		name: "metrics_exponential_histogram",
		timeColumn: "TimeUnix",
		retentionDays: 90,
		batchRows: 2000,
		batchBytes: 4 * 1024 * 1024,
	},
] as const

type LegacyRawTable = (typeof LEGACY_RAW_TABLES)[number]

const RAW_TABLE_NAMES = new Set<string>(LEGACY_RAW_TABLES.map((table) => table.name))
const OPERATIONAL_TABLE_NAMES = new Set([
	"alert_checks",
	"session_events",
	"session_replay_events",
	"session_replays",
])

export interface TableInventory {
	readonly table: string
	readonly rowCount: string
	readonly retentionStartAt: string
	readonly minTime: string | null
	readonly maxTime: string | null
	readonly hashSum: string
	readonly hashXor: string
}

export interface CopyProgress {
	readonly rows: number
	readonly bytes: number
	readonly lastTimestamp: string | null
	readonly lastHash: string | null
	readonly lastTieBreak: string | null
	/** Cumulative ordinal consumed within the final composite-key group. */
	readonly duplicateCount: number
	readonly duplicateGroupExhausted: boolean
}

export interface PendingBatch {
	readonly table: string
	readonly rowCount: number
	readonly byteLength: number
	readonly firstTimestamp: string | null
	readonly firstHash: string | null
	readonly firstTieBreak: string | null
	readonly lastTimestamp: string | null
	readonly lastHash: string | null
	readonly lastTieBreak: string | null
	readonly lastKeyCount: number
	readonly lastKeyExhausted: boolean
	readonly signature: string
}

export interface LegacyModuleState {
	readonly module: "local-0000-to-0001-raw-replay"
	readonly version: 1
}

export interface RawReplayProgress {
	readonly sourceInventory: Readonly<Record<string, TableInventory>>
	readonly copied: Readonly<Record<string, CopyProgress>>
	readonly pendingBatch?: PendingBatch
}

const emptyCopyProgress = (): CopyProgress => ({
	rows: 0,
	bytes: 0,
	lastTimestamp: null,
	lastHash: null,
	lastTieBreak: null,
	duplicateCount: 0,
	duplicateGroupExhausted: false,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
const NullableString = Schema.NullOr(Schema.String)
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * A ClickHouse UInt64 cursor, or `null` for "no cursor yet".
 *
 * Textual because a UInt64 does not survive a JS number, and pattern-checked
 * because these values are interpolated into the numeric SQL comparisons that
 * drive the resumable copy — anything that could change their meaning has to
 * fail here rather than there.
 */
const Uint64Cursor = Schema.NullOr(UnsignedDecimal)

/** Only tables this build knows how to replay. */
const RawTable = Schema.Literals([...RAW_TABLE_NAMES])

const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/i))

const TableInventorySchema = Schema.Struct({
	table: NonEmptyString,
	rowCount: NonEmptyString,
	retentionStartAt: NonEmptyString,
	minTime: NullableString,
	maxTime: NullableString,
	hashSum: NonEmptyString,
	hashXor: NonEmptyString,
})

const CopyProgressSchema = Schema.Struct({
	rows: NonNegativeInt,
	bytes: NonNegativeInt,
	lastTimestamp: NullableString,
	lastHash: Uint64Cursor,
	lastTieBreak: Uint64Cursor,
	/** Cumulative ordinal consumed within the final composite-key group. */
	duplicateCount: NonNegativeInt,
	duplicateGroupExhausted: Schema.Boolean,
})

const PendingBatchSchema = Schema.Struct({
	table: RawTable,
	// Positive, not merely non-negative: an empty batch would commit nothing
	// while advancing the cursor past the rows it claims to cover.
	rowCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
	byteLength: NonNegativeInt,
	firstTimestamp: NullableString,
	firstHash: Uint64Cursor,
	firstTieBreak: Uint64Cursor,
	lastTimestamp: NullableString,
	lastHash: Uint64Cursor,
	lastTieBreak: Uint64Cursor,
	lastKeyCount: NonNegativeInt,
	lastKeyExhausted: Schema.Boolean,
	signature: Sha256Hex,
})

/**
 * Keyed by `Schema.String`, not by `RawTable`, and the keys are checked below.
 *
 * A record keyed on the literal union requires *every* table to be present, but
 * both maps legitimately hold a subset: `copied` starts empty and fills one
 * table at a time as the replay progresses. Keying it strictly would reject the
 * journal of every partially-progressed migration and strand it.
 */
const RawReplayProgressSchema = Schema.Struct({
	sourceInventory: Schema.Record(Schema.String, TableInventorySchema),
	copied: Schema.Record(Schema.String, CopyProgressSchema),
	pendingBatch: Schema.optionalKey(PendingBatchSchema),
})

const LegacyStateSchema = Schema.Struct({
	module: Schema.Literal("local-0000-to-0001-raw-replay"),
	version: Schema.Literal(1),
})

const decodeProgressStrict = strictDecoder(RawReplayProgressSchema)

const decodeRawReplayProgress = (value: unknown): RawReplayProgress => {
	const progress = decodeProgressStrict(value)
	// Two invariants the schema is not the right place to state, both about the
	// map *keys* rather than the values.
	for (const [table, inventory] of Object.entries(progress.sourceInventory)) {
		if (!RAW_TABLE_NAMES.has(table))
			throw new Error(`legacy raw replay sourceInventory has unknown table ${table}`)
		// An inventory is keyed by table and also carries its own `table` field.
		// If those disagree the journal describes a copy of one table under
		// another's cursor.
		if (inventory.table !== table)
			throw new Error(`legacy raw replay sourceInventory.${table}.table does not match its key`)
	}
	for (const table of Object.keys(progress.copied)) {
		if (!RAW_TABLE_NAMES.has(table))
			throw new Error(`legacy raw replay copied has unknown table ${table}`)
	}
	return progress
}

const asProgress = (value: RawReplayProgress | undefined): RawReplayProgress =>
	value ?? { sourceInventory: {}, copied: {} }

/**
 * Row shapes read back out of chDB.
 *
 * `rowCount` and the hash aggregates are `string | number` on purpose: a UInt64
 * arrives quoted or unquoted depending on the libchdb build, and `numberString`
 * normalizes it. What must not happen is a `Number` decode above 2^53, which is
 * why nothing here is `Schema.Number` alone.
 */
const Uint64Wire = Schema.Union([Schema.String, Schema.Number])

const ColumnRowSchema = Schema.Struct({
	name: Schema.String,
	type: Schema.String,
	position: Schema.Number,
	default_kind: Schema.String,
	default_expression: Schema.String,
	compression_codec: Schema.String,
})

const NameRow = Schema.Struct({ name: Schema.String })

const InventoryRow = Schema.Struct({
	rowCount: Uint64Wire,
	minTime: Schema.NullOr(Schema.String),
	maxTime: Schema.NullOr(Schema.String),
	hashSum: Uint64Wire,
	hashXor: Uint64Wire,
})

const RowCountRow = Schema.Struct({ rowCount: Uint64Wire })

const decodeColumnRows = decodeJsonEachRow(ColumnRowSchema)
const decodeNameRows = decodeJsonEachRow(NameRow)
const decodeInventoryRows = decodeJsonEachRow(InventoryRow)
const decodeRowCountRows = decodeJsonEachRow(RowCountRow)

const identifier = (value: string): string => {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`unsafe ClickHouse identifier: ${value}`)
	return `\`${value}\``
}

const sqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`
const timestampLiteral = (value: string): string => `parseDateTime64BestEffort(${sqlString(value)}, 9, 'UTC')`

/** Nanoseconds-since-epoch for a raw time column, exact for both DateTime and
 * DateTime64(9). Cursor comparisons MUST use this integer form: the server
 * renders DateTime64 values in its own timezone with no offset marker, so a
 * rendered-string round trip through parseDateTime64BestEffort(..., 'UTC')
 * shifts by the host's UTC offset — skipping rows on hosts east of UTC and
 * re-matching the same rows forever on hosts west of it. */
const nsExpression = (column: string): string => `toUnixTimestamp64Nano(toDateTime64(${column}, 9))`

/** Journal cursor values are interpolated into SQL as bare integer literals;
 * anything but digits (e.g. a rendered-timestamp cursor from a pre-fix
 * journal) must fail closed here rather than parse as something else. */
const uint64Literal = (value: string, label: string): string => {
	if (!/^\d+$/.test(value)) throw new Error(`${label} is not an unsigned integer cursor value: ${value}`)
	return value
}

const retentionStartAt = (cutoffAt: string, retentionDays: number): string => {
	const cutoff = Date.parse(cutoffAt)
	if (!Number.isFinite(cutoff)) throw new Error(`invalid migration cutoff: ${cutoffAt}`)
	return new Date(cutoff - retentionDays * 24 * 60 * 60 * 1000).toISOString()
}

const numberString = (value: unknown): string => String(value)

const querySource = (context: MigrationModuleContext, sql: string): Promise<string> =>
	context.openSource((db) => db.query(sql), { schemaSql: LOCAL_SCHEMA_V1_SQL, bootstrapSchema: false })

const queryTarget = (context: MigrationModuleContext, sql: string): Promise<string> =>
	context.openTarget((db) => db.query(sql), { schemaSql: LOCAL_SCHEMA_V1_SQL, bootstrapSchema: false })

const executeTarget = (context: MigrationModuleContext, sql: string): Promise<void> =>
	context.openTarget((db) => db.exec(sql), { schemaSql: LOCAL_SCHEMA_V1_SQL, bootstrapSchema: false })

const tableColumns = async (
	context: MigrationModuleContext,
	side: "source" | "target",
	table: string,
): Promise<ReadonlyArray<LocalSchemaColumn>> => {
	const query = `SELECT name, type, position, default_kind, default_expression, compression_codec FROM system.columns WHERE database = 'default' AND table = ${sqlString(table)} ORDER BY position`
	const rows = decodeColumnRows(
		await (side === "source" ? querySource(context, query) : queryTarget(context, query)),
	)
	return rows.map((row) => ({
		name: row.name,
		type: row.type,
		...(!!row.default_kind ? { defaultKind: row.default_kind } : undefined),
		...(!!row.default_expression ? { defaultExpression: row.default_expression } : undefined),
		...(!(!row.compression_codec || row.compression_codec === "NONE")
			? {
					codec: row.compression_codec,
				}
			: undefined),
	}))
}

const tableExists = async (context: MigrationModuleContext, side: "source" | "target", table: string) => {
	const rows = decodeNameRows(
		await (side === "source"
			? querySource(
					context,
					`SELECT name FROM system.tables WHERE database = 'default' AND name = ${sqlString(table)}`,
				)
			: queryTarget(
					context,
					`SELECT name FROM system.tables WHERE database = 'default' AND name = ${sqlString(table)}`,
				)),
	)
	return rows.length > 0
}

const assertKnownSourceObjects = async (context: MigrationModuleContext): Promise<void> => {
	const known = new Set(LOCAL_SCHEMA_V1_MANIFEST.objects.map((object) => object.name))
	const rows = decodeNameRows(
		await querySource(context, "SELECT name FROM system.tables WHERE database = 'default' ORDER BY name"),
	)
	for (const row of rows) {
		if (!known.has(row.name))
			throw new Error(
				`source contains an unknown local-store object: ${row.name}; migration is unsupported`,
			)
	}
}

const normalizeType = (value: string): string =>
	value
		.replace(/\s+/g, " ")
		.replace(/\s*,\s*/g, ", ")
		.trim()

const ensureSourceTargetColumns = async (
	context: MigrationModuleContext,
	table: LegacyRawTable,
): Promise<ReadonlyArray<LocalSchemaColumn>> => {
	const sourceColumns = await tableColumns(context, "source", table.name)
	const targetColumns = await tableColumns(context, "target", table.name)
	const targetByName = new Map(targetColumns.map((column) => [column.name, column]))
	for (const source of sourceColumns) {
		if (source.name.startsWith("__maple_"))
			throw new Error(`${table.name}.${source.name} uses a reserved migration column name`)
		const target = targetByName.get(source.name)
		if (!target || normalizeType(target.type) !== normalizeType(source.type))
			throw new Error(`${table.name}.${source.name} is not type-compatible with the target`)
	}
	const sourceNames = new Set(sourceColumns.map((column) => column.name))
	for (const target of targetColumns) {
		if (!sourceNames.has(target.name) && target.defaultKind === undefined) {
			throw new Error(
				`${table.name}.${target.name} is new in the target and has no declared default or transform`,
			)
		}
	}
	return sourceColumns
}

const inventory = async (
	context: MigrationModuleContext,
	side: "source" | "target",
	table: LegacyRawTable,
	columns: ReadonlyArray<LocalSchemaColumn>,
	cutoffAt: string,
): Promise<TableInventory> => {
	const lowerBound = retentionStartAt(cutoffAt, table.retentionDays)
	const names = columns.map((column) => identifier(column.name)).join(", ")
	const hash = `cityHash64(toString(tuple(${names})))`
	// UInt64 aggregates leave SQL as strings: chDB emits 64-bit integers as
	// JSON numbers, and JS Number rounding above 2^53 corrupts them.
	const sql = `SELECT count() AS rowCount, min(${identifier(table.timeColumn)}) AS minTime, max(${identifier(table.timeColumn)}) AS maxTime, toString(sum(${hash})) AS hashSum, toString(groupBitXor(${hash})) AS hashXor FROM ${identifier(table.name)} WHERE ${identifier(table.timeColumn)} >= ${timestampLiteral(lowerBound)} AND ${identifier(table.timeColumn)} <= ${timestampLiteral(cutoffAt)}`
	const rows = decodeInventoryRows(
		side === "source" ? await querySource(context, sql) : await queryTarget(context, sql),
	)
	const row = rows[0]
	if (!row) throw new Error(`inventory query returned no row for ${table.name}`)
	return {
		table: table.name,
		rowCount: numberString(row.rowCount),
		retentionStartAt: lowerBound,
		minTime: row.minTime === null ? null : String(row.minTime),
		maxTime: row.maxTime === null ? null : String(row.maxTime),
		hashSum: numberString(row.hashSum),
		hashXor: numberString(row.hashXor),
	}
}

const inventoriesEqual = (a: TableInventory, b: TableInventory): boolean =>
	a.table === b.table &&
	a.rowCount === b.rowCount &&
	a.retentionStartAt === b.retentionStartAt &&
	a.minTime === b.minTime &&
	a.maxTime === b.maxTime &&
	a.hashSum === b.hashSum &&
	a.hashXor === b.hashXor

const tableTotalRowCount = async (
	context: MigrationModuleContext,
	side: "source" | "target",
	table: string,
): Promise<string> => {
	const sql = `SELECT count() AS rowCount FROM ${identifier(table)}`
	const rows = decodeRowCountRows(
		side === "source" ? await querySource(context, sql) : await queryTarget(context, sql),
	)
	if (!rows[0]) throw new Error(`row-count query returned no row for ${table}`)
	return numberString(rows[0].rowCount)
}

const keyOf = (row: Record<string, unknown>): string =>
	`${String(row.__maple_timestamp ?? "")}\0${String(row.__maple_hash ?? "")}\0${String(row.__maple_tie_break ?? "")}`

const copyProgressFor = (progress: RawReplayProgress, table: string): CopyProgress =>
	progress.copied[table] ?? emptyCopyProgress()

const canonicalJson = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
	if (isRecord(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`
	return JSON.stringify(value)
}

const batchSignature = (table: string, rows: ReadonlyArray<Record<string, unknown>>): string =>
	createHash("sha256")
		.update(`${table}\n${rows.length}\n${rows.map(canonicalJson).join("\n")}`)
		.digest("hex")

/** Keep the cursor ordinal cumulative when an equal composite-key group spans
 * multiple row- or byte-bounded batches. Resetting this to the local batch
 * count would make the next query replay the same indistinguishable rows. */
export const advanceDuplicateKeyProgress = (
	previous: CopyProgress,
	previousKey: string | null,
	lastKey: string,
	selectedLastKeyCount: number,
): Pick<CopyProgress, "duplicateCount" | "duplicateGroupExhausted"> => ({
	duplicateCount:
		previousKey === lastKey && !previous.duplicateGroupExhausted
			? previous.duplicateCount + selectedLastKeyCount
			: selectedLastKeyCount,
	duplicateGroupExhausted: false,
})

/** Describe the continuation for a composite-key group. While the group is
 * still open, OFFSET skips the cumulative ordinal already copied; once the
 * group is exhausted, a strict cursor moves to the next distinct key. The
 * offset is essential when one equal-key group is larger than a row/byte
 * batch: fetching only LIMIT rows and filtering them in JavaScript would
 * return an empty batch and stop the replay early. */
export const duplicateCursorContinuation = (
	progress: Pick<
		CopyProgress,
		"lastTimestamp" | "lastHash" | "lastTieBreak" | "duplicateCount" | "duplicateGroupExhausted"
	>,
): { readonly comparison: ">=" | ">"; readonly offset: number } => ({
	comparison: progress.duplicateGroupExhausted ? ">" : ">=",
	offset:
		progress.lastTimestamp !== null &&
		progress.lastHash !== null &&
		progress.lastTieBreak !== null &&
		!progress.duplicateGroupExhausted
			? progress.duplicateCount
			: 0,
})

const duplicateGroupCount = async (
	context: MigrationModuleContext,
	table: LegacyRawTable,
	columns: ReadonlyArray<LocalSchemaColumn>,
	progress: CopyProgress,
): Promise<number> => {
	if (
		progress.lastTimestamp === null ||
		progress.lastHash === null ||
		progress.lastTieBreak === null ||
		progress.duplicateGroupExhausted
	)
		return 0
	const names = columns.map((column) => identifier(column.name)).join(", ")
	const hash = `cityHash64(toString(tuple(${names})))`
	const tie = `sipHash64(toString(tuple(${names})))`
	const sql = `SELECT count() AS rowCount FROM ${identifier(table.name)} WHERE ${nsExpression(identifier(table.timeColumn))} = ${uint64Literal(progress.lastTimestamp, "lastTimestamp")} AND ${hash} = ${uint64Literal(progress.lastHash, "lastHash")} AND ${tie} = ${uint64Literal(progress.lastTieBreak, "lastTieBreak")}`
	const rows = decodeRowCountRows(await querySource(context, sql))
	return rows[0] === undefined ? 0 : Number(rows[0].rowCount)
}

/**
 * Replay SELECTs re-enable quoted 64-bit JSON output for THIS query only. The
 * shared connection pins `output_format_json_quote_64bit_integers=0`, under
 * which raw UInt64 data columns (trace Duration, histogram counts and
 * Array(UInt64) buckets) decode as lossy JS numbers above 2^53 — the copy
 * would then reinsert a silently different integer. Quoted output round-trips
 * exactly: JSONEachRow input accepts quoted 64-bit integers, arrays included.
 */
const EXACT_INT64_SETTINGS = "SETTINGS output_format_json_quote_64bit_integers = 1"

/** First fetch of a table is capped small: the byte budget is applied only
 * AFTER a batch is materialized and decoded, so `batchRows` full rows land in
 * memory first. With multi-megabyte log bodies that is gigabytes; seed
 * conservatively and let the observed average row size grow the limit. */
const INITIAL_FETCH_ROWS = 128

export const nextFetchRowLimit = (
	table: Pick<LegacyRawTable, "batchRows" | "batchBytes">,
	fetchedRows: number,
	fetchedBytes: number,
): number => {
	if (fetchedRows === 0 || fetchedBytes <= 0) return INITIAL_FETCH_ROWS
	const averageRowBytes = fetchedBytes / fetchedRows
	// Aim slightly past the byte budget so a typical batch still fills it.
	const target = Math.ceil((table.batchBytes * 1.25) / averageRowBytes)
	return Math.max(1, Math.min(table.batchRows, target))
}

const copyTable = async (
	context: MigrationModuleContext,
	table: LegacyRawTable,
	columns: ReadonlyArray<LocalSchemaColumn>,
	initial: RawReplayProgress,
): Promise<RawReplayProgress> => {
	let current = initial
	let progress = copyProgressFor(current, table.name)
	let fetchRows = Math.min(table.batchRows, INITIAL_FETCH_ROWS)
	const columnList = columns.map((column) => identifier(column.name)).join(", ")
	const hashExpression = `cityHash64(toString(tuple(${columnList})))`
	const tieBreakExpression = `sipHash64(toString(tuple(${columnList})))`
	const timeNs = nsExpression(identifier(table.timeColumn))
	while (true) {
		if (progress.duplicateCount > 0 && !progress.duplicateGroupExhausted) {
			const groupCount = await duplicateGroupCount(context, table, columns, progress)
			if (progress.duplicateCount >= groupCount) {
				progress = { ...progress, duplicateGroupExhausted: true }
				current = { ...current, copied: { ...current.copied, [table.name]: progress } }
				await context.saveStep({ progress: current })
				continue
			}
		}
		const continuation = duplicateCursorContinuation(progress)
		// The cursor triple and the SELECTed __maple_* aliases are toString()'d
		// UInt64s (chDB emits 64-bit ints as JSON numbers; JS rounding above 2^53
		// once turned a rounded-down hash cursor into an infinite re-copy loop).
		// ORDER BY stays on the raw numeric expressions — ordering the string
		// aliases would sort lexicographically and diverge from the cursor.
		const cursor =
			progress.lastTimestamp === null || progress.lastHash === null || progress.lastTieBreak === null
				? ""
				: `AND (${timeNs} > ${uint64Literal(progress.lastTimestamp, "lastTimestamp")} OR (${timeNs} = ${uint64Literal(progress.lastTimestamp, "lastTimestamp")} AND (${hashExpression} > ${uint64Literal(progress.lastHash, "lastHash")} OR (${hashExpression} = ${uint64Literal(progress.lastHash, "lastHash")} AND ${tieBreakExpression} ${continuation.comparison} ${uint64Literal(progress.lastTieBreak, "lastTieBreak")}))))`
		const offset = continuation.offset === 0 ? "" : ` OFFSET ${continuation.offset}`
		const output = await querySource(
			context,
			`SELECT ${columnList}, toString(${timeNs}) AS __maple_timestamp, toString(${hashExpression}) AS __maple_hash, toString(${tieBreakExpression}) AS __maple_tie_break FROM ${identifier(table.name)} WHERE ${identifier(table.timeColumn)} >= ${timestampLiteral(retentionStartAt(context.cutoffAt, table.retentionDays))} AND ${identifier(table.timeColumn)} <= ${timestampLiteral(context.cutoffAt)} ${cursor} ORDER BY ${timeNs}, ${hashExpression}, ${tieBreakExpression} LIMIT ${fetchRows}${offset} ${EXACT_INT64_SETTINGS}`,
		)
		const rawRows = decodeJsonObjectRows(output)
		fetchRows = nextFetchRowLimit(table, rawRows.length, Buffer.byteLength(output))
		let rows = rawRows
		if (rows.length === 0) break
		const candidates = rows.map((row) => {
			const copy = { ...row }
			delete copy.__maple_timestamp
			delete copy.__maple_hash
			delete copy.__maple_tie_break
			return { row, copy, encoded: JSON.stringify(copy) }
		})
		const selected: typeof candidates = []
		let byteLength = 0
		for (const candidate of candidates) {
			const candidateBytes = Buffer.byteLength(candidate.encoded)
			if (selected.length > 0 && byteLength + candidateBytes + 1 > table.batchBytes) break
			selected.push(candidate)
			byteLength += candidateBytes + (selected.length === 1 ? 0 : 1)
		}
		if (selected.length === 0) throw new Error(`could not form a bounded batch for ${table.name}`)
		rows = selected.map((candidate) => candidate.row)
		const payload = selected.map((candidate) => candidate.copy)
		const first = rows[0]!
		const last = rows[rows.length - 1]!
		const lastKey = keyOf(last)
		const selectedLastKeyCount = rows.filter((row) => keyOf(row) === lastKey).length
		const priorKey =
			progress.lastTimestamp === null || progress.lastHash === null || progress.lastTieBreak === null
				? null
				: `${progress.lastTimestamp}\0${progress.lastHash}\0${progress.lastTieBreak}`
		const { duplicateCount: lastKeyCount, duplicateGroupExhausted: lastKeyExhausted } =
			advanceDuplicateKeyProgress(progress, priorKey, lastKey, selectedLastKeyCount)
		const pending: PendingBatch = {
			table: table.name,
			rowCount: payload.length,
			byteLength,
			firstTimestamp: first.__maple_timestamp === undefined ? null : String(first.__maple_timestamp),
			firstHash: first.__maple_hash === undefined ? null : String(first.__maple_hash),
			firstTieBreak: first.__maple_tie_break === undefined ? null : String(first.__maple_tie_break),
			lastTimestamp: last.__maple_timestamp === undefined ? null : String(last.__maple_timestamp),
			lastHash: last.__maple_hash === undefined ? null : String(last.__maple_hash),
			lastTieBreak: last.__maple_tie_break === undefined ? null : String(last.__maple_tie_break),
			lastKeyCount,
			lastKeyExhausted,
			signature: batchSignature(table.name, payload),
		}
		current = { ...current, pendingBatch: pending }
		await context.saveStep({ progress: current })
		await executeTarget(
			context,
			`INSERT INTO ${identifier(table.name)} (${columnList}) FORMAT JSONEachRow\n${selected.map((candidate) => candidate.encoded).join("\n")}`,
		)
		progress = {
			rows: progress.rows + payload.length,
			bytes: progress.bytes + byteLength,
			lastTimestamp: pending.lastTimestamp,
			lastHash: pending.lastHash,
			lastTieBreak: pending.lastTieBreak,
			duplicateCount: pending.lastKeyCount,
			duplicateGroupExhausted: pending.lastKeyExhausted,
		}
		current = {
			...current,
			copied: { ...current.copied, [table.name]: progress },
			pendingBatch: undefined,
		}
		await context.saveStep({ progress: current })
	}
	return current
}

const recoverPendingBatch = async (
	context: MigrationModuleContext,
	progress: RawReplayProgress,
): Promise<RawReplayProgress> => {
	const pending = progress.pendingBatch
	if (!pending) return progress
	const table = LEGACY_RAW_TABLES.find((candidate) => candidate.name === pending.table)
	if (!table) throw new Error(`journal contains an unknown pending table: ${pending.table}`)
	const columns = await ensureSourceTargetColumns(context, table)
	const current = await inventory(context, "target", table, columns, context.cutoffAt)
	const previous = copyProgressFor(progress, table.name)
	const targetRows = Number(current.rowCount)
	if (targetRows === previous.rows) return { ...progress, pendingBatch: undefined }
	if (targetRows === previous.rows + pending.rowCount) {
		const columnList = columns.map((column) => identifier(column.name)).join(", ")
		const hashExpression = `cityHash64(toString(tuple(${columnList})))`
		const tieBreakExpression = `sipHash64(toString(tuple(${columnList})))`
		const timeNs = nsExpression(identifier(table.timeColumn))
		const continuation = duplicateCursorContinuation(previous)
		const cursor =
			previous.lastTimestamp === null || previous.lastHash === null || previous.lastTieBreak === null
				? ""
				: `AND (${timeNs} > ${uint64Literal(previous.lastTimestamp, "lastTimestamp")} OR (${timeNs} = ${uint64Literal(previous.lastTimestamp, "lastTimestamp")} AND (${hashExpression} > ${uint64Literal(previous.lastHash, "lastHash")} OR (${hashExpression} = ${uint64Literal(previous.lastHash, "lastHash")} AND ${tieBreakExpression} ${continuation.comparison} ${uint64Literal(previous.lastTieBreak, "lastTieBreak")}))))`
		const offset = continuation.offset === 0 ? "" : ` OFFSET ${continuation.offset}`
		const inserted = decodeJsonObjectRows(
			await queryTarget(
				context,
				// Same quoted-64-bit output as the source SELECT: the recovered batch
				// signature is computed over the re-encoded rows and must match byte
				// for byte.
				`SELECT ${columnList}, toString(${timeNs}) AS __maple_timestamp, toString(${hashExpression}) AS __maple_hash, toString(${tieBreakExpression}) AS __maple_tie_break FROM ${identifier(table.name)} WHERE ${identifier(table.timeColumn)} >= ${timestampLiteral(retentionStartAt(context.cutoffAt, table.retentionDays))} AND ${identifier(table.timeColumn)} <= ${timestampLiteral(context.cutoffAt)} ${cursor} ORDER BY ${timeNs}, ${hashExpression}, ${tieBreakExpression} LIMIT ${pending.rowCount}${offset} ${EXACT_INT64_SETTINGS}`,
			),
		)
		if (inserted.length !== pending.rowCount)
			throw new Error("pending migration batch row count changed while recovering; refusing to guess")
		const payload = inserted.map((row) => {
			const copy = { ...row }
			delete copy.__maple_timestamp
			delete copy.__maple_hash
			delete copy.__maple_tie_break
			return copy
		})
		const first = inserted[0]!
		const last = inserted[inserted.length - 1]!
		const firstKey = keyOf(first)
		const lastKey = keyOf(last)
		const expectedFirstKey = `${pending.firstTimestamp ?? ""}\0${pending.firstHash ?? ""}\0${pending.firstTieBreak ?? ""}`
		const expectedLastKey = `${pending.lastTimestamp ?? ""}\0${pending.lastHash ?? ""}\0${pending.lastTieBreak ?? ""}`
		if (firstKey !== expectedFirstKey || lastKey !== expectedLastKey)
			throw new Error("pending migration batch key range changed while recovering; refusing to guess")
		if (batchSignature(table.name, payload) !== pending.signature)
			throw new Error("pending migration batch signature does not match target rows; refusing to guess")
		return {
			...progress,
			copied: {
				...progress.copied,
				[table.name]: {
					rows: previous.rows + pending.rowCount,
					bytes: previous.bytes + pending.byteLength,
					lastTimestamp: pending.lastTimestamp,
					lastHash: pending.lastHash,
					lastTieBreak: pending.lastTieBreak,
					duplicateCount: pending.lastKeyCount,
					duplicateGroupExhausted: pending.lastKeyExhausted,
				},
			},
			pendingBatch: undefined,
		}
	}
	throw new Error("pending migration batch has ambiguous target state; refusing to guess or duplicate rows")
}

const derivedDisposition = (name: string): StateDispositionEntry => ({
	name,
	classification: "derived",
	disposition: "rebuild-within-retention-horizon",
	preservationInterval:
		"within the retention horizon of the raw source tables; older aggregate-only rows remain under legacy semantics",
	guarantee:
		"recomputed from retained raw telemetry; aggregate-only history stays with the retained legacy source and is not given a fabricated new dimension",
})

const knownDispositions: ReadonlyArray<StateDispositionEntry> = [
	...LEGACY_RAW_TABLES.map((table) => ({
		name: table.name,
		classification: "authoritative" as const,
		disposition: "preserve-exact" as const,
		preservationInterval: `[cutoff - ${table.retentionDays} days, cutoff]`,
		sourceRetentionDays: table.retentionDays,
		targetRetentionDays: table.retentionDays,
		guarantee:
			"all source columns and rows inside this table's configured retention horizon are copied explicitly after exact type compatibility checks; rows older than the interval remain in the retained source",
	})),
	...["alert_checks", "session_events", "session_replay_events", "session_replays"].map((name) => ({
		name,
		classification: "operational" as const,
		disposition: "retain-as-legacy-rollback-only" as const,
		preservationInterval: "entire retained source store",
		guarantee:
			"not copied into the new target; the old store remains available for rollback and inspection",
	})),
	...[...LOCAL_SCHEMA_V1_MANIFEST.objects]
		.filter(
			(object) =>
				!RAW_TABLE_NAMES.has(object.name) &&
				!OPERATIONAL_TABLE_NAMES.has(object.name) &&
				object.kind === "table",
		)
		.map((object) => derivedDisposition(object.name)),
	...[...LOCAL_SCHEMA_V1_MANIFEST.objects]
		.filter((object) => object.kind !== "table")
		.map((object) => ({
			name: object.name,
			classification: "derived" as const,
			disposition: "rebuild-complete" as const,
			preservationInterval:
				"within the retention horizon of the raw source tables; older aggregate-only rows remain under legacy semantics",
			guarantee: "recreated by the v1 target schema and repopulated by retained raw replay",
		})),
	{
		name: "checkpoint tree",
		classification: "operational",
		disposition: "retain-as-legacy-rollback-only",
		preservationInterval: "entire retained checkpoint tree",
		guarantee:
			"moves with the retained source; current-schema restore does not claim these fingerprint-bound checkpoints are compatible",
	},
	{
		name: "archive manifests and calibration",
		classification: "operational",
		disposition: "preserve-exact",
		preservationInterval: "external archive root",
		guarantee:
			"the external ~/.maple/archive tree is not rewritten by local-store migration; its own schema and fingerprint checks remain authoritative",
	},
	{
		name: "source marker and store identity",
		classification: "operational",
		disposition: "retain-as-legacy-rollback-only",
		preservationInterval: "pre-cutover source",
		guarantee: "the source marker and stable store id are retained beside the rollback directory",
	},
	{
		name: "active-store selection",
		classification: "operational",
		disposition: "preserve-exact",
		preservationInterval: "promotion commit",
		guarantee:
			"the configured data path remains the active path; selection changes only after target verification and the promotion journal is durable",
	},
	{
		name: "open sentinel, PID, and maintenance lock",
		classification: "ephemeral",
		disposition: "invalidate",
		preservationInterval: "migration operation",
		guarantee:
			"the source must be stopped and clean; no live-process or open-sentinel state is copied to the target, and the shared lock is released normally",
	},
	{
		name: "migration journal",
		classification: "operational",
		disposition: "preserve-exact",
		preservationInterval: "planned through promoted",
		guarantee:
			"durably records identities, cutoff, current module step, typed module state, progress, verification, and promotion recovery state",
	},
] as const

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "preflight",
		description:
			"Validate the stopped source, chDB identity, raw-table columns, capacity, and migration cutoff",
		requiresQuiescence: true,
		phase: "preflight-complete",
	},
	{
		id: "bootstrap-target",
		description: "Create a fresh v1-schema target and mark it staged",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "replay-raw-telemetry",
		description: "Copy the six authoritative raw tables with bounded, resumable JSONEachRow batches",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-and-promote",
		description:
			"Recheck source inventories, verify the v1 physical schema, then promote and retain the source",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const legacyPreflight = async (context: MigrationModuleContext): Promise<LegacyModuleState> => {
	await context.ensureCapacity()
	await assertKnownSourceObjects(context)
	for (const table of LEGACY_RAW_TABLES) {
		if (!(await tableExists(context, "source", table.name)))
			throw new Error(`source authoritative table is missing: ${table.name}`)
	}
	return { module: "local-0000-to-0001-raw-replay", version: 1 } as const
}

const decodeLegacyState = strictDecoder(LegacyStateSchema)

const decodeLegacyProgress = (value: unknown): RawReplayProgress | undefined =>
	value === undefined ? undefined : decodeRawReplayProgress(value)

const legacyPrepareTarget = async (
	context: MigrationModuleContext,
	state: LegacyModuleState,
): Promise<LegacyModuleState> => {
	await context.openTarget((db) => assertPhysicalSchema(db, LOCAL_SCHEMA_V1_MANIFEST), {
		schemaSql: LOCAL_SCHEMA_V1_SQL,
		bootstrapSchema: true,
	})
	return state
}

const legacyApply = async (
	context: MigrationModuleContext,
	_state: LegacyModuleState,
	progressValue: RawReplayProgress | undefined,
): Promise<RawReplayProgress> => {
	let progress = asProgress(progressValue)
	for (const table of LEGACY_RAW_TABLES) {
		const columns = await ensureSourceTargetColumns(context, table)
		if (!progress.sourceInventory[table.name]) {
			progress = {
				...progress,
				sourceInventory: {
					...progress.sourceInventory,
					[table.name]: await inventory(context, "source", table, columns, context.cutoffAt),
				},
			}
			await context.saveStep({ progress })
		}
		progress = await copyTable(context, table, columns, progress)
	}
	return progress
}

const legacyVerify = async (
	context: MigrationModuleContext,
	_state: LegacyModuleState,
	progressValue: RawReplayProgress,
): Promise<void> => {
	const progress = asProgress(progressValue)
	for (const table of LEGACY_RAW_TABLES) {
		const columns = await tableColumns(context, "source", table.name)
		const before = progress.sourceInventory[table.name]
		if (!before) throw new Error(`source inventory is missing for ${table.name}`)
		const after = await inventory(context, "source", table, columns, context.cutoffAt)
		if (!inventoriesEqual(before, after))
			throw new Error(`source changed during migration: ${table.name}; promotion refused`)
		const targetInventory = await inventory(context, "target", table, columns, context.cutoffAt)
		if (!inventoriesEqual(before, targetInventory))
			throw new Error(`target verification failed for ${table.name}`)
		if ((await tableTotalRowCount(context, "target", table.name)) !== targetInventory.rowCount)
			throw new Error(`target contains rows outside the migration interval for ${table.name}`)
	}
	await context.openTarget((db) => assertPhysicalSchema(db, LOCAL_SCHEMA_V1_MANIFEST), {
		schemaSql: LOCAL_SCHEMA_V1_SQL,
		bootstrapSchema: false,
	})
}

const legacyRecover = async (
	context: MigrationModuleContext,
	state: LegacyModuleState | undefined,
	progressValue: RawReplayProgress | undefined,
): Promise<{ readonly state?: LegacyModuleState; readonly progress?: RawReplayProgress }> => ({
	state,
	progress: await recoverPendingBatch(context, asProgress(progressValue)),
})

export const legacyToCurrentModule: LocalStoreMigrationModule<LegacyModuleState, RawReplayProgress> = {
	id: "local-0000-to-0001-raw-replay",
	moduleVersion: 1,
	description: "Rebuild the v1 local store from the known fingerprint-only legacy store",
	from: LEGACY_LOCAL_SCHEMA,
	to: LOCAL_SCHEMA_V1,
	operations,
	dispositions: knownDispositions,
	decodeState: decodeLegacyState,
	decodeProgress: decodeLegacyProgress,
	preflight: legacyPreflight,
	prepareTarget: legacyPrepareTarget,
	apply: legacyApply,
	verify: legacyVerify,
	recover: legacyRecover,
}

/** Internal seams exported for regression tests only. */
export const __testables = { copyTable }
