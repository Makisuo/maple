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
	LOCAL_SCHEMA_V2,
	LOCAL_SCHEMA_V2_MANIFEST,
	LOCAL_SCHEMA_V2_SQL,
	LOCAL_SCHEMA_V3,
	LOCAL_SCHEMA_V3_MANIFEST,
	LOCAL_SCHEMA_V3_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

const RAW_TABLES = RAW_TELEMETRY_TTL_COLUMNS.map(([table]) => table)

interface V2ToV3State {
	readonly module: "local-0002-to-0003-service-map-ingest-bridge"
	readonly version: 1
	readonly rawRows: Readonly<Record<string, string>>
	readonly retentionDays?: number
}

interface V2ToV3Progress {
	readonly installed: true
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const decodeCounts = (value: unknown): Readonly<Record<string, string>> => {
	if (!isRecord(value)) throw new Error("v2 -> v3 rawRows must be an object")
	const counts: Record<string, string> = {}
	for (const table of RAW_TABLES) {
		const count = value[table]
		if (typeof count !== "string" || !/^\d+$/.test(count))
			throw new Error(`v2 -> v3 rawRows.${table} must be an unsigned decimal string`)
		counts[table] = count
	}
	if (Object.keys(value).some((table) => !RAW_TABLES.includes(table as (typeof RAW_TABLES)[number])))
		throw new Error("v2 -> v3 rawRows contains an unknown table")
	return counts
}

const decodeState = (value: unknown): V2ToV3State => {
	if (!isRecord(value)) throw new Error("v2 -> v3 state must be an object")
	const allowed = new Set(["module", "version", "rawRows", "retentionDays"])
	if (Object.keys(value).some((key) => !allowed.has(key)))
		throw new Error("v2 -> v3 state contains an unknown field")
	if (value.module !== "local-0002-to-0003-service-map-ingest-bridge" || value.version !== 1)
		throw new Error("v2 -> v3 state has an unsupported module or version")
	if (
		value.retentionDays !== undefined &&
		(typeof value.retentionDays !== "number" || !Number.isSafeInteger(value.retentionDays))
	)
		throw new Error("v2 -> v3 retentionDays must be an integer")
	return {
		module: "local-0002-to-0003-service-map-ingest-bridge",
		version: 1,
		rawRows: decodeCounts(value.rawRows),
		...(!(value.retentionDays === undefined) ? { retentionDays: value.retentionDays } : undefined),
	}
}

const decodeProgress = (value: unknown): V2ToV3Progress | undefined => {
	if (value === undefined) return undefined
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "installed") || value.installed !== true)
		throw new Error("v2 -> v3 progress is invalid")
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

const expectedManifest = (manifest: typeof LOCAL_SCHEMA_V2_MANIFEST, retentionDays: number | undefined) =>
	retentionDays === undefined
		? manifest
		: withRawTelemetryRetentionFloor(manifest, RAW_TABLES, retentionDays)

const preflight = async (context: MigrationModuleContext): Promise<V2ToV3State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const rawRows = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V2_MANIFEST, retentionDays))
			return rawRowCounts(db)
		},
		{ schemaSql: LOCAL_SCHEMA_V2_SQL, bootstrapSchema: false },
	)
	return {
		module: "local-0002-to-0003-service-map-ingest-bridge",
		version: 1,
		rawRows,
		...(!(retentionDays === undefined) ? { retentionDays } : undefined),
	}
}

const prepareTarget = async (context: MigrationModuleContext, state: V2ToV3State): Promise<V2ToV3State> => {
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

const apply = async (context: MigrationModuleContext): Promise<V2ToV3Progress> => {
	// v2 briefly cascaded this existing view from error_events. Recreate it from
	// the v3 snapshot so local stores match the deployment-safe Tinybird shape:
	// the long-lived view remains triggered by traces, while only the new compact
	// fingerprint rollup cascades from error_events. Dropping the view never
	// touches the historical rows in its error_events_by_time target.
	await context.openTarget((db) => db.exec("DROP TABLE IF EXISTS error_events_by_time_mv"), {
		schemaSql: LOCAL_SCHEMA_V2_SQL,
		bootstrapSchema: false,
	})
	return context.openTarget(() => ({ installed: true }), {
		schemaSql: LOCAL_SCHEMA_V3_SQL,
		bootstrapSchema: true,
	})
}

const verify = async (
	context: MigrationModuleContext,
	state: V2ToV3State,
	_progress: V2ToV3Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V3_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new Error(`v2 -> v3 raw telemetry verification failed for ${table}`)
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V3_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v2-store",
		description: "Clone the stopped v2 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "install-v3-materializations",
		description: "Restore the deployed error view trigger and install the service-map ingress bridge",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v3-schema",
		description: "Verify the v3 physical schema and retained raw telemetry counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v2 store is cloned byte-for-byte before additive DDL runs.",
	},
	{
		name: "service_map_edges_hourly",
		classification: "derived",
		disposition: "preserve-exact",
		guarantee: "The existing aggregate target and its historical rows are not rebuilt or rewritten.",
	},
	{
		name: "error_events_by_time",
		classification: "derived",
		disposition: "preserve-exact",
		guarantee:
			"Only its insert-trigger view is recreated; all time-ordered historical error rows remain untouched.",
	},
]

export const v2ToV3ServiceMapIngestBridgeModule: LocalStoreMigrationModule<V2ToV3State, V2ToV3Progress> = {
	id: "local-0002-to-0003-service-map-ingest-bridge",
	moduleVersion: 1,
	description:
		"Restore the deployment-safe error view trigger and add the service-map ingress bridge to v2",
	from: LOCAL_SCHEMA_V2,
	to: LOCAL_SCHEMA_V3,
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
