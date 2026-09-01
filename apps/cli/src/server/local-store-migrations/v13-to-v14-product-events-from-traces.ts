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
	LOCAL_SCHEMA_V13,
	LOCAL_SCHEMA_V13_MANIFEST,
	LOCAL_SCHEMA_V13_SQL,
	LOCAL_SCHEMA_V14,
	LOCAL_SCHEMA_V14_MANIFEST,
	LOCAL_SCHEMA_V14_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

const RAW_TABLES = RAW_TELEMETRY_TTL_COLUMNS.map(([table]) => table)

const MODULE_ID = "local-0013-to-0014-product-events-from-traces" as const

/**
 * Frozen copy of ClickHouse migration 0024's trace projection. Frozen for the
 * reason every edge in this directory freezes its SQL: this module describes one
 * step in history, and importing the live projection would silently rewrite what
 * v13 -> v14 did the next time it changes.
 */
const PRODUCT_EVENTS_TRACE_COLUMNS = [
	"OrgId",
	"Timestamp",
	"Source",
	"SessionId",
	"Seq",
	"VisitorId",
	"UserId",
	"GroupId",
	"Kind",
	"EventName",
	"Host",
	"PagePath",
	"Url",
	"ServiceName",
	"Attributes",
	"TraceId",
	"SpanId",
].join(", ")

const PRODUCT_EVENTS_TRACE_PROJECTION_SQL = `OrgId,
  Timestamp,
  'trace' AS Source,
  SpanAttributes['session.id'] AS SessionId,
  0 AS Seq,
  SpanAttributes['maple.product_event.visitor_id'] AS VisitorId,
  SpanAttributes['maple.product_event.user_id'] AS UserId,
  SpanAttributes['maple.product_event.group_id'] AS GroupId,
  'custom' AS Kind,
  SpanAttributes['maple.product_event.name'] AS EventName,
  domain(SpanAttributes['maple.product_event.url']) AS Host,
  path(SpanAttributes['maple.product_event.url']) AS PagePath,
  SpanAttributes['maple.product_event.url'] AS Url,
  ServiceName,
  mapUpdate(
    CAST(
      mapFilter(
        (k, v) -> NOT startsWith(k, 'maple.product_event.')
          AND (
            NOT has(mapKeys(SpanAttributes), 'maple.product_event.include')
            OR has(
              arrayMap(
                key -> trimBoth(key),
                splitByChar(',', SpanAttributes['maple.product_event.include'])
              ),
              k
            )
          ),
        SpanAttributes
      ),
      'Map(String, String)'
    ),
    mapApply(
      (k, v) -> (substring(k, 26), v),
      mapFilter((k, v) -> startsWith(k, 'maple.product_event.prop.'), SpanAttributes)
    )
  ) AS Attributes,
  TraceId,
  SpanId`

const PRODUCT_EVENTS_TRACE_FILTER = "SpanAttributes['maple.product_event.name'] != ''"

/**
 * The local mirror of ClickHouse migration 0024.
 *
 * `product_events` gains `TraceId`/`SpanId` (`DEFAULT ''`) and a bloom filter on
 * `TraceId`, and a second view — `product_events_traces_mv` — starts projecting
 * spans the user annotated in their own code (`maple.product_event.name`) into
 * the table. The trace id is what makes a product event and the trace that
 * produced it navigable from either side.
 *
 * THE TRACE HALF IS BACKFILLED, unlike the last two edges. Every annotated span
 * still inside the local store's raw `traces` retention is re-projected, so an
 * `EventName` a user just added to their code has history the moment they
 * upgrade rather than only going forward — and the backfill is bounded by that
 * retention (30 days by default) against `product_events`' own 365, so the older
 * part of the window stays empty and accrues from here.
 *
 * `product_events_mv` — the browser feed — is dropped and recreated too. Its
 * SELECT was frozen at 15 columns and the table now has 17; the two new ones
 * default to `''`, which is the right value for a browser row, so recreating it
 * repairs nothing and instead keeps the view's text and the table's schema
 * describing the same thing.
 *
 * Every statement is idempotent — `ADD COLUMN IF NOT EXISTS`, `ADD INDEX IF NOT
 * EXISTS`, and a `DELETE WHERE Source = 'trace'` that clears exactly and only
 * what the following `INSERT` re-adds — so a resume after a crash between them
 * lands in the same place.
 */

interface V13ToV14State {
	readonly module: typeof MODULE_ID
	readonly version: 1
	readonly rawRows: Readonly<Record<string, string>>
	readonly productEventRows: ProductEventRowCounts
	readonly retentionDays?: number
}

/**
 * What `product_events` held before the edge, and what the backfill is expected
 * to add.
 *
 * `existing` is every row already in the table — at v13 none of them can be a
 * trace row, because the source did not exist — and is re-checked as an
 * EQUALITY: the backfill must add rows, never disturb one. `expectedTrace` is
 * counted from `traces` under the very filter the backfill uses, so verify
 * compares against the exact number rather than a lower bound, and an
 * `INSERT … SELECT` that half-completed shows up as a mismatch instead of
 * passing as "some rows arrived".
 */
interface ProductEventRowCounts {
	readonly existing: string
	readonly expectedTrace: string
}

interface V13ToV14Progress {
	readonly installed: true
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value)

const decodeCounts = (value: unknown): Readonly<Record<string, string>> => {
	if (!isRecord(value)) throw new Error("v13 -> v14 rawRows must be an object")
	const counts: Record<string, string> = {}
	for (const table of RAW_TABLES) {
		const count = value[table]
		if (!isCount(count)) throw new Error(`v13 -> v14 rawRows.${table} must be an unsigned decimal string`)
		counts[table] = count
	}
	if (Object.keys(value).some((table) => !RAW_TABLES.includes(table as (typeof RAW_TABLES)[number])))
		throw new Error("v13 -> v14 rawRows contains an unknown table")
	return counts
}

const decodeProductEventRows = (value: unknown): ProductEventRowCounts => {
	if (!isRecord(value)) throw new Error("v13 -> v14 productEventRows must be an object")
	if (Object.keys(value).some((key) => key !== "existing" && key !== "expectedTrace"))
		throw new Error("v13 -> v14 productEventRows contains an unknown field")
	if (!isCount(value.existing))
		throw new Error("v13 -> v14 productEventRows.existing must be an unsigned decimal string")
	if (!isCount(value.expectedTrace))
		throw new Error("v13 -> v14 productEventRows.expectedTrace must be an unsigned decimal string")
	return { existing: value.existing, expectedTrace: value.expectedTrace }
}

const decodeState = (value: unknown): V13ToV14State => {
	if (!isRecord(value)) throw new Error("v13 -> v14 state must be an object")
	const allowed = new Set(["module", "version", "rawRows", "productEventRows", "retentionDays"])
	if (Object.keys(value).some((key) => !allowed.has(key)))
		throw new Error("v13 -> v14 state contains an unknown field")
	if (value.module !== MODULE_ID || value.version !== 1)
		throw new Error("v13 -> v14 state has an unsupported module or version")
	if (
		value.retentionDays !== undefined &&
		(typeof value.retentionDays !== "number" || !Number.isSafeInteger(value.retentionDays))
	)
		throw new Error("v13 -> v14 retentionDays must be an integer")
	return {
		module: MODULE_ID,
		version: 1,
		rawRows: decodeCounts(value.rawRows),
		productEventRows: decodeProductEventRows(value.productEventRows),
		...(!(value.retentionDays === undefined) ? { retentionDays: value.retentionDays } : undefined),
	}
}

const decodeProgress = (value: unknown): V13ToV14Progress | undefined => {
	if (value === undefined) return undefined
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "installed") || value.installed !== true)
		throw new Error("v13 -> v14 progress is invalid")
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
	if (!isCount(count)) throw new Error(`v13 -> v14 count query returned no row: ${sql}`)
	return count
}

const productEventRowCounts = (db: Chdb): ProductEventRowCounts => ({
	existing: scalarCount(db, "SELECT toString(count()) AS count FROM product_events"),
	expectedTrace: scalarCount(
		db,
		`SELECT toString(count()) AS count FROM traces WHERE ${PRODUCT_EVENTS_TRACE_FILTER}`,
	),
})

const expectedManifest = (manifest: typeof LOCAL_SCHEMA_V13_MANIFEST, retentionDays: number | undefined) =>
	retentionDays === undefined
		? manifest
		: withRawTelemetryRetentionFloor(manifest, RAW_TABLES, retentionDays)

const preflight = async (context: MigrationModuleContext): Promise<V13ToV14State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const { rawRows, productEventRows } = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V13_MANIFEST, retentionDays))
			return { rawRows: rawRowCounts(db), productEventRows: productEventRowCounts(db) }
		},
		{ schemaSql: LOCAL_SCHEMA_V13_SQL, bootstrapSchema: false },
	)
	return {
		module: MODULE_ID,
		version: 1,
		rawRows,
		productEventRows,
		...(!(retentionDays === undefined) ? { retentionDays } : undefined),
	}
}

const prepareTarget = async (
	context: MigrationModuleContext,
	state: V13ToV14State,
): Promise<V13ToV14State> => {
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
 * The columns, the index AND both view drops happen before the v14 bootstrap, in
 * the v13-schema block. The ordering is load-bearing in both directions, exactly
 * as it was for v12 -> v13:
 *
 *   - `CREATE TABLE IF NOT EXISTS` is a no-op against the cloned store, so the
 *     v13 snapshot alone leaves `product_events` without its two new columns.
 *   - `CREATE MATERIALIZED VIEW IF NOT EXISTS` is equally a no-op while the old
 *     view still exists, and a view's SELECT is frozen at creation. Dropping the
 *     views AFTER the bootstrap would delete them outright — the bootstrap has
 *     already skipped them and nothing recreates them.
 *
 * The backfill then runs in the v14 block, after the bootstrap has created both
 * views. It writes `product_events` directly and the views read `session_events`
 * and `traces`, so nothing double-fires.
 */
const apply = async (context: MigrationModuleContext): Promise<V13ToV14Progress> => {
	await context.openTarget(
		(db) => {
			db.exec("ALTER TABLE product_events ADD COLUMN IF NOT EXISTS TraceId String DEFAULT ''")
			db.exec("ALTER TABLE product_events ADD COLUMN IF NOT EXISTS SpanId String DEFAULT ''")
			db.exec(
				"ALTER TABLE product_events ADD INDEX IF NOT EXISTS idx_trace_id TraceId TYPE bloom_filter GRANULARITY 4",
			)
			db.exec("DROP VIEW IF EXISTS product_events_traces_mv")
			db.exec("DROP VIEW IF EXISTS product_events_mv")
		},
		{ schemaSql: LOCAL_SCHEMA_V13_SQL, bootstrapSchema: false },
	)
	return context.openTarget(
		(db) => {
			db.exec("DELETE FROM product_events WHERE Source = 'trace'")
			db.exec(
				`INSERT INTO product_events (${PRODUCT_EVENTS_TRACE_COLUMNS}) SELECT ${PRODUCT_EVENTS_TRACE_PROJECTION_SQL} FROM traces WHERE ${PRODUCT_EVENTS_TRACE_FILTER}`,
			)
			return { installed: true } as const
		},
		{ schemaSql: LOCAL_SCHEMA_V14_SQL, bootstrapSchema: true },
	)
}

const verify = async (
	context: MigrationModuleContext,
	state: V13ToV14State,
	_progress: V13ToV14Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V14_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new Error(`v13 -> v14 raw telemetry verification failed for ${table}`)
			}
			// Split rather than a single total: an equality on the pre-existing rows
			// is what proves the backfill only ADDED, and an equality on the trace
			// rows is what proves it added all of them. A total would let one error
			// cancel the other out.
			const existing = scalarCount(
				db,
				"SELECT toString(count()) AS count FROM product_events WHERE Source != 'trace'",
			)
			if (existing !== state.productEventRows.existing)
				throw new Error(
					`v13 -> v14 pre-existing product_events row count changed: expected ${state.productEventRows.existing}, found ${existing}`,
				)
			const backfilled = scalarCount(
				db,
				"SELECT toString(count()) AS count FROM product_events WHERE Source = 'trace'",
			)
			if (backfilled !== state.productEventRows.expectedTrace)
				throw new Error(
					`v13 -> v14 backfilled trace product_events row count mismatch: expected ${state.productEventRows.expectedTrace}, found ${backfilled}`,
				)
		},
		{ schemaSql: LOCAL_SCHEMA_V14_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v13-store",
		description: "Clone the stopped v13 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "add-product-event-trace-columns",
		description:
			"Add TraceId and SpanId to product_events, plus the TraceId bloom filter the trace lookup prunes on",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "backfill-annotated-spans",
		description:
			"Project every retained span carrying maple.product_event.name into product_events as a Source='trace' row",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "recreate-product-event-views",
		description:
			"Recreate product_events_mv and create product_events_traces_mv so new rows carry TraceId and annotated spans keep arriving",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v14-schema",
		description:
			"Verify the v14 physical schema, retained raw telemetry counts, and that the backfill added exactly the annotated spans and disturbed no existing row",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v13 store is cloned byte-for-byte before any DDL runs.",
	},
	{
		name: "traces",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee:
			"Read-only source of the backfill; the row count is verified unchanged alongside every other raw telemetry table.",
	},
	{
		name: "product_events (browser, server and mobile rows)",
		classification: "derived",
		disposition: "preserve-exact",
		guarantee:
			"Two columns are added as metadata-only defaults, no part is rewritten, and the count of rows whose Source is not 'trace' is verified byte-identical after the backfill.",
	},
	{
		// Fully rebuilt within the raw window, then accrued: unlike the last two
		// edges there IS a source to re-project from, so the shorter retention is
		// the only bound.
		name: "product_events (trace rows)",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Every annotated span still inside raw traces retention is re-projected, and the resulting row count is verified to equal the count of matching spans. Annotated spans older than that window are gone from traces and cannot be rebuilt; the table accrues them from the migration forward.",
		preservationInterval: "the raw traces retention window",
		sourceRetentionDays: 30,
		targetRetentionDays: 365,
	},
]

export const v13ToV14ProductEventsFromTracesModule: LocalStoreMigrationModule<
	V13ToV14State,
	V13ToV14Progress
> = {
	id: MODULE_ID,
	moduleVersion: 1,
	description:
		"Add TraceId/SpanId to product_events and project spans annotated with maple.product_event.name into it, backfilled from retained traces",
	from: LOCAL_SCHEMA_V13,
	to: LOCAL_SCHEMA_V14,
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
