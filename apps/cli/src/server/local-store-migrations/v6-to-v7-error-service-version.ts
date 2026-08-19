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
	LOCAL_SCHEMA_V6,
	LOCAL_SCHEMA_V6_MANIFEST,
	LOCAL_SCHEMA_V6_SQL,
	LOCAL_SCHEMA_V7,
	LOCAL_SCHEMA_V7_MANIFEST,
	LOCAL_SCHEMA_V7_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

const RAW_TABLES = RAW_TELEMETRY_TTL_COLUMNS.map(([table]) => table)

/** Error-family views replaced by this edge, dropped before the v7 DDL runs. */
const ERROR_VIEWS = ["error_events_mv", "error_events_by_time_mv", "error_fingerprints_minutely_mv"] as const

/**
 * Columns gaining the emitting build, with the type the v7 DDL declares.
 * The per-occurrence tables carry one build per row; the minutely rollup is an
 * AggregatingMergeTree carrying the DISTINCT SET of builds seen in the minute,
 * so its column is both plural and a SimpleAggregateFunction.
 */
const SERVICE_VERSION_COLUMNS = [
	["error_events", "ServiceVersion", "LowCardinality(String)"],
	["error_events_by_time", "ServiceVersion", "LowCardinality(String)"],
	[
		"error_fingerprints_minutely",
		"ServiceVersions",
		"SimpleAggregateFunction(groupUniqArrayArray, Array(String))",
	],
] as const

interface V6ToV7State {
	readonly module: "local-0006-to-0007-error-service-version"
	readonly version: 1
	readonly rawRows: Readonly<Record<string, string>>
	readonly retentionDays?: number
}

interface V6ToV7Progress {
	readonly installed: true
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const decodeCounts = (value: unknown): Readonly<Record<string, string>> => {
	if (!isRecord(value)) throw new Error("v6 -> v7 rawRows must be an object")
	const counts: Record<string, string> = {}
	for (const table of RAW_TABLES) {
		const count = value[table]
		if (typeof count !== "string" || !/^\d+$/.test(count))
			throw new Error(`v6 -> v7 rawRows.${table} must be an unsigned decimal string`)
		counts[table] = count
	}
	if (Object.keys(value).some((table) => !RAW_TABLES.includes(table as (typeof RAW_TABLES)[number])))
		throw new Error("v6 -> v7 rawRows contains an unknown table")
	return counts
}

const decodeState = (value: unknown): V6ToV7State => {
	if (!isRecord(value)) throw new Error("v6 -> v7 state must be an object")
	const allowed = new Set(["module", "version", "rawRows", "retentionDays"])
	if (Object.keys(value).some((key) => !allowed.has(key)))
		throw new Error("v6 -> v7 state contains an unknown field")
	if (value.module !== "local-0006-to-0007-error-service-version" || value.version !== 1)
		throw new Error("v6 -> v7 state has an unsupported module or version")
	if (
		value.retentionDays !== undefined &&
		(typeof value.retentionDays !== "number" || !Number.isSafeInteger(value.retentionDays))
	)
		throw new Error("v6 -> v7 retentionDays must be an integer")
	return {
		module: "local-0006-to-0007-error-service-version",
		version: 1,
		rawRows: decodeCounts(value.rawRows),
		...(!(value.retentionDays === undefined) ? { retentionDays: value.retentionDays } : undefined),
	}
}

const decodeProgress = (value: unknown): V6ToV7Progress | undefined => {
	if (value === undefined) return undefined
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "installed") || value.installed !== true)
		throw new Error("v6 -> v7 progress is invalid")
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

const expectedManifest = (manifest: typeof LOCAL_SCHEMA_V6_MANIFEST, retentionDays: number | undefined) =>
	retentionDays === undefined
		? manifest
		: withRawTelemetryRetentionFloor(manifest, RAW_TABLES, retentionDays)

const preflight = async (context: MigrationModuleContext): Promise<V6ToV7State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const rawRows = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V6_MANIFEST, retentionDays))
			return rawRowCounts(db)
		},
		{ schemaSql: LOCAL_SCHEMA_V6_SQL, bootstrapSchema: false },
	)
	return {
		module: "local-0006-to-0007-error-service-version",
		version: 1,
		rawRows,
		...(!(retentionDays === undefined) ? { retentionDays } : undefined),
	}
}

const prepareTarget = async (context: MigrationModuleContext, state: V6ToV7State): Promise<V6ToV7State> => {
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
 * Two changes land together, both confined to the error-events family.
 *
 * 1. The emitting build is added to `error_events`, `error_events_by_time` and
 *    `error_fingerprints_minutely`. This is the one step the bundled DDL cannot
 *    perform on its own: it uses `CREATE TABLE IF NOT EXISTS`, which is a no-op
 *    against a table that already exists, so an existing store would keep the v6
 *    column list. The explicit `ADD COLUMN IF NOT EXISTS` is what actually
 *    widens it, and it is metadata-only — no part is rewritten and no row moves.
 *
 * 2. The three error views are dropped and recreated. A materialized view's
 *    SELECT is frozen at creation, so replacing the body requires a drop; same
 *    shape as v5 -> v6. Dropping a view never touches rows already in its target
 *    table.
 *
 * The new fingerprint (v2) matches stack frames by shape instead of by "contains
 * a colon-digit", which stops Drizzle `params:` lines and `Type: message`
 * headers being hashed as frames.
 *
 * Historical rows keep their v6 fingerprint and an empty build.
 * Recomputing hashes would re-bucket every existing local issue, and the stored
 * rows carry no resource attributes to recover the build from. Both effects are
 * forward-only and the stale rows age out with the tables' 90-day TTL — the same
 * outcome a deployed cluster gets, where the managed rollout also only applies
 * to newly materialized events.
 */
const apply = async (context: MigrationModuleContext): Promise<V6ToV7Progress> => {
	await context.openTarget(
		(db) => {
			for (const view of ERROR_VIEWS) db.exec(`DROP TABLE IF EXISTS ${view}`)
			for (const [table, column, type] of SERVICE_VERSION_COLUMNS) {
				db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`)
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V6_SQL, bootstrapSchema: false },
	)
	return context.openTarget(() => ({ installed: true }), {
		schemaSql: LOCAL_SCHEMA_V7_SQL,
		bootstrapSchema: true,
	})
}

const verify = async (
	context: MigrationModuleContext,
	state: V6ToV7State,
	_progress: V6ToV7Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V7_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new Error(`v6 -> v7 raw telemetry verification failed for ${table}`)
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V7_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v6-store",
		description: "Clone the stopped v6 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "widen-error-tables",
		description: "Add ServiceVersion to the error-events tables and rebuild the error-events views",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v7-schema",
		description: "Verify the v7 physical schema and retained raw telemetry counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v6 store is cloned byte-for-byte before any DDL runs.",
	},
	{
		name: "traces",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee:
			"The source of the replaced views is neither read nor rewritten; only the view definitions and the error tables' column list change.",
	},
	{
		// Existing rows keep their v6 fingerprint and an empty ServiceVersion.
		// Recomputing hashes would re-bucket every local issue, and the stored rows
		// carry no resource attributes to recover the build from. Forward-only, and
		// bounded by the tables' 90-day TTL.
		name: "error_events",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Existing rows are preserved untouched with an empty ServiceVersion; the v2 fingerprint and the build attribution apply to events materialized after the migration and converge as the retention window rolls.",
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
	{
		name: "error_fingerprints_minutely",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Minute-grain rollup cascaded from error_events; preserved rows keep an empty ServiceVersion and new minutes carry the emitting build.",
		preservationInterval: "error retention horizon",
		sourceRetentionDays: 90,
		targetRetentionDays: 90,
	},
]

export const v6ToV7ErrorServiceVersionModule: LocalStoreMigrationModule<V6ToV7State, V6ToV7Progress> = {
	id: "local-0006-to-0007-error-service-version",
	moduleVersion: 1,
	description:
		"Add ServiceVersion to the error-events tables and rebuild the error-events views on fingerprint v2",
	from: LOCAL_SCHEMA_V6,
	to: LOCAL_SCHEMA_V7,
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
