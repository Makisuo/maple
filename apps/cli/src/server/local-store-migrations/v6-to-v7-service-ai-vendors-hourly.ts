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

interface V6ToV7State {
	readonly module: "local-0006-to-0007-service-ai-vendors-hourly"
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
	if (value.module !== "local-0006-to-0007-service-ai-vendors-hourly" || value.version !== 1)
		throw new Error("v6 -> v7 state has an unsupported module or version")
	if (
		value.retentionDays !== undefined &&
		(typeof value.retentionDays !== "number" || !Number.isSafeInteger(value.retentionDays))
	)
		throw new Error("v6 -> v7 retentionDays must be an integer")
	return {
		module: "local-0006-to-0007-service-ai-vendors-hourly",
		version: 1,
		rawRows: decodeCounts(value.rawRows),
		...(value.retentionDays === undefined ? {} : { retentionDays: value.retentionDays }),
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
		module: "local-0006-to-0007-service-ai-vendors-hourly",
		version: 1,
		rawRows,
		...(retentionDays === undefined ? {} : { retentionDays }),
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
 * Purely additive: one new table and the view that fills it, so bootstrapping
 * the v7 DDL is the whole migration. Every other object's
 * `CREATE … IF NOT EXISTS` is a no-op against the cloned store. No explicit
 * ALTER list, because the generated DDL is already the single source of truth.
 *
 * `service_ai_vendors_hourly` starts empty and stays that way for the store's
 * existing history — an MV is an insert trigger, so it only sees spans written
 * after this point, the same position ClickHouse migration 0017 leaves a
 * deployed cluster in. Backfilling would rewrite a store just promised
 * byte-for-byte, and would be wrong anyway: rows written before the ingest
 * classifier ran carry `AiVendor = ''`, so it would produce an empty rollup
 * indistinguishable from "this store genuinely has no AI spans".
 */
const apply = async (context: MigrationModuleContext): Promise<V6ToV7Progress> =>
	context.openTarget(() => ({ installed: true }), {
		schemaSql: LOCAL_SCHEMA_V7_SQL,
		bootstrapSchema: true,
	})

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
		id: "install-service-ai-vendors-hourly",
		description: "Install the AI vendor discovery rollup and its materialized view",
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
		guarantee: "The clean stopped v6 store is cloned byte-for-byte before additive DDL runs.",
	},
	{
		name: "traces",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee:
			"The source of the new view is neither read nor rewritten; the rollup fills from spans written after the migration.",
	},
	{
		// Created empty and filled forward, never backfilled: existing spans carry
		// AiVendor = '' and the view's WHERE excludes them all. Unlike web_events
		// this table does NOT converge with its source's horizon — 400 days against
		// traces' 30 — so past 30 days the rollup is the only record, complete from
		// the migration forward.
		name: "service_ai_vendors_hourly",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Filled forward from classified spans written after the migration; the raw source retains 30 days, so nothing older than that horizon was ever rebuildable from this store.",
		preservationInterval: "traces retention horizon",
		sourceRetentionDays: 30,
		targetRetentionDays: 400,
	},
]

export const v6ToV7ServiceAiVendorsHourlyModule: LocalStoreMigrationModule<V6ToV7State, V6ToV7Progress> = {
	id: "local-0006-to-0007-service-ai-vendors-hourly",
	moduleVersion: 1,
	description: "Add the AI vendor discovery rollup and its materialized view to v6",
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
