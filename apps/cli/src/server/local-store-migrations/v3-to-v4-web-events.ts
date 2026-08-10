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
	LOCAL_SCHEMA_V3,
	LOCAL_SCHEMA_V3_MANIFEST,
	LOCAL_SCHEMA_V3_SQL,
	LOCAL_SCHEMA_V4,
	LOCAL_SCHEMA_V4_MANIFEST,
	LOCAL_SCHEMA_V4_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

const RAW_TABLES = RAW_TELEMETRY_TTL_COLUMNS.map(([table]) => table)

interface V3ToV4State {
	readonly module: "local-0003-to-0004-web-events"
	readonly version: 1
	readonly rawRows: Readonly<Record<string, string>>
	readonly retentionDays?: number
}

interface V3ToV4Progress {
	readonly installed: true
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const decodeCounts = (value: unknown): Readonly<Record<string, string>> => {
	if (!isRecord(value)) throw new Error("v3 -> v4 rawRows must be an object")
	const counts: Record<string, string> = {}
	for (const table of RAW_TABLES) {
		const count = value[table]
		if (typeof count !== "string" || !/^\d+$/.test(count))
			throw new Error(`v3 -> v4 rawRows.${table} must be an unsigned decimal string`)
		counts[table] = count
	}
	if (Object.keys(value).some((table) => !RAW_TABLES.includes(table as (typeof RAW_TABLES)[number])))
		throw new Error("v3 -> v4 rawRows contains an unknown table")
	return counts
}

const decodeState = (value: unknown): V3ToV4State => {
	if (!isRecord(value)) throw new Error("v3 -> v4 state must be an object")
	const allowed = new Set(["module", "version", "rawRows", "retentionDays"])
	if (Object.keys(value).some((key) => !allowed.has(key)))
		throw new Error("v3 -> v4 state contains an unknown field")
	if (value.module !== "local-0003-to-0004-web-events" || value.version !== 1)
		throw new Error("v3 -> v4 state has an unsupported module or version")
	if (
		value.retentionDays !== undefined &&
		(typeof value.retentionDays !== "number" || !Number.isSafeInteger(value.retentionDays))
	)
		throw new Error("v3 -> v4 retentionDays must be an integer")
	return {
		module: "local-0003-to-0004-web-events",
		version: 1,
		rawRows: decodeCounts(value.rawRows),
		...(value.retentionDays === undefined ? {} : { retentionDays: value.retentionDays }),
	}
}

const decodeProgress = (value: unknown): V3ToV4Progress | undefined => {
	if (value === undefined) return undefined
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "installed") || value.installed !== true)
		throw new Error("v3 -> v4 progress is invalid")
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

const expectedManifest = (manifest: typeof LOCAL_SCHEMA_V3_MANIFEST, retentionDays: number | undefined) =>
	retentionDays === undefined
		? manifest
		: withRawTelemetryRetentionFloor(manifest, RAW_TABLES, retentionDays)

const preflight = async (context: MigrationModuleContext): Promise<V3ToV4State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const rawRows = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V3_MANIFEST, retentionDays))
			return rawRowCounts(db)
		},
		{ schemaSql: LOCAL_SCHEMA_V3_SQL, bootstrapSchema: false },
	)
	return {
		module: "local-0003-to-0004-web-events",
		version: 1,
		rawRows,
		...(retentionDays === undefined ? {} : { retentionDays }),
	}
}

const prepareTarget = async (context: MigrationModuleContext, state: V3ToV4State): Promise<V3ToV4State> => {
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
 * Purely additive: one new table and the view that fills it. Nothing existing is
 * dropped or rewritten, so unlike v2 -> v3 there is no pre-step here.
 *
 * `web_events` starts empty and stays that way for the store's existing history —
 * a materialized view is an insert trigger, so it only sees rows written after
 * this point. That is the same position a deployed cluster is in after migration
 * 0014, and it is why the read path keeps a raw `session_events` fallback: local
 * mode simply runs with the rollup unpopulated until fresh telemetry arrives.
 * Backfilling here would mean rewriting a store we have just promised to clone
 * byte-for-byte.
 */
const apply = async (context: MigrationModuleContext): Promise<V3ToV4Progress> =>
	context.openTarget(() => ({ installed: true }), {
		schemaSql: LOCAL_SCHEMA_V4_SQL,
		bootstrapSchema: true,
	})

const verify = async (
	context: MigrationModuleContext,
	state: V3ToV4State,
	_progress: V3ToV4Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V4_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new Error(`v3 -> v4 raw telemetry verification failed for ${table}`)
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V4_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v3-store",
		description: "Clone the stopped v3 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "install-web-events",
		description: "Install the web_events fact table and its materialized view",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v4-schema",
		description: "Verify the v4 physical schema and retained raw telemetry counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v3 store is cloned byte-for-byte before additive DDL runs.",
	},
	{
		name: "session_events",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee:
			"The source of the new view is neither read nor rewritten; web_events fills from writes made after the migration.",
	},
	{
		// Created empty and filled forward by the view, never backfilled — the
		// store was just promised byte-for-byte, and rewriting it to seed a rollup
		// would break that. It converges anyway: source and target share a 30-day
		// TTL, so once the horizon passes there is nothing left for the rollup to
		// be missing. Until then the web analytics read path falls back to raw
		// session_events, which is the same position a deployed cluster is in
		// immediately after migration 0014.
		name: "web_events",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Filled forward from session_events writes; complete by construction once the shared 30-day retention horizon passes, with the raw read path covering the interim.",
		preservationInterval: "session_events retention horizon",
		sourceRetentionDays: 30,
		targetRetentionDays: 30,
	},
]

export const v3ToV4WebEventsModule: LocalStoreMigrationModule<V3ToV4State, V3ToV4Progress> = {
	id: "local-0003-to-0004-web-events",
	moduleVersion: 1,
	description: "Add the web_events analytics fact table and its materialized view to v3",
	from: LOCAL_SCHEMA_V3,
	to: LOCAL_SCHEMA_V4,
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
