// SAFETY-FILE: JSON rows here come from fixed internal formats and are validated before domain use.
import { cloneStoreForStaging } from "./journal-codecs"
import { resolve } from "node:path"
import { RAW_TELEMETRY_TTL_COLUMNS, readRawTelemetryRetentionDays, type Chdb } from "../chdb"
import type {
	LocalStoreMigrationModule,
	MigrationModuleContext,
	MigrationOperation,
	StateDispositionEntry,
} from "../local-store-migration-module"
import { withRawTelemetryRetentionFloor } from "../schema-manifest"
import {
	LOCAL_SCHEMA_V15,
	LOCAL_SCHEMA_V15_MANIFEST,
	LOCAL_SCHEMA_V15_SQL,
	LOCAL_SCHEMA_V16,
	LOCAL_SCHEMA_V16_MANIFEST,
	LOCAL_SCHEMA_V16_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

const RAW_TABLES = RAW_TELEMETRY_TTL_COLUMNS.map(([table]) => table)

const MODULE_ID = "local-0015-to-0016-ai-trace-index-filter-columns" as const

/**
 * The local mirror of ClickHouse migration 0026.
 *
 * v16 widens `ai_trace_index` with the filter dimensions the Agent Sessions
 * sidebar offers beyond framework and service — `DeploymentEnv`, `Model`,
 * `AgentName`, `ToolName` — and the per-span measures the page ranks and
 * filters on (`IsError`, `IsLlmCall`, `IsToolCall`, `Tokens`, `Cost`, with
 * `SpanId`/`ParentSpanId`/`Duration`), and recreates `ai_trace_index_mv` so it
 * fills them — every one a fact of the GenAI span, coalesced across dialects
 * by `@maple/domain`'s `gen-ai-columns`. No row moves and no table is rebuilt.
 *
 * Two things the bundled v16 DDL cannot do on its own, both done in a
 * pre-bootstrap block exactly as the v6 -> v7 edge did:
 *
 * 1. Widen the table. The DDL is `CREATE TABLE IF NOT EXISTS`, a no-op against
 *    the v14 table, so the explicit `ADD COLUMN IF NOT EXISTS` is what adds the
 *    columns — metadata-only, defaulting every existing row to `''`.
 * 2. Replace the view. A materialized view's SELECT is frozen at creation, so
 *    the v14 view is dropped first or it simply survives the bootstrap's
 *    `IF NOT EXISTS`. chDB materializes views as tables, hence `DROP TABLE`.
 *
 * NOTHING IS BACKFILLED, as in 0026: rows materialized under v15 keep `''`
 * and 0 in the new columns, which the facets drop, the filters never match and
 * the sums count as nothing. Those sessions are still detected and listed —
 * sliceable by framework and service, invisible under any model, agent, tool
 * or environment, and ranked as if free — until raw `traces`' retention ages
 * them out. The managed side accepts the same gap.
 *
 * Every statement is idempotent, so a resume after a crash lands in the same
 * place.
 */

/** Columns v16 adds to `ai_trace_index`, with the type the v16 DDL declares. */
const FILTER_COLUMNS = [
	["DeploymentEnv", "LowCardinality(String)"],
	["Model", "LowCardinality(String)"],
	["AgentName", "LowCardinality(String)"],
	["ToolName", "LowCardinality(String)"],
	["SpanId", "String"],
	["ParentSpanId", "String"],
	["Duration", "UInt64"],
	["IsError", "UInt8"],
	["IsLlmCall", "UInt8"],
	["IsToolCall", "UInt8"],
	["Tokens", "Float64"],
	["Cost", "Float64"],
] as const

interface V15ToV16State {
	readonly module: typeof MODULE_ID
	readonly version: 1
	readonly rawRows: Readonly<Record<string, string>>
	readonly retentionDays?: number
}

interface V15ToV16Progress {
	readonly installed: true
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value)

const decodeCounts = (value: unknown): Readonly<Record<string, string>> => {
	if (!isRecord(value)) throw new Error("v15 -> v16 rawRows must be an object")
	const counts: Record<string, string> = {}
	for (const table of RAW_TABLES) {
		const count = value[table]
		if (!isCount(count)) throw new Error(`v15 -> v16 rawRows.${table} must be an unsigned decimal string`)
		counts[table] = count
	}
	if (Object.keys(value).some((table) => !RAW_TABLES.includes(table as (typeof RAW_TABLES)[number])))
		throw new Error("v15 -> v16 rawRows contains an unknown table")
	return counts
}

const decodeState = (value: unknown): V15ToV16State => {
	if (!isRecord(value)) throw new Error("v15 -> v16 state must be an object")
	const allowed = new Set(["module", "version", "rawRows", "retentionDays"])
	if (Object.keys(value).some((key) => !allowed.has(key)))
		throw new Error("v15 -> v16 state contains an unknown field")
	if (value.module !== MODULE_ID || value.version !== 1)
		throw new Error("v15 -> v16 state has an unsupported module or version")
	if (
		value.retentionDays !== undefined &&
		(typeof value.retentionDays !== "number" || !Number.isSafeInteger(value.retentionDays))
	)
		throw new Error("v15 -> v16 retentionDays must be an integer")
	return {
		module: MODULE_ID,
		version: 1,
		rawRows: decodeCounts(value.rawRows),
		...(!(value.retentionDays === undefined) ? { retentionDays: value.retentionDays } : undefined),
	}
}

const decodeProgress = (value: unknown): V15ToV16Progress | undefined => {
	if (value === undefined) return undefined
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "installed") || value.installed !== true)
		throw new Error("v15 -> v16 progress is invalid")
	return { installed: true }
}

const parseJsonEachRow = <A>(value: string): A[] =>
	value
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as A)

const rawRowCounts = (db: Chdb): Readonly<Record<string, string>> => {
	const quotedTables = RAW_TABLES.map((table) => `'${table}'`).join(", ")
	const rows = parseJsonEachRow<{ table: string; rowCount: string }>(
		db.query(
			`SELECT table, toString(sum(rows)) AS rowCount FROM system.parts WHERE database = 'default' AND active = 1 AND table IN (${quotedTables}) GROUP BY table`,
		),
	)
	const byTable = new Map(rows.map((row) => [row.table, row.rowCount]))
	return Object.fromEntries(RAW_TABLES.map((table) => [table, byTable.get(table) ?? "0"]))
}

const expectedManifest = (manifest: typeof LOCAL_SCHEMA_V15_MANIFEST, retentionDays: number | undefined) =>
	retentionDays === undefined
		? manifest
		: withRawTelemetryRetentionFloor(manifest, RAW_TABLES, retentionDays)

const preflight = async (context: MigrationModuleContext): Promise<V15ToV16State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const rawRows = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V15_MANIFEST, retentionDays))
			return rawRowCounts(db)
		},
		{ schemaSql: LOCAL_SCHEMA_V15_SQL, bootstrapSchema: false },
	)
	return {
		module: MODULE_ID,
		version: 1,
		rawRows,
		...(!(retentionDays === undefined) ? { retentionDays } : undefined),
	}
}

const prepareTarget = async (
	context: MigrationModuleContext,
	state: V15ToV16State,
): Promise<V15ToV16State> => {
	await context.closeStores()
	const source = resolve(context.sourceDataDir)
	const target = resolve(context.targetDataDir)
	if (source !== target) {
		await cloneStoreForStaging(source, target)
	}
	return state
}

const apply = async (context: MigrationModuleContext): Promise<V15ToV16Progress> => {
	await context.openTarget(
		(db) => {
			db.exec("DROP TABLE IF EXISTS ai_trace_index_mv")
			for (const [column, type] of FILTER_COLUMNS) {
				db.exec(`ALTER TABLE ai_trace_index ADD COLUMN IF NOT EXISTS ${column} ${type}`)
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V15_SQL, bootstrapSchema: false },
	)
	// The v16 bootstrap recreates the view with its new SELECT; every other
	// object already exists and its `IF NOT EXISTS` is a no-op.
	return context.openTarget(() => ({ installed: true }) as const, {
		schemaSql: LOCAL_SCHEMA_V16_SQL,
		bootstrapSchema: true,
	})
}

const verify = async (
	context: MigrationModuleContext,
	state: V15ToV16State,
	_progress: V15ToV16Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V16_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new Error(`v15 -> v16 raw telemetry verification failed for ${table}`)
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V16_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v15-store",
		description: "Clone the stopped v15 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "widen-ai-trace-index",
		description:
			"Add the filter dimensions and per-span measures to ai_trace_index and rebuild ai_trace_index_mv to fill them",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v16-schema",
		description: "Verify the v16 physical schema and the retained raw telemetry counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v15 store is cloned byte-for-byte before any DDL runs.",
	},
	{
		name: "traces",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee:
			"The source of the replaced view is neither read nor rewritten; only the view definition and the index's column list change.",
	},
	{
		// Existing rows are kept and read back with '' in the four new columns:
		// still detected and listed, filterable by framework and service, absent
		// from the model/agent/tool/environment facets. The MV fills the columns
		// for spans ingested after the edge. Forward-only, bounded by the 30-day
		// TTL, and the same gap the managed side accepts.
		name: "ai_trace_index",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Existing rows are preserved untouched with empty filter columns; the rebuilt view fills them for spans materialized after the migration and the gap closes as the retention window rolls.",
		preservationInterval: "from the migration forward",
		sourceRetentionDays: 30,
		targetRetentionDays: 30,
	},
]

export const v15ToV16AiTraceIndexFilterColumnsModule: LocalStoreMigrationModule<
	V15ToV16State,
	V15ToV16Progress
> = {
	id: MODULE_ID,
	moduleVersion: 1,
	description: "Add DeploymentEnv, Model, AgentName and ToolName to ai_trace_index and recreate its view",
	from: LOCAL_SCHEMA_V15,
	to: LOCAL_SCHEMA_V16,
	operations,
	dispositions,
	decodeState,
	decodeProgress,
	preflight,
	prepareTarget,
	apply,
	verify,
	recover: async (_context, state, progress) => ({ state, progress }),
}
