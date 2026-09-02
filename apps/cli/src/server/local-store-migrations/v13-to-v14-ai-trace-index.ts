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
	LOCAL_SCHEMA_V13,
	LOCAL_SCHEMA_V13_MANIFEST,
	LOCAL_SCHEMA_V13_SQL,
	LOCAL_SCHEMA_V14,
	LOCAL_SCHEMA_V14_MANIFEST,
	LOCAL_SCHEMA_V14_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

const RAW_TABLES = RAW_TELEMETRY_TTL_COLUMNS.map(([table]) => table)

const MODULE_ID = "local-0013-to-0014-ai-trace-index" as const

/**
 * The local mirror of ClickHouse migration 0024.
 *
 * v14 adds `ai_trace_index` — the filtered projection of GenAI agent spans
 * (`maple_ai.vendor.id` stamped) that Agent Sessions detection and facets read
 * instead of scanning raw `traces` — and `ai_trace_index_mv`, which fills it
 * forward. Both objects are NEW: no existing table is altered, no view is
 * recreated, and no row moves. The whole edge is therefore the v14 bootstrap
 * itself (`CREATE TABLE IF NOT EXISTS` + `CREATE MATERIALIZED VIEW IF NOT
 * EXISTS` against a store that has neither) plus a verify.
 *
 * NOTHING IS BACKFILLED, exactly as in 0024: a materialized view sees inserts
 * from creation forward, so windows predating this edge under-report on the
 * Agent Sessions surfaces until raw `traces`' retention ages the gap out. The
 * managed side accepts the same gap for the same reason.
 *
 * Every statement is idempotent, so a resume after a crash lands in the same
 * place.
 */

interface V13ToV14State {
	readonly module: typeof MODULE_ID
	readonly version: 1
	readonly rawRows: Readonly<Record<string, string>>
	readonly retentionDays?: number
}

interface V13ToV14Progress {
	readonly installed: true
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value)

const decodeCounts = (value: unknown): Readonly<Record<string, string>> => {
	if (!isRecord(value)) throw new Error("v13 -> v14 rawRows must be an object")
	const counts: Record<string, string> = {}
	for (const table of RAW_TABLES) {
		const count = value[table]
		if (!isCount(count)) throw new Error(`v13 -> v14 rawRows.${table} must be an unsigned decimal string`)
		counts[table] = count
	}
	if (Object.keys(value).some((table) => !RAW_TABLES.includes(table as (typeof RAW_TABLES)[number])))
		throw new Error("v13 -> v14 rawRows contains an unknown table")
	return counts
}

const decodeState = (value: unknown): V13ToV14State => {
	if (!isRecord(value)) throw new Error("v13 -> v14 state must be an object")
	const allowed = new Set(["module", "version", "rawRows", "retentionDays"])
	if (Object.keys(value).some((key) => !allowed.has(key)))
		throw new Error("v13 -> v14 state contains an unknown field")
	if (value.module !== MODULE_ID || value.version !== 1)
		throw new Error("v13 -> v14 state has an unsupported module or version")
	if (
		value.retentionDays !== undefined &&
		(typeof value.retentionDays !== "number" || !Number.isSafeInteger(value.retentionDays))
	)
		throw new Error("v13 -> v14 retentionDays must be an integer")
	return {
		module: MODULE_ID,
		version: 1,
		rawRows: decodeCounts(value.rawRows),
		...(!(value.retentionDays === undefined) ? { retentionDays: value.retentionDays } : undefined),
	}
}

const decodeProgress = (value: unknown): V13ToV14Progress | undefined => {
	if (value === undefined) return undefined
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "installed") || value.installed !== true)
		throw new Error("v13 -> v14 progress is invalid")
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

const expectedManifest = (manifest: typeof LOCAL_SCHEMA_V13_MANIFEST, retentionDays: number | undefined) =>
	retentionDays === undefined
		? manifest
		: withRawTelemetryRetentionFloor(manifest, RAW_TABLES, retentionDays)

const preflight = async (context: MigrationModuleContext): Promise<V13ToV14State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const rawRows = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V13_MANIFEST, retentionDays))
			return rawRowCounts(db)
		},
		{ schemaSql: LOCAL_SCHEMA_V13_SQL, bootstrapSchema: false },
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
	state: V13ToV14State,
): Promise<V13ToV14State> => {
	await context.closeStores()
	const source = resolve(context.sourceDataDir)
	const target = resolve(context.targetDataDir)
	if (source !== target) {
		await cloneStoreForStaging(source, target)
	}
	return state
}

/**
 * Unlike the column-adding edges, there is nothing to do in a pre-bootstrap
 * block: `ai_trace_index` and `ai_trace_index_mv` do not exist in a v13 store,
 * so the v14 bootstrap's `IF NOT EXISTS` CREATEs are exactly the DDL this edge
 * needs — and no existing view's SELECT changes, so nothing is dropped.
 */
const apply = async (context: MigrationModuleContext): Promise<V13ToV14Progress> =>
	context.openTarget(() => ({ installed: true }) as const, {
		schemaSql: LOCAL_SCHEMA_V14_SQL,
		bootstrapSchema: true,
	})

const verify = async (
	context: MigrationModuleContext,
	state: V13ToV14State,
	_progress: V13ToV14Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V14_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new Error(`v13 -> v14 raw telemetry verification failed for ${table}`)
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V14_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v13-store",
		description: "Clone the stopped v13 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "create-ai-trace-index",
		description:
			"Create ai_trace_index and ai_trace_index_mv via the v14 bootstrap (both new, IF NOT EXISTS)",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v14-schema",
		description: "Verify the v14 physical schema and the retained raw telemetry counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v13 store is cloned byte-for-byte before any DDL runs.",
	},
	{
		// Created empty, filled forward by its view: rows already in `traces` are
		// not re-projected, so Agent Sessions detection under-reports windows that
		// predate this edge until raw retention ages them out.
		name: "ai_trace_index",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"The projection accrues for spans ingested after the migration; older agent spans stay in raw traces but are invisible to detection until they age out.",
		preservationInterval: "from the migration forward",
		sourceRetentionDays: 30,
		targetRetentionDays: 30,
	},
]

export const v13ToV14AiTraceIndexModule: LocalStoreMigrationModule<V13ToV14State, V13ToV14Progress> = {
	id: MODULE_ID,
	moduleVersion: 1,
	description:
		"Create ai_trace_index and its materialized view so Agent Sessions detection reads a filtered projection instead of scanning raw traces",
	from: LOCAL_SCHEMA_V13,
	to: LOCAL_SCHEMA_V14,
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
