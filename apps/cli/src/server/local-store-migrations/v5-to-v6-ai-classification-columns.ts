import { AI_CLASSIFICATION_ALTER_STATEMENTS } from "@maple/domain/clickhouse"
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
	LOCAL_SCHEMA_V5,
	LOCAL_SCHEMA_V5_MANIFEST,
	LOCAL_SCHEMA_V5_SQL,
	LOCAL_SCHEMA_V6,
	LOCAL_SCHEMA_V6_MANIFEST,
	LOCAL_SCHEMA_V6_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

const RAW_TABLES = RAW_TELEMETRY_TTL_COLUMNS.map(([table]) => table)

interface V5ToV6State {
	readonly module: "local-0005-to-0006-ai-classification-columns"
	readonly version: 1
	readonly rawRows: Readonly<Record<string, string>>
	readonly retentionDays?: number
}

interface V5ToV6Progress {
	readonly installed: true
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const decodeCounts = (value: unknown): Readonly<Record<string, string>> => {
	if (!isRecord(value)) throw new Error("v5 -> v6 rawRows must be an object")
	const counts: Record<string, string> = {}
	for (const table of RAW_TABLES) {
		const count = value[table]
		if (typeof count !== "string" || !/^\d+$/.test(count))
			throw new Error(`v5 -> v6 rawRows.${table} must be an unsigned decimal string`)
		counts[table] = count
	}
	if (Object.keys(value).some((table) => !RAW_TABLES.includes(table as (typeof RAW_TABLES)[number])))
		throw new Error("v5 -> v6 rawRows contains an unknown table")
	return counts
}

const decodeState = (value: unknown): V5ToV6State => {
	if (!isRecord(value)) throw new Error("v5 -> v6 state must be an object")
	const allowed = new Set(["module", "version", "rawRows", "retentionDays"])
	if (Object.keys(value).some((key) => !allowed.has(key)))
		throw new Error("v5 -> v6 state contains an unknown field")
	if (value.module !== "local-0005-to-0006-ai-classification-columns" || value.version !== 1)
		throw new Error("v5 -> v6 state has an unsupported module or version")
	if (
		value.retentionDays !== undefined &&
		(typeof value.retentionDays !== "number" || !Number.isSafeInteger(value.retentionDays))
	)
		throw new Error("v5 -> v6 retentionDays must be an integer")
	return {
		module: "local-0005-to-0006-ai-classification-columns",
		version: 1,
		rawRows: decodeCounts(value.rawRows),
		...(value.retentionDays === undefined ? {} : { retentionDays: value.retentionDays }),
	}
}

const decodeProgress = (value: unknown): V5ToV6Progress | undefined => {
	if (value === undefined) return undefined
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "installed") || value.installed !== true)
		throw new Error("v5 -> v6 progress is invalid")
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

const expectedManifest = (manifest: typeof LOCAL_SCHEMA_V5_MANIFEST, retentionDays: number | undefined) =>
	retentionDays === undefined
		? manifest
		: withRawTelemetryRetentionFloor(manifest, RAW_TABLES, retentionDays)

const preflight = async (context: MigrationModuleContext): Promise<V5ToV6State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const rawRows = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V5_MANIFEST, retentionDays))
			return rawRowCounts(db)
		},
		{ schemaSql: LOCAL_SCHEMA_V5_SQL, bootstrapSchema: false },
	)
	return {
		module: "local-0005-to-0006-ai-classification-columns",
		version: 1,
		rawRows,
		...(retentionDays === undefined ? {} : { retentionDays }),
	}
}

const prepareTarget = async (context: MigrationModuleContext, state: V5ToV6State): Promise<V5ToV6State> => {
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
 * Runs ClickHouse migration 0016's ALTER list — the imported constant, not a copy,
 * so retuning an index or adding a column there reaches migrated local stores too.
 * `traces` already exists here, so bootstrapping the v6 DDL is a no-op on it and
 * the columns and indexes arrive only through these ALTERs.
 *
 * Metadata-only and additive: constant DEFAULTs rewrite no part, and every ALTER
 * is `IF NOT EXISTS`, so a resumed run converges instead of failing. No
 * `MATERIALIZE INDEX` — a whole-table mutation is the expensive mistake, and the
 * store's 30-day raw-telemetry TTL retires unindexed parts anyway.
 */
const apply = async (context: MigrationModuleContext): Promise<V5ToV6Progress> =>
	context.openTarget(
		(db) => {
			for (const statement of AI_CLASSIFICATION_ALTER_STATEMENTS) db.exec(statement)
			return { installed: true } as const
		},
		{ schemaSql: LOCAL_SCHEMA_V6_SQL, bootstrapSchema: true },
	)

const verify = async (
	context: MigrationModuleContext,
	state: V5ToV6State,
	_progress: V5ToV6Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V6_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new Error(`v5 -> v6 raw telemetry verification failed for ${table}`)
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V6_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v5-store",
		description: "Clone the stopped v5 store into the staged migration target",
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
		id: "verify-v6-schema",
		description: "Verify the v6 physical schema and retained raw telemetry counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v5 store is cloned byte-for-byte before additive DDL runs.",
	},
	{
		name: "traces",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee:
			"Trailing defaulted columns and skip indexes are metadata-only; no existing row or part is rewritten and every prior column keeps its value.",
	},
	{
		// Readable immediately (every pre-migration row reads its DEFAULT) but not
		// classified: AiRulesVersion 0 marks "never examined". The skip indexes cover
		// only parts written after the ALTER; the 30-day TTL retires the rest.
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

export const v5ToV6AiClassificationColumnsModule: LocalStoreMigrationModule<V5ToV6State, V5ToV6Progress> = {
	id: "local-0005-to-0006-ai-classification-columns",
	moduleVersion: 1,
	description: "Add the AI classification columns and vendor/scope skip indexes to traces on v5",
	from: LOCAL_SCHEMA_V5,
	to: LOCAL_SCHEMA_V6,
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
