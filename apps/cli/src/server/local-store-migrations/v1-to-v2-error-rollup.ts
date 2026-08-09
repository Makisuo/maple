import { cp, mkdir, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
	applyRawTelemetryRetentionFloor,
	RAW_TELEMETRY_TTL_COLUMNS,
	readRawTelemetryRetentionDays,
	type Chdb,
} from "../chdb"
import type {
	LocalStoreMigrationModule,
	MigrationModuleContext,
	MigrationOperation,
	StateDispositionEntry,
} from "../local-store-migration-module"
import { withRawTelemetryRetentionFloor } from "../schema-manifest"
import {
	LOCAL_SCHEMA_V1,
	LOCAL_SCHEMA_V1_MANIFEST,
	LOCAL_SCHEMA_V1_SQL,
	LOCAL_SCHEMA_V2,
	LOCAL_SCHEMA_V2_MANIFEST,
	LOCAL_SCHEMA_V2_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

const RAW_TABLES = RAW_TELEMETRY_TTL_COLUMNS.map(([table]) => table)

interface V1ToV2State {
	readonly module: "local-0001-to-0002-error-rollup"
	readonly version: 1
	readonly rawRows: Readonly<Record<string, string>>
	readonly retentionDays?: number
}

interface V1ToV2Progress {
	readonly backfilledErrorEvents: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const decodeCounts = (value: unknown): Readonly<Record<string, string>> => {
	if (!isRecord(value)) throw new Error("v1 -> v2 rawRows must be an object")
	const counts: Record<string, string> = {}
	for (const table of RAW_TABLES) {
		const count = value[table]
		if (typeof count !== "string" || !/^\d+$/.test(count))
			throw new Error(`v1 -> v2 rawRows.${table} must be an unsigned decimal string`)
		counts[table] = count
	}
	if (Object.keys(value).some((table) => !RAW_TABLES.includes(table as (typeof RAW_TABLES)[number])))
		throw new Error("v1 -> v2 rawRows contains an unknown table")
	return counts
}

const decodeState = (value: unknown): V1ToV2State => {
	if (!isRecord(value)) throw new Error("v1 -> v2 state must be an object")
	const allowed = new Set(["module", "version", "rawRows", "retentionDays"])
	if (Object.keys(value).some((key) => !allowed.has(key)))
		throw new Error("v1 -> v2 state contains an unknown field")
	if (value.module !== "local-0001-to-0002-error-rollup" || value.version !== 1)
		throw new Error("v1 -> v2 state has an unsupported module or version")
	if (
		value.retentionDays !== undefined &&
		(typeof value.retentionDays !== "number" || !Number.isSafeInteger(value.retentionDays))
	)
		throw new Error("v1 -> v2 retentionDays must be an integer")
	return {
		module: "local-0001-to-0002-error-rollup",
		version: 1,
		rawRows: decodeCounts(value.rawRows),
		...(value.retentionDays === undefined ? {} : { retentionDays: value.retentionDays }),
	}
}

const decodeProgress = (value: unknown): V1ToV2Progress | undefined => {
	if (value === undefined) return undefined
	if (
		!isRecord(value) ||
		Object.keys(value).some((key) => key !== "backfilledErrorEvents") ||
		typeof value.backfilledErrorEvents !== "string" ||
		!/^\d+$/.test(value.backfilledErrorEvents)
	)
		throw new Error("v1 -> v2 progress is invalid")
	return { backfilledErrorEvents: value.backfilledErrorEvents }
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

const expectedManifest = (manifest: typeof LOCAL_SCHEMA_V1_MANIFEST, retentionDays: number | undefined) =>
	retentionDays === undefined
		? manifest
		: withRawTelemetryRetentionFloor(manifest, RAW_TABLES, retentionDays)

const preflight = async (context: MigrationModuleContext): Promise<V1ToV2State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const rawRows = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V1_MANIFEST, retentionDays))
			return rawRowCounts(db)
		},
		{ schemaSql: LOCAL_SCHEMA_V1_SQL, bootstrapSchema: false },
	)
	return {
		module: "local-0001-to-0002-error-rollup",
		version: 1,
		rawRows,
		...(retentionDays === undefined ? {} : { retentionDays }),
	}
}

const prepareTarget = async (context: MigrationModuleContext, state: V1ToV2State): Promise<V1ToV2State> => {
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

const backfillSql = `INSERT INTO error_fingerprints_minutely
SELECT
	OrgId,
	toStartOfMinute(Timestamp) AS Minute,
	FingerprintHash,
	anyLast(ServiceName) AS ServiceName,
	anyLast(ExceptionType) AS ExceptionType,
	anyLast(ExceptionMessage) AS ExceptionMessage,
	anyLast(ErrorLabel) AS ErrorLabel,
	anyLast(TopFrame) AS TopFrame,
	count() AS OccurrenceCount,
	min(Timestamp) AS FirstSeen,
	max(Timestamp) AS LastSeen
FROM error_events
GROUP BY OrgId, Minute, FingerprintHash`

const apply = async (
	context: MigrationModuleContext,
	state: V1ToV2State,
	_progress: V1ToV2Progress | undefined,
): Promise<V1ToV2Progress> => {
	await context.openTarget(
		(db) => {
			db.exec("DROP TABLE IF EXISTS error_fingerprints_minutely_mv")
			db.exec("DROP TABLE IF EXISTS error_fingerprints_minutely")
			db.exec("DROP TABLE IF EXISTS error_events_by_time_mv")
		},
		{ schemaSql: LOCAL_SCHEMA_V1_SQL, bootstrapSchema: false },
	)
	return context.openTarget(
		(db) => {
			if (state.retentionDays !== undefined) applyRawTelemetryRetentionFloor(db, state.retentionDays)
			db.exec(backfillSql)
			const [row] = parseJsonEachRow<{ rowCount: string }>(
				db.query(
					"SELECT toString(sum(OccurrenceCount)) AS rowCount FROM error_fingerprints_minutely",
				),
			)
			return { backfilledErrorEvents: row?.rowCount ?? "0" }
		},
		{ schemaSql: LOCAL_SCHEMA_V2_SQL, bootstrapSchema: true },
	)
}

const verify = async (
	context: MigrationModuleContext,
	state: V1ToV2State,
	progress: V1ToV2Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V2_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new Error(`v1 -> v2 raw telemetry verification failed for ${table}`)
			}
			const [row] = parseJsonEachRow<{ rowCount: string }>(
				db.query("SELECT toString(count()) AS rowCount FROM error_events"),
			)
			if ((row?.rowCount ?? "0") !== progress.backfilledErrorEvents)
				throw new Error("v1 -> v2 error rollup backfill verification failed")
		},
		{ schemaSql: LOCAL_SCHEMA_V2_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v1-store",
		description: "Clone the stopped v1 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "replace-error-rollups",
		description: "Replace the error fan-out view and backfill the minutely fingerprint rollup",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v2-schema",
		description: "Verify the v2 physical schema, raw telemetry, and error rollup totals",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v1 store is cloned byte-for-byte before target-only DDL changes.",
	},
	{
		name: "error_fingerprints_minutely",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee: "The new rollup is rebuilt from retained canonical error_events rows.",
		preservationInterval: "error_events retention horizon",
		sourceRetentionDays: 90,
		targetRetentionDays: 90,
	},
]

export const v1ToV2ErrorRollupModule: LocalStoreMigrationModule<V1ToV2State, V1ToV2Progress> = {
	id: "local-0001-to-0002-error-rollup",
	moduleVersion: 1,
	description: "Add the durable minutely error-fingerprint rollup to a v1 local store",
	from: LOCAL_SCHEMA_V1,
	to: LOCAL_SCHEMA_V2,
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
