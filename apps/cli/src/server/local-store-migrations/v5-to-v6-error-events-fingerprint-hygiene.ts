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
	readonly module: "local-0005-to-0006-error-events-fingerprint-hygiene"
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
	if (value.module !== "local-0005-to-0006-error-events-fingerprint-hygiene" || value.version !== 1)
		throw new Error("v5 -> v6 state has an unsupported module or version")
	if (
		value.retentionDays !== undefined &&
		(typeof value.retentionDays !== "number" || !Number.isSafeInteger(value.retentionDays))
	)
		throw new Error("v5 -> v6 retentionDays must be an integer")
	return {
		module: "local-0005-to-0006-error-events-fingerprint-hygiene",
		version: 1,
		rawRows: decodeCounts(value.rawRows),
		...(!(value.retentionDays === undefined) ? { retentionDays: value.retentionDays } : undefined),
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
		module: "local-0005-to-0006-error-events-fingerprint-hygiene",
		version: 1,
		rawRows,
		...(!(retentionDays === undefined) ? { retentionDays } : undefined),
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
 * Unlike v3 -> v4 and v4 -> v5, this edge is not additive: it replaces the body
 * of two existing views. A materialized view's SELECT is frozen at creation and
 * the bundled DDL uses `CREATE ... IF NOT EXISTS`, so both views must be dropped
 * first — same shape as v2 -> v3. Dropping a view never touches rows already in
 * its target table.
 *
 * The new body (a) stops materializing exception-less 4xx client spans, which
 * Cloudflare Workers marks Error and which arrived as unlabelled "Unknown Error"
 * issues, and (b) redacts long hex and 6+ digit runs from the fingerprint frames
 * so a trace id in the top stack line no longer splits one bug into one issue
 * per occurrence.
 *
 * Historical `error_events` / `error_events_by_time` rows are left exactly as
 * they are. Recomputing FingerprintHash would re-bucket every existing local
 * issue, and the 4xx noise already stored cannot be identified after the fact —
 * neither table keeps the HTTP status attribute. Both effects are forward-only
 * and the stale rows age out with the tables' TTL, matching what a deployed
 * cluster gets from ClickHouse migration 0016.
 */
const apply = async (context: MigrationModuleContext): Promise<V5ToV6Progress> => {
	await context.openTarget(
		(db) => {
			db.exec("DROP TABLE IF EXISTS error_events_mv")
			db.exec("DROP TABLE IF EXISTS error_events_by_time_mv")
		},
		{ schemaSql: LOCAL_SCHEMA_V5_SQL, bootstrapSchema: false },
	)
	return context.openTarget(() => ({ installed: true }), {
		schemaSql: LOCAL_SCHEMA_V6_SQL,
		bootstrapSchema: true,
	})
}

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
		id: "rebuild-error-events-views",
		description: "Drop and recreate the error-events views with the 4xx guard and widened id redaction",
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
		guarantee: "The clean stopped v5 store is cloned byte-for-byte before the views are replaced.",
	},
	{
		name: "traces",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee:
			"The source of the replaced views is neither read nor rewritten; only the view definitions change.",
	},
	{
		// Rows already materialized keep their old fingerprint and still include
		// the 4xx noise — recomputing hashes would re-bucket every existing issue,
		// and the stored rows carry no HTTP status to filter on. Forward-only, and
		// bounded by the tables' 90-day TTL.
		name: "error_events",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Existing rows are preserved untouched; the corrected fingerprint and 4xx exclusion apply to events materialized after the migration and converge as the retention window rolls.",
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
]

export const v5ToV6ErrorEventsFingerprintHygieneModule: LocalStoreMigrationModule<
	V5ToV6State,
	V5ToV6Progress
> = {
	id: "local-0005-to-0006-error-events-fingerprint-hygiene",
	moduleVersion: 1,
	description:
		"Rebuild the error-events views: exclude exception-less 4xx client spans and redact ids from fingerprint frames",
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
