// SAFETY-FILE: JSON rows here come from fixed internal formats and are validated before domain use.
import { cloneStoreForStaging } from "./journal-codecs"
import { resolve } from "node:path"
import { RAW_TELEMETRY_TTL_COLUMNS, readRawTelemetryRetentionDays, type Chdb } from "../chdb"
import type {
	LocalStoreMigrationModule,
	MigrationModuleContext,
	MigrationOperation,
	StateDispositionEntry,
} from "../local-store-migration-module"
import { withRawTelemetryRetentionFloor } from "../schema-manifest"
import {
	LOCAL_SCHEMA_V16,
	LOCAL_SCHEMA_V16_MANIFEST,
	LOCAL_SCHEMA_V16_SQL,
	LOCAL_SCHEMA_V17,
	LOCAL_SCHEMA_V17_MANIFEST,
	LOCAL_SCHEMA_V17_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

const RAW_TABLES = RAW_TELEMETRY_TTL_COLUMNS.map(([table]) => table)

const MODULE_ID = "local-0016-to-0017-audit-log" as const

/**
 * The local mirror of ClickHouse migration 0027.
 *
 * Purely additive: v17 introduces the `audit_log` table and touches nothing
 * else — no existing table is read, rewritten or dropped, no view is replaced,
 * and no row moves. Bootstrapping the v17 DDL over the cloned v16 store creates
 * it through `CREATE TABLE IF NOT EXISTS`; every other statement is a no-op
 * against objects that already exist.
 *
 * Nothing is backfilled, and there is nothing to backfill: local mode has no
 * authenticated actors, so the table starts and stays empty here. It exists so
 * a local store keeps mirroring the deployed schema.
 *
 * Every statement is idempotent, so a resume after a crash lands in the same
 * place.
 */

interface V16ToV17State {
	readonly module: typeof MODULE_ID
	readonly version: 1
	readonly rawRows: Readonly<Record<string, string>>
	readonly retentionDays?: number
}

interface V16ToV17Progress {
	readonly installed: true
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value)

const decodeCounts = (value: unknown): Readonly<Record<string, string>> => {
	if (!isRecord(value)) throw new Error("v16 -> v17 rawRows must be an object")
	const counts: Record<string, string> = {}
	for (const table of RAW_TABLES) {
		const count = value[table]
		if (!isCount(count)) throw new Error(`v16 -> v17 rawRows.${table} must be an unsigned decimal string`)
		counts[table] = count
	}
	if (Object.keys(value).some((table) => !RAW_TABLES.includes(table as (typeof RAW_TABLES)[number])))
		throw new Error("v16 -> v17 rawRows contains an unknown table")
	return counts
}

const decodeState = (value: unknown): V16ToV17State => {
	if (!isRecord(value)) throw new Error("v16 -> v17 state must be an object")
	const allowed = new Set(["module", "version", "rawRows", "retentionDays"])
	if (Object.keys(value).some((key) => !allowed.has(key)))
		throw new Error("v16 -> v17 state contains an unknown field")
	if (value.module !== MODULE_ID || value.version !== 1)
		throw new Error("v16 -> v17 state has an unsupported module or version")
	if (
		value.retentionDays !== undefined &&
		(typeof value.retentionDays !== "number" || !Number.isSafeInteger(value.retentionDays))
	)
		throw new Error("v16 -> v17 retentionDays must be an integer")
	return {
		module: MODULE_ID,
		version: 1,
		rawRows: decodeCounts(value.rawRows),
		...(!(value.retentionDays === undefined) ? { retentionDays: value.retentionDays } : undefined),
	}
}

const decodeProgress = (value: unknown): V16ToV17Progress | undefined => {
	if (value === undefined) return undefined
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "installed") || value.installed !== true)
		throw new Error("v16 -> v17 progress is invalid")
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

const expectedManifest = (manifest: typeof LOCAL_SCHEMA_V16_MANIFEST, retentionDays: number | undefined) =>
	retentionDays === undefined
		? manifest
		: withRawTelemetryRetentionFloor(manifest, RAW_TABLES, retentionDays)

const preflight = async (context: MigrationModuleContext): Promise<V16ToV17State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const rawRows = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V16_MANIFEST, retentionDays))
			return rawRowCounts(db)
		},
		{ schemaSql: LOCAL_SCHEMA_V16_SQL, bootstrapSchema: false },
	)
	return {
		module: MODULE_ID,
		version: 1,
		rawRows,
		...(!(retentionDays === undefined) ? { retentionDays } : undefined),
	}
}

const prepareTarget = async (
	context: MigrationModuleContext,
	state: V16ToV17State,
): Promise<V16ToV17State> => {
	await context.closeStores()
	const source = resolve(context.sourceDataDir)
	const target = resolve(context.targetDataDir)
	if (source !== target) {
		await cloneStoreForStaging(source, target)
	}
	return state
}

const apply = async (context: MigrationModuleContext): Promise<V16ToV17Progress> =>
	// The v17 bootstrap creates `audit_log`; every other object already exists
	// and its `IF NOT EXISTS` is a no-op.
	context.openTarget(() => ({ installed: true }) as const, {
		schemaSql: LOCAL_SCHEMA_V17_SQL,
		bootstrapSchema: true,
	})

const verify = async (
	context: MigrationModuleContext,
	state: V16ToV17State,
	_progress: V16ToV17Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V17_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new Error(`v16 -> v17 raw telemetry verification failed for ${table}`)
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V17_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v16-store",
		description: "Clone the stopped v16 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "create-audit-log",
		description: "Create the empty audit_log table by bootstrapping the v17 schema",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v17-schema",
		description: "Verify the v17 physical schema and the retained raw telemetry counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v16 store is cloned byte-for-byte before the new table is created.",
	},
	{
		name: "audit_log",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "Created empty; no existing table is read, rewritten, or dropped.",
	},
]

export const v16ToV17AuditLogModule: LocalStoreMigrationModule<
	V16ToV17State,
	V16ToV17Progress
> = {
	id: MODULE_ID,
	moduleVersion: 1,
	description: "Add the audit_log table",
	from: LOCAL_SCHEMA_V16,
	to: LOCAL_SCHEMA_V17,
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
