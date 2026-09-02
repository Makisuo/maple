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
	LOCAL_SCHEMA_V12,
	LOCAL_SCHEMA_V12_MANIFEST,
	LOCAL_SCHEMA_V12_SQL,
	LOCAL_SCHEMA_V13,
	LOCAL_SCHEMA_V13_MANIFEST,
	LOCAL_SCHEMA_V13_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

const RAW_TABLES = RAW_TELEMETRY_TTL_COLUMNS.map(([table]) => table)

const MODULE_ID = "local-0012-to-0013-service-operations-discriminators" as const

/**
 * The local mirror of ClickHouse migration 0023.
 *
 * Both service-operations rollups gain three counters — `ClassifiedSpanCount`,
 * `ServerSpanCount` and `RoutedSpanCount` — so a read can tell an endpoint from
 * an outbound call that merely normalizes to the same `METHOD /path` name, and a
 * route template from a raw URL path. All three are additive with a zero
 * default, so this edge moves no data: six `ADD COLUMN IF NOT EXISTS`
 * statements, then the v13 bootstrap recreates the two materialized views whose
 * SELECT now populates them.
 *
 * NOTHING IS BACKFILLED, exactly as in 0023. A materialized view's SELECT is
 * frozen at creation, so existing rollup rows keep zeros. `ClassifiedSpanCount`
 * is what makes that safe to read: only the post-migration view writes it, so a
 * bucket holding 0 for it predates this edge and its two siblings mean UNKNOWN
 * rather than NONE. Locally there is no second source to rebuild older buckets
 * from — raw telemetry keeps 30 days against the rollups' 90 and 365.
 *
 * Every statement is idempotent, so a resume after a crash between them lands in
 * the same place.
 */

interface V12ToV13State {
	readonly module: typeof MODULE_ID
	readonly version: 1
	readonly rawRows: Readonly<Record<string, string>>
	readonly rollupRows: RollupRowCounts
	readonly retentionDays?: number
}

/**
 * Row counts for the two rollups being altered, captured before the DDL and
 * re-checked after. An `ADD COLUMN` that silently rewrote or dropped parts would
 * show up here; nothing else in this edge can move a row.
 */
interface RollupRowCounts {
	readonly minutely: string
	readonly hourly: string
}

interface V12ToV13Progress {
	readonly installed: true
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value)

const decodeCounts = (value: unknown): Readonly<Record<string, string>> => {
	if (!isRecord(value)) throw new Error("v12 -> v13 rawRows must be an object")
	const counts: Record<string, string> = {}
	for (const table of RAW_TABLES) {
		const count = value[table]
		if (!isCount(count)) throw new Error(`v12 -> v13 rawRows.${table} must be an unsigned decimal string`)
		counts[table] = count
	}
	if (Object.keys(value).some((table) => !RAW_TABLES.includes(table as (typeof RAW_TABLES)[number])))
		throw new Error("v12 -> v13 rawRows contains an unknown table")
	return counts
}

const decodeRollupRows = (value: unknown): RollupRowCounts => {
	if (!isRecord(value)) throw new Error("v12 -> v13 rollupRows must be an object")
	if (Object.keys(value).some((key) => key !== "minutely" && key !== "hourly"))
		throw new Error("v12 -> v13 rollupRows contains an unknown field")
	if (!isCount(value.minutely))
		throw new Error("v12 -> v13 rollupRows.minutely must be an unsigned decimal string")
	if (!isCount(value.hourly))
		throw new Error("v12 -> v13 rollupRows.hourly must be an unsigned decimal string")
	return { minutely: value.minutely, hourly: value.hourly }
}

const decodeState = (value: unknown): V12ToV13State => {
	if (!isRecord(value)) throw new Error("v12 -> v13 state must be an object")
	const allowed = new Set(["module", "version", "rawRows", "rollupRows", "retentionDays"])
	if (Object.keys(value).some((key) => !allowed.has(key)))
		throw new Error("v12 -> v13 state contains an unknown field")
	if (value.module !== MODULE_ID || value.version !== 1)
		throw new Error("v12 -> v13 state has an unsupported module or version")
	if (
		value.retentionDays !== undefined &&
		(typeof value.retentionDays !== "number" || !Number.isSafeInteger(value.retentionDays))
	)
		throw new Error("v12 -> v13 retentionDays must be an integer")
	return {
		module: MODULE_ID,
		version: 1,
		rawRows: decodeCounts(value.rawRows),
		rollupRows: decodeRollupRows(value.rollupRows),
		...(!(value.retentionDays === undefined) ? { retentionDays: value.retentionDays } : undefined),
	}
}

const decodeProgress = (value: unknown): V12ToV13Progress | undefined => {
	if (value === undefined) return undefined
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "installed") || value.installed !== true)
		throw new Error("v12 -> v13 progress is invalid")
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
	if (!isCount(count)) throw new Error(`v12 -> v13 count query returned no row: ${sql}`)
	return count
}

const rollupRowCounts = (db: Chdb): RollupRowCounts => ({
	minutely: scalarCount(db, "SELECT toString(count()) AS count FROM service_operations_minutely"),
	hourly: scalarCount(db, "SELECT toString(count()) AS count FROM service_operations_hourly"),
})

const expectedManifest = (manifest: typeof LOCAL_SCHEMA_V12_MANIFEST, retentionDays: number | undefined) =>
	retentionDays === undefined
		? manifest
		: withRawTelemetryRetentionFloor(manifest, RAW_TABLES, retentionDays)

const preflight = async (context: MigrationModuleContext): Promise<V12ToV13State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const { rawRows, rollupRows } = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V12_MANIFEST, retentionDays))
			return { rawRows: rawRowCounts(db), rollupRows: rollupRowCounts(db) }
		},
		{ schemaSql: LOCAL_SCHEMA_V12_SQL, bootstrapSchema: false },
	)
	return {
		module: MODULE_ID,
		version: 1,
		rawRows,
		rollupRows,
		...(!(retentionDays === undefined) ? { retentionDays } : undefined),
	}
}

const prepareTarget = async (
	context: MigrationModuleContext,
	state: V12ToV13State,
): Promise<V12ToV13State> => {
	await context.closeStores()
	const source = resolve(context.sourceDataDir)
	const target = resolve(context.targetDataDir)
	if (source !== target) {
		await cloneStoreForStaging(source, target)
	}
	return state
}

/**
 * Both the columns AND the view drops happen before the v13 bootstrap, in the
 * v12-schema block. The ordering is load-bearing in both directions:
 *
 *   - `CREATE TABLE IF NOT EXISTS` is a no-op against the cloned store, so the
 *     v12 snapshot alone leaves both tables without their new column — the same
 *     ordering v11 -> v12 needed for the service-map edge rollups.
 *   - `CREATE MATERIALIZED VIEW IF NOT EXISTS` is equally a no-op while the old
 *     view still exists, and a materialized view's SELECT is frozen at creation.
 *     Dropping the two views AFTER the bootstrap therefore deleted them outright:
 *     the bootstrap had already skipped them, and nothing recreated them. The
 *     native migration test caught exactly that, as `missing materialized_view`.
 *
 * So: drop first, then let the v13 bootstrap create both views with the SELECT
 * that populates `DurationQuantiles`.
 */
const apply = async (context: MigrationModuleContext): Promise<V12ToV13Progress> => {
	const counter = "SimpleAggregateFunction(sum, UInt64)"
	await context.openTarget(
		(db) => {
			for (const table of ["service_operations_minutely", "service_operations_hourly"] as const) {
				for (const column of ["ClassifiedSpanCount", "ServerSpanCount", "RoutedSpanCount"] as const) {
					db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${counter}`)
				}
			}
			db.exec("DROP VIEW IF EXISTS service_operations_minutely_mv")
			db.exec("DROP VIEW IF EXISTS service_operations_hourly_mv")
		},
		{ schemaSql: LOCAL_SCHEMA_V12_SQL, bootstrapSchema: false },
	)
	return context.openTarget(() => ({ installed: true }) as const, {
		schemaSql: LOCAL_SCHEMA_V13_SQL,
		bootstrapSchema: true,
	})
}

const verify = async (
	context: MigrationModuleContext,
	state: V12ToV13State,
	_progress: V12ToV13Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V13_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new Error(`v12 -> v13 raw telemetry verification failed for ${table}`)
			}
			// The rollups are the tables being altered. An additive column must not
			// move a row, so these are equalities rather than lower bounds — a part
			// rewrite that dropped rows is the one way this edge could lose data.
			const rollupRows = rollupRowCounts(db)
			for (const key of ["minutely", "hourly"] as const) {
				if (rollupRows[key] !== state.rollupRows[key])
					throw new Error(
						`v12 -> v13 ${key} row count changed: expected ${state.rollupRows[key]}, found ${rollupRows[key]}`,
					)
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V13_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v12-store",
		description: "Clone the stopped v12 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "add-operation-discriminators",
		description:
			"Add the ClassifiedSpanCount, ServerSpanCount and RoutedSpanCount counters to both service-operations rollups",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "recreate-operation-views",
		description:
			"Recreate both service-operations materialized views so new rows count server and routed spans",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v13-schema",
		description:
			"Verify the v13 physical schema, retained raw telemetry counts, and the rollup row counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v12 store is cloned byte-for-byte before any DDL runs.",
	},
	{
		name: "service_operations_minutely",
		classification: "derived",
		disposition: "preserve-exact",
		guarantee:
			"Three counter columns are added as metadata-only defaults; no part is rewritten, the row count is verified unchanged, and every existing row reads back as zero — which ClassifiedSpanCount marks as unknown rather than none.",
	},
	{
		name: "service_operations_hourly",
		classification: "derived",
		disposition: "preserve-exact",
		guarantee:
			"Three counter columns are added as metadata-only defaults; no part is rewritten and the row count is verified unchanged.",
	},
	{
		// Recreated, not rebuilt: a view's SELECT is frozen at creation, so the
		// new column is only populated for rows arriving after this edge. Rows
		// already in the rollups keep an empty digest, which merges to nothing —
		// the read path reports 0 and the caller falls back to the max.
		name: "service-operations discriminators",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Counters accrue for buckets sealed after the migration; older buckets keep zeros, which ClassifiedSpanCount = 0 marks as unclassified so readers treat them as unknown rather than as having no server or routed spans.",
		preservationInterval: "from the migration forward",
		sourceRetentionDays: 30,
		targetRetentionDays: 365,
	},
]

export const v12ToV13ServiceOperationsDiscriminatorsModule: LocalStoreMigrationModule<
	V12ToV13State,
	V12ToV13Progress
> = {
	id: MODULE_ID,
	moduleVersion: 1,
	description:
		"Count server and routed spans per service operation so endpoints can be told apart from outbound calls and raw URL paths",
	from: LOCAL_SCHEMA_V12,
	to: LOCAL_SCHEMA_V13,
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
