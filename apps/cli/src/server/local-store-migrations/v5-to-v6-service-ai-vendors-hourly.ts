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
	readonly module: "local-0005-to-0006-service-ai-vendors-hourly"
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
	if (value.module !== "local-0005-to-0006-service-ai-vendors-hourly" || value.version !== 1)
		throw new Error("v5 -> v6 state has an unsupported module or version")
	if (
		value.retentionDays !== undefined &&
		(typeof value.retentionDays !== "number" || !Number.isSafeInteger(value.retentionDays))
	)
		throw new Error("v5 -> v6 retentionDays must be an integer")
	return {
		module: "local-0005-to-0006-service-ai-vendors-hourly",
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
		module: "local-0005-to-0006-service-ai-vendors-hourly",
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
 * Purely additive: one new table and the view that fills it. Nothing existing is
 * touched, so — like v3 -> v4 and unlike v4 -> v5 — bootstrapping the v6 DDL is
 * the whole migration. Every other object's `CREATE … IF NOT EXISTS` is a no-op
 * against the cloned store; only `service_ai_vendors_hourly` and its MV are new.
 * There is deliberately no explicit ALTER list here: the objects are *created*,
 * not modified, so the generated DDL is already the single source of truth and a
 * hand-copied CREATE would be a second one.
 *
 * `service_ai_vendors_hourly` starts empty and stays that way for the store's
 * existing history — a materialized view is an insert trigger, so it only sees
 * spans written after this point. That is the same position a deployed cluster
 * is in after ClickHouse migration 0016, and it is why that migration ships no
 * POPULATE either. Backfilling here would mean rewriting a store we have just
 * promised to clone byte-for-byte, and it would be wrong on top of that: rows
 * written before the ingest classifier ran carry `AiVendor = ''`, so a backfill
 * would produce not a partial rollup but an empty one, indistinguishable from
 * "this store genuinely has no AI spans".
 */
const apply = async (context: MigrationModuleContext): Promise<V5ToV6Progress> =>
	context.openTarget(() => ({ installed: true }), {
		schemaSql: LOCAL_SCHEMA_V6_SQL,
		bootstrapSchema: true,
	})

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
		id: "install-service-ai-vendors-hourly",
		description: "Install the AI vendor discovery rollup and its materialized view",
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
			"The source of the new view is neither read nor rewritten; the rollup fills from spans written after the migration.",
	},
	{
		// Created empty and filled forward, never backfilled — twice over. The
		// store was just promised byte-for-byte, and the pre-migration rows would
		// not produce a usable rollup anyway: local mode has no ingest classifier,
		// so every existing span carries AiVendor = '' and the view's WHERE
		// excludes all of them. Unlike web_events, this table does NOT converge
		// with its source's horizon — it keeps 400 days against traces' 30 — so
		// what converges is the *overlap*: past 30 days the raw spans are gone and
		// the rollup is the only record, complete from the migration forward.
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

export const v5ToV6ServiceAiVendorsHourlyModule: LocalStoreMigrationModule<V5ToV6State, V5ToV6Progress> = {
	id: "local-0005-to-0006-service-ai-vendors-hourly",
	moduleVersion: 1,
	description: "Add the AI vendor discovery rollup and its materialized view to v5",
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
