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
	LOCAL_SCHEMA_V11,
	LOCAL_SCHEMA_V11_MANIFEST,
	LOCAL_SCHEMA_V11_SQL,
	LOCAL_SCHEMA_V12,
	LOCAL_SCHEMA_V12_MANIFEST,
	LOCAL_SCHEMA_V12_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

const RAW_TABLES = RAW_TELEMETRY_TTL_COLUMNS.map(([table]) => table)

const MODULE_ID = "local-0011-to-0012-service-map-edge-quantiles" as const

/**
 * The local mirror of ClickHouse migration 0022.
 *
 * `service_map_db_edges_hourly` and `service_external_edges_hourly` each gain a
 * sample-weighted t-digest so the service map's database nodes can report a real
 * p95 instead of the window's slowest call. Both columns are additive with an
 * empty default, so this edge moves no data: two `ADD COLUMN IF NOT EXISTS`
 * statements, then the v12 bootstrap recreates the two materialized views whose
 * SELECT now populates them.
 *
 * NOTHING IS BACKFILLED, exactly as in 0022. A materialized view's SELECT is
 * frozen at creation, so existing rollup rows keep an empty digest that merges
 * to nothing; the read path reports 0 and the UI falls back to the max, labelled
 * as a max. The rollups keep 365 days against raw `traces`' 30, so a backfill
 * could only ever repair a twelfth of the retained window — and unlike the
 * managed side there is no second source to rebuild the older buckets from.
 *
 * Every statement is idempotent, so a resume after a crash between them lands in
 * the same place.
 */

interface V11ToV12State {
	readonly module: typeof MODULE_ID
	readonly version: 1
	readonly rawRows: Readonly<Record<string, string>>
	readonly edgeRows: EdgeRowCounts
	readonly retentionDays?: number
}

/**
 * Row counts for the two rollups being altered, captured before the DDL and
 * re-checked after. An `ADD COLUMN` that silently rewrote or dropped parts would
 * show up here; nothing else in this edge can move a row.
 */
interface EdgeRowCounts {
	readonly dbEdges: string
	readonly externalEdges: string
}

interface V11ToV12Progress {
	readonly installed: true
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value)

const decodeCounts = (value: unknown): Readonly<Record<string, string>> => {
	if (!isRecord(value)) throw new Error("v11 -> v12 rawRows must be an object")
	const counts: Record<string, string> = {}
	for (const table of RAW_TABLES) {
		const count = value[table]
		if (!isCount(count)) throw new Error(`v11 -> v12 rawRows.${table} must be an unsigned decimal string`)
		counts[table] = count
	}
	if (Object.keys(value).some((table) => !RAW_TABLES.includes(table as (typeof RAW_TABLES)[number])))
		throw new Error("v11 -> v12 rawRows contains an unknown table")
	return counts
}

const decodeEdgeRows = (value: unknown): EdgeRowCounts => {
	if (!isRecord(value)) throw new Error("v11 -> v12 edgeRows must be an object")
	if (Object.keys(value).some((key) => key !== "dbEdges" && key !== "externalEdges"))
		throw new Error("v11 -> v12 edgeRows contains an unknown field")
	if (!isCount(value.dbEdges))
		throw new Error("v11 -> v12 edgeRows.dbEdges must be an unsigned decimal string")
	if (!isCount(value.externalEdges))
		throw new Error("v11 -> v12 edgeRows.externalEdges must be an unsigned decimal string")
	return { dbEdges: value.dbEdges, externalEdges: value.externalEdges }
}

const decodeState = (value: unknown): V11ToV12State => {
	if (!isRecord(value)) throw new Error("v11 -> v12 state must be an object")
	const allowed = new Set(["module", "version", "rawRows", "edgeRows", "retentionDays"])
	if (Object.keys(value).some((key) => !allowed.has(key)))
		throw new Error("v11 -> v12 state contains an unknown field")
	if (value.module !== MODULE_ID || value.version !== 1)
		throw new Error("v11 -> v12 state has an unsupported module or version")
	if (
		value.retentionDays !== undefined &&
		(typeof value.retentionDays !== "number" || !Number.isSafeInteger(value.retentionDays))
	)
		throw new Error("v11 -> v12 retentionDays must be an integer")
	return {
		module: MODULE_ID,
		version: 1,
		rawRows: decodeCounts(value.rawRows),
		edgeRows: decodeEdgeRows(value.edgeRows),
		...(!(value.retentionDays === undefined) ? { retentionDays: value.retentionDays } : undefined),
	}
}

const decodeProgress = (value: unknown): V11ToV12Progress | undefined => {
	if (value === undefined) return undefined
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "installed") || value.installed !== true)
		throw new Error("v11 -> v12 progress is invalid")
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

const scalarCount = (db: Chdb, sql: string): string => {
	const rows = parseJsonEachRow<{ count: string }>(db.query(sql))
	const count = rows[0]?.count
	if (!isCount(count)) throw new Error(`v11 -> v12 count query returned no row: ${sql}`)
	return count
}

const edgeRowCounts = (db: Chdb): EdgeRowCounts => ({
	dbEdges: scalarCount(db, "SELECT toString(count()) AS count FROM service_map_db_edges_hourly"),
	externalEdges: scalarCount(db, "SELECT toString(count()) AS count FROM service_external_edges_hourly"),
})

const expectedManifest = (manifest: typeof LOCAL_SCHEMA_V11_MANIFEST, retentionDays: number | undefined) =>
	retentionDays === undefined
		? manifest
		: withRawTelemetryRetentionFloor(manifest, RAW_TABLES, retentionDays)

const preflight = async (context: MigrationModuleContext): Promise<V11ToV12State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const { rawRows, edgeRows } = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V11_MANIFEST, retentionDays))
			return { rawRows: rawRowCounts(db), edgeRows: edgeRowCounts(db) }
		},
		{ schemaSql: LOCAL_SCHEMA_V11_SQL, bootstrapSchema: false },
	)
	return {
		module: MODULE_ID,
		version: 1,
		rawRows,
		edgeRows,
		...(!(retentionDays === undefined) ? { retentionDays } : undefined),
	}
}

const prepareTarget = async (
	context: MigrationModuleContext,
	state: V11ToV12State,
): Promise<V11ToV12State> => {
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
 * Both the columns AND the view drops happen before the v12 bootstrap, in the
 * v11-schema block. The ordering is load-bearing in both directions:
 *
 *   - `CREATE TABLE IF NOT EXISTS` is a no-op against the cloned store, so the
 *     v12 snapshot alone leaves both tables without their new column — the same
 *     ordering v10 -> v11 needed for `session_events`.
 *   - `CREATE MATERIALIZED VIEW IF NOT EXISTS` is equally a no-op while the old
 *     view still exists, and a materialized view's SELECT is frozen at creation.
 *     Dropping the two views AFTER the bootstrap therefore deleted them outright:
 *     the bootstrap had already skipped them, and nothing recreated them. The
 *     native migration test caught exactly that, as `missing materialized_view`.
 *
 * So: drop first, then let the v12 bootstrap create both views with the SELECT
 * that populates `DurationQuantiles`.
 */
const apply = async (context: MigrationModuleContext): Promise<V11ToV12Progress> => {
	const digestColumn = "AggregateFunction(quantilesTDigestWeighted(0.5, 0.95), UInt64, UInt32)"
	await context.openTarget(
		(db) => {
			db.exec(
				`ALTER TABLE service_map_db_edges_hourly ADD COLUMN IF NOT EXISTS DurationQuantiles ${digestColumn}`,
			)
			db.exec(
				`ALTER TABLE service_external_edges_hourly ADD COLUMN IF NOT EXISTS DurationQuantiles ${digestColumn}`,
			)
			db.exec("DROP VIEW IF EXISTS service_map_db_edges_hourly_mv")
			db.exec("DROP VIEW IF EXISTS service_external_edges_hourly_mv")
		},
		{ schemaSql: LOCAL_SCHEMA_V11_SQL, bootstrapSchema: false },
	)
	return context.openTarget(() => ({ installed: true }) as const, {
		schemaSql: LOCAL_SCHEMA_V12_SQL,
		bootstrapSchema: true,
	})
}

const verify = async (
	context: MigrationModuleContext,
	state: V11ToV12State,
	_progress: V11ToV12Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V12_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new Error(`v11 -> v12 raw telemetry verification failed for ${table}`)
			}
			// The rollups are the tables being altered. An additive column must not
			// move a row, so these are equalities rather than lower bounds — a part
			// rewrite that dropped rows is the one way this edge could lose data.
			const edgeRows = edgeRowCounts(db)
			for (const key of ["dbEdges", "externalEdges"] as const) {
				if (edgeRows[key] !== state.edgeRows[key])
					throw new Error(
						`v11 -> v12 ${key} row count changed: expected ${state.edgeRows[key]}, found ${edgeRows[key]}`,
					)
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V12_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v11-store",
		description: "Clone the stopped v11 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "add-edge-duration-quantiles",
		description:
			"Add the DurationQuantiles t-digest column to service_map_db_edges_hourly and service_external_edges_hourly",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "recreate-edge-views",
		description:
			"Recreate the two service-map edge materialized views so new rows carry a sample-weighted duration digest",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v12-schema",
		description:
			"Verify the v12 physical schema, retained raw telemetry counts, and the rollup row counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v11 store is cloned byte-for-byte before any DDL runs.",
	},
	{
		name: "service_map_db_edges_hourly",
		classification: "derived",
		disposition: "preserve-exact",
		guarantee:
			"One column is added as a metadata-only default; no part is rewritten, the row count is verified unchanged, and every existing row reads back with an empty digest.",
	},
	{
		name: "service_external_edges_hourly",
		classification: "derived",
		disposition: "preserve-exact",
		guarantee:
			"One column is added as a metadata-only default; no part is rewritten and the row count is verified unchanged.",
	},
	{
		// Recreated, not rebuilt: a view's SELECT is frozen at creation, so the
		// new column is only populated for rows arriving after this edge. Rows
		// already in the rollups keep an empty digest, which merges to nothing —
		// the read path reports 0 and the caller falls back to the max.
		name: "service-map edge duration quantiles",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Digests accrue for buckets sealed after the migration; older buckets keep an empty state and readers fall back to the max, which is preserved alongside.",
		preservationInterval: "from the migration forward",
		sourceRetentionDays: 30,
		targetRetentionDays: 365,
	},
]

export const v11ToV12ServiceMapEdgeQuantilesModule: LocalStoreMigrationModule<
	V11ToV12State,
	V11ToV12Progress
> = {
	id: MODULE_ID,
	moduleVersion: 1,
	description:
		"Add a sample-weighted duration t-digest to the service-map database and external edge rollups so edges report a real p95",
	from: LOCAL_SCHEMA_V11,
	to: LOCAL_SCHEMA_V12,
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
