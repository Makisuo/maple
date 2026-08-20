// SAFETY-FILE: JSON rows here come from fixed internal formats and are validated before domain use.
import { cp, mkdir, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { RAW_TELEMETRY_TTL_COLUMNS, readRawTelemetryRetentionDays, type Chdb } from "../chdb"
import type {
	LocalStoreMigrationModule,
	MigrationModuleContext,
	MigrationOperation,
	StateDispositionEntry,
} from "../local-store-migration-module"
import { withRawTelemetryRetentionFloor } from "../schema-manifest"
import {
	LOCAL_SCHEMA_V7,
	LOCAL_SCHEMA_V7_MANIFEST,
	LOCAL_SCHEMA_V7_SQL,
	LOCAL_SCHEMA_V8,
	LOCAL_SCHEMA_V8_MANIFEST,
	LOCAL_SCHEMA_V8_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

const RAW_TABLES = RAW_TELEMETRY_TTL_COLUMNS.map(([table]) => table)

interface V7ToV8State {
	readonly module: "local-0007-to-0008-apple-crash-frames"
	readonly version: 1
	readonly rawRows: Readonly<Record<string, string>>
	readonly retentionDays?: number
}

interface V7ToV8Progress {
	readonly installed: true
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const decodeCounts = (value: unknown): Readonly<Record<string, string>> => {
	if (!isRecord(value)) throw new Error("v7 -> v8 rawRows must be an object")
	const counts: Record<string, string> = {}
	for (const table of RAW_TABLES) {
		const count = value[table]
		if (typeof count !== "string" || !/^\d+$/.test(count))
			throw new Error(`v7 -> v8 rawRows.${table} must be an unsigned decimal string`)
		counts[table] = count
	}
	if (Object.keys(value).some((table) => !RAW_TABLES.includes(table as (typeof RAW_TABLES)[number])))
		throw new Error("v7 -> v8 rawRows contains an unknown table")
	return counts
}

const decodeState = (value: unknown): V7ToV8State => {
	if (!isRecord(value)) throw new Error("v7 -> v8 state must be an object")
	const allowed = new Set(["module", "version", "rawRows", "retentionDays"])
	if (Object.keys(value).some((key) => !allowed.has(key)))
		throw new Error("v7 -> v8 state contains an unknown field")
	if (value.module !== "local-0007-to-0008-apple-crash-frames" || value.version !== 1)
		throw new Error("v7 -> v8 state has an unsupported module or version")
	if (
		value.retentionDays !== undefined &&
		(typeof value.retentionDays !== "number" || !Number.isSafeInteger(value.retentionDays))
	)
		throw new Error("v7 -> v8 retentionDays must be an integer")
	return {
		module: "local-0007-to-0008-apple-crash-frames",
		version: 1,
		rawRows: decodeCounts(value.rawRows),
		...(!(value.retentionDays === undefined) ? { retentionDays: value.retentionDays } : undefined),
	}
}

const decodeProgress = (value: unknown): V7ToV8Progress | undefined => {
	if (value === undefined) return undefined
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "installed") || value.installed !== true)
		throw new Error("v7 -> v8 progress is invalid")
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

const expectedManifest = (manifest: typeof LOCAL_SCHEMA_V7_MANIFEST, retentionDays: number | undefined) =>
	retentionDays === undefined
		? manifest
		: withRawTelemetryRetentionFloor(manifest, RAW_TABLES, retentionDays)

const preflight = async (context: MigrationModuleContext): Promise<V7ToV8State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const rawRows = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V7_MANIFEST, retentionDays))
			return rawRowCounts(db)
		},
		{ schemaSql: LOCAL_SCHEMA_V7_SQL, bootstrapSchema: false },
	)
	return {
		module: "local-0007-to-0008-apple-crash-frames",
		version: 1,
		rawRows,
		...(!(retentionDays === undefined) ? { retentionDays } : undefined),
	}
}

const prepareTarget = async (context: MigrationModuleContext, state: V7ToV8State): Promise<V7ToV8State> => {
	await context.closeStores()
	const source = resolve(context.sourceDataDir)
	const target = resolve(context.targetDataDir)
	if (source !== target) {
		await rm(target, { recursive: true, force: true })
		await mkdir(dirname(target), { recursive: true, mode: 0o700 })
		await cp(source, target, { recursive: true, preserveTimestamps: true })
	}
	return state
}

/**
 * Like v5 -> v6, this edge replaces the body of two existing views rather than
 * adding anything. A materialized view's SELECT is frozen at creation and the
 * bundled DDL uses `CREATE ... IF NOT EXISTS`, so both views must be dropped
 * before the v8 schema can install its versions. Dropping a view never touches
 * rows already in its target table.
 *
 * The new body adds an Apple alternative to the fingerprint's frame matcher.
 * Before it, no frame of an iOS crash matched any alternative, so `_fpFrames`
 * was empty and the hash fell through to the message signature — which redacts
 * hex and long digit runs, collapsing every crash of an exception type in a
 * service into a single issue.
 *
 * Historical `error_events` / `error_events_by_time` rows are left exactly as
 * they are: recomputing FingerprintHash would re-bucket every existing local
 * issue. Forward-only, converging as the retention window rolls, and matching
 * what a deployed cluster gets from ClickHouse migration 0018.
 */
const apply = async (context: MigrationModuleContext): Promise<V7ToV8Progress> => {
	await context.openTarget(
		(db) => {
			db.exec("DROP TABLE IF EXISTS error_events_mv")
			db.exec("DROP TABLE IF EXISTS error_events_by_time_mv")
		},
		{ schemaSql: LOCAL_SCHEMA_V7_SQL, bootstrapSchema: false },
	)
	return context.openTarget(() => ({ installed: true }), {
		schemaSql: LOCAL_SCHEMA_V8_SQL,
		bootstrapSchema: true,
	})
}

const verify = async (
	context: MigrationModuleContext,
	state: V7ToV8State,
	_progress: V7ToV8Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V8_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new Error(`v7 -> v8 raw telemetry verification failed for ${table}`)
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V8_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v7-store",
		description: "Clone the stopped v7 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "rebuild-error-events-views",
		description: "Drop and recreate the error-events views with Apple crash frames in the fingerprint",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v8-schema",
		description: "Verify the v8 physical schema and retained raw telemetry counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v7 store is cloned byte-for-byte before the views are replaced.",
	},
	{
		name: "traces",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee:
			"The source of the replaced views is neither read nor rewritten; only the view definitions change.",
	},
	{
		// Rows already materialized keep their collapsed iOS fingerprint —
		// recomputing hashes would re-bucket every existing issue. Forward-only,
		// and bounded by the tables' 90-day TTL.
		name: "error_events",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Existing rows are preserved untouched; the Apple frame matching applies to events materialized after the migration and converges as the retention window rolls.",
		preservationInterval: "error retention horizon",
		sourceRetentionDays: 90,
		targetRetentionDays: 90,
	},
	{
		name: "error_events_by_time",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Same projection as error_events and treated identically: preserved rows, forward-only correction.",
		preservationInterval: "error retention horizon",
		sourceRetentionDays: 90,
		targetRetentionDays: 90,
	},
]

export const v7ToV8AppleCrashFramesModule: LocalStoreMigrationModule<V7ToV8State, V7ToV8Progress> = {
	id: "local-0007-to-0008-apple-crash-frames",
	moduleVersion: 1,
	description: "Rebuild the error-events views so the fingerprint recognises Apple crash frames",
	from: LOCAL_SCHEMA_V7,
	to: LOCAL_SCHEMA_V8,
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
