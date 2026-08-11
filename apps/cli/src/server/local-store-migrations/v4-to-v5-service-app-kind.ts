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
	LOCAL_SCHEMA_V4,
	LOCAL_SCHEMA_V4_MANIFEST,
	LOCAL_SCHEMA_V4_SQL,
	LOCAL_SCHEMA_V5,
	LOCAL_SCHEMA_V5_MANIFEST,
	LOCAL_SCHEMA_V5_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

const RAW_TABLES = RAW_TELEMETRY_TTL_COLUMNS.map(([table]) => table)

interface V4ToV5State {
	readonly module: "local-0004-to-0005-service-app-kind"
	readonly version: 1
	readonly rawRows: Readonly<Record<string, string>>
	readonly retentionDays?: number
}

interface V4ToV5Progress {
	readonly installed: true
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const decodeCounts = (value: unknown): Readonly<Record<string, string>> => {
	if (!isRecord(value)) throw new Error("v4 -> v5 rawRows must be an object")
	const counts: Record<string, string> = {}
	for (const table of RAW_TABLES) {
		const count = value[table]
		if (typeof count !== "string" || !/^\d+$/.test(count))
			throw new Error(`v4 -> v5 rawRows.${table} must be an unsigned decimal string`)
		counts[table] = count
	}
	if (Object.keys(value).some((table) => !RAW_TABLES.includes(table as (typeof RAW_TABLES)[number])))
		throw new Error("v4 -> v5 rawRows contains an unknown table")
	return counts
}

const decodeState = (value: unknown): V4ToV5State => {
	if (!isRecord(value)) throw new Error("v4 -> v5 state must be an object")
	const allowed = new Set(["module", "version", "rawRows", "retentionDays"])
	if (Object.keys(value).some((key) => !allowed.has(key)))
		throw new Error("v4 -> v5 state contains an unknown field")
	if (value.module !== "local-0004-to-0005-service-app-kind" || value.version !== 1)
		throw new Error("v4 -> v5 state has an unsupported module or version")
	if (
		value.retentionDays !== undefined &&
		(typeof value.retentionDays !== "number" || !Number.isSafeInteger(value.retentionDays))
	)
		throw new Error("v4 -> v5 retentionDays must be an integer")
	return {
		module: "local-0004-to-0005-service-app-kind",
		version: 1,
		rawRows: decodeCounts(value.rawRows),
		...(value.retentionDays === undefined ? {} : { retentionDays: value.retentionDays }),
	}
}

const decodeProgress = (value: unknown): V4ToV5Progress | undefined => {
	if (value === undefined) return undefined
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "installed") || value.installed !== true)
		throw new Error("v4 -> v5 progress is invalid")
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

const expectedManifest = (manifest: typeof LOCAL_SCHEMA_V4_MANIFEST, retentionDays: number | undefined) =>
	retentionDays === undefined
		? manifest
		: withRawTelemetryRetentionFloor(manifest, RAW_TABLES, retentionDays)

const preflight = async (context: MigrationModuleContext): Promise<V4ToV5State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const rawRows = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V4_MANIFEST, retentionDays))
			return rawRowCounts(db)
		},
		{ schemaSql: LOCAL_SCHEMA_V4_SQL, bootstrapSchema: false },
	)
	return {
		module: "local-0004-to-0005-service-app-kind",
		version: 1,
		rawRows,
		...(retentionDays === undefined ? {} : { retentionDays }),
	}
}

const prepareTarget = async (context: MigrationModuleContext, state: V4ToV5State): Promise<V4ToV5State> => {
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
 * Three appended columns on `service_platforms_hourly` plus the view that fills
 * them. Unlike v3 -> v4 the bootstrap pass alone is not enough: the table
 * already exists, so its `CREATE TABLE IF NOT EXISTS` is a no-op and the
 * columns would never appear. The ALTERs run first, against the v4 snapshot,
 * and the view is dropped so the bootstrap recreates it with the widened
 * SELECT.
 *
 * `SimpleAggregateFunction(max, String)` columns default to empty, which is
 * exactly what the classifier reads as "no signal" — so historical hours keep
 * classifying as they do today (`unknown` -> the 500 ms Apdex default) and
 * converge as soon as one hour of fresh telemetry lands. Nothing is rewritten.
 */
const apply = async (context: MigrationModuleContext): Promise<V4ToV5Progress> => {
	await context.openTarget(
		(db) => {
			db.exec(
				"ALTER TABLE service_platforms_hourly ADD COLUMN IF NOT EXISTS TelemetrySdkLanguage SimpleAggregateFunction(max, String) AFTER ProcessRuntimeName",
			)
			db.exec(
				"ALTER TABLE service_platforms_hourly ADD COLUMN IF NOT EXISTS BrowserPlatform SimpleAggregateFunction(max, String) AFTER TelemetrySdkLanguage",
			)
			db.exec(
				"ALTER TABLE service_platforms_hourly ADD COLUMN IF NOT EXISTS DeviceType SimpleAggregateFunction(max, String) AFTER BrowserPlatform",
			)
			db.exec("DROP VIEW IF EXISTS service_platforms_hourly_mv")
		},
		{ schemaSql: LOCAL_SCHEMA_V4_SQL, bootstrapSchema: false },
	)
	return context.openTarget(() => ({ installed: true }), {
		schemaSql: LOCAL_SCHEMA_V5_SQL,
		bootstrapSchema: true,
	})
}

const verify = async (
	context: MigrationModuleContext,
	state: V4ToV5State,
	_progress: V4ToV5Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V5_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new Error(`v4 -> v5 raw telemetry verification failed for ${table}`)
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V5_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v4-store",
		description: "Clone the stopped v4 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "install-app-kind-columns",
		description:
			"Append the app-kind signal columns to service_platforms_hourly and recreate its materialized view",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v5-schema",
		description: "Verify the v5 physical schema and retained raw telemetry counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v4 store is cloned byte-for-byte before additive DDL runs.",
	},
	{
		// Appended columns only — no existing column is read, rewritten, or
		// reordered, and the pre-existing rows keep every value they had. The new
		// columns read as empty for historical hours, which the classifier already
		// treats as "no signal" and resolves to the same 500 ms Apdex default those
		// hours get today.
		name: "service_platforms_hourly",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Existing rows and columns are untouched; the three appended signal columns fill forward from traces writes and are complete for any window containing one hour of post-migration telemetry.",
		preservationInterval: "service_platforms_hourly retention horizon",
		sourceRetentionDays: 365,
		targetRetentionDays: 365,
	},
]

export const v4ToV5ServiceAppKindModule: LocalStoreMigrationModule<V4ToV5State, V4ToV5Progress> = {
	id: "local-0004-to-0005-service-app-kind",
	moduleVersion: 1,
	description:
		"Append telemetry.sdk.language / browser.platform / device.type app-kind signals to service_platforms_hourly",
	from: LOCAL_SCHEMA_V4,
	to: LOCAL_SCHEMA_V5,
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
