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

/**
 * Byte-for-byte the structural half of ClickHouse migration 0015. `traces`
 * already exists here, so bootstrapping the v5 DDL is a no-op on it
 * (`CREATE TABLE IF NOT EXISTS`) — the columns and indexes only arrive through
 * these ALTERs. If 0015 changes, change these together or a migrated local
 * store stops matching the bundled v5 manifest, which `verify` below catches.
 */
const AI_CLASSIFICATION_STATEMENTS: ReadonlyArray<string> = [
	"ALTER TABLE traces ADD COLUMN IF NOT EXISTS AiVendor LowCardinality(String) DEFAULT ''",
	"ALTER TABLE traces ADD COLUMN IF NOT EXISTS AiSessionKeyState UInt8 DEFAULT 0",
	"ALTER TABLE traces ADD COLUMN IF NOT EXISTS AiSessionKeyHash UInt64 DEFAULT 0",
	"ALTER TABLE traces ADD COLUMN IF NOT EXISTS AiRulesVersion UInt32 DEFAULT 0",
	"ALTER TABLE traces ADD COLUMN IF NOT EXISTS AiRollupHour DateTime('UTC') DEFAULT toDateTime(0)",
	"ALTER TABLE traces ADD INDEX IF NOT EXISTS idx_ai_vendor AiVendor TYPE set(0) GRANULARITY 4",
	"ALTER TABLE traces ADD INDEX IF NOT EXISTS idx_scope_name ScopeName TYPE tokenbf_v1(4096, 3, 0) GRANULARITY 4",
]

interface V4ToV5State {
	readonly module: "local-0004-to-0005-ai-classification-columns"
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
	if (value.module !== "local-0004-to-0005-ai-classification-columns" || value.version !== 1)
		throw new Error("v4 -> v5 state has an unsupported module or version")
	if (
		value.retentionDays !== undefined &&
		(typeof value.retentionDays !== "number" || !Number.isSafeInteger(value.retentionDays))
	)
		throw new Error("v4 -> v5 retentionDays must be an integer")
	return {
		module: "local-0004-to-0005-ai-classification-columns",
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
		module: "local-0004-to-0005-ai-classification-columns",
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
 * Metadata-only and additive: five trailing columns with constant DEFAULTs plus
 * two skip indexes on `traces`. No part is rewritten — existing parts read the
 * defaults for free, and every ALTER is `IF NOT EXISTS`, so a resumed run
 * converges instead of failing.
 *
 * Deliberately no `MATERIALIZE INDEX`: that is a mutation over the whole table,
 * and the store's 30-day raw-telemetry TTL rolls every unindexed part out on its
 * own. Same reasoning as ClickHouse migration 0015 — the local store is not a
 * different decision, just a smaller one.
 *
 * Nothing writes the new columns yet (the ingest classifier lands in a later
 * stage), so the migrated store's `traces` rows all carry the defaults: AiVendor
 * '' = not classified, AiRulesVersion 0 = the row predates classification.
 */
const apply = async (context: MigrationModuleContext): Promise<V4ToV5Progress> =>
	context.openTarget(
		(db) => {
			for (const statement of AI_CLASSIFICATION_STATEMENTS) db.exec(statement)
			return { installed: true } as const
		},
		{ schemaSql: LOCAL_SCHEMA_V5_SQL, bootstrapSchema: true },
	)

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
		id: "add-ai-classification-columns",
		description: "Add the AI classification columns and vendor/scope skip indexes to traces",
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
		name: "traces",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee:
			"Trailing defaulted columns and skip indexes are metadata-only; no existing row or part is rewritten and every prior column keeps its value.",
	},
	{
		// The new columns are readable immediately — every pre-migration row reads
		// its DEFAULT — but they are not *classified*: nothing writes them until the
		// ingest classifier ships, and AiRulesVersion = 0 is precisely the marker
		// for "this row was never examined". The skip indexes cover only parts
		// written after the ALTER; the 30-day TTL retires the rest.
		name: "traces AI classification columns",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Defaulted for every existing row (AiRulesVersion 0 = never classified) and filled forward once the ingest classifier ships; complete by construction after the 30-day raw-telemetry horizon.",
		preservationInterval: "traces retention horizon",
		sourceRetentionDays: 30,
		targetRetentionDays: 30,
	},
]

export const v4ToV5AiClassificationColumnsModule: LocalStoreMigrationModule<V4ToV5State, V4ToV5Progress> = {
	id: "local-0004-to-0005-ai-classification-columns",
	moduleVersion: 1,
	description: "Add the AI classification columns and vendor/scope skip indexes to traces on v4",
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
