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
	LOCAL_SCHEMA_V17,
	LOCAL_SCHEMA_V17_MANIFEST,
	LOCAL_SCHEMA_V17_SQL,
	LOCAL_SCHEMA_V18,
	LOCAL_SCHEMA_V18_MANIFEST,
	LOCAL_SCHEMA_V18_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

const RAW_TABLES = RAW_TELEMETRY_TTL_COLUMNS.map(([table]) => table)

const MODULE_ID = "local-0017-to-0018-product-events-from-traces" as const

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

// Frozen copy of ClickHouse migration 0028's trace projection, byte-for-byte:
// the backfill and the v18 view must project a span identically.
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
 * The local mirror of ClickHouse migration 0028: `product_events` gains
 * `TraceId`/`SpanId` plus a bloom filter, `product_events_traces_mv` starts
 * projecting annotated spans, and the trace half is backfilled from whatever
 * `traces` still retains. `product_events_mv` is recreated so its SELECT names
 * the two new columns. Every statement is idempotent, so a resume lands in the
 * same place.
 */

interface V17ToV18State {
	readonly module: typeof MODULE_ID
	readonly version: 1
	readonly rawRows: Readonly<Record<string, string>>
	readonly productEventRows: ProductEventRowCounts
	readonly retentionDays?: number
}

/** Row counts verify re-checks as equalities: `existing` (non-trace rows) must be
 *  undisturbed, `expectedTrace` (spans matching the backfill filter) must all arrive. */
interface ProductEventRowCounts {
	readonly existing: string
	readonly expectedTrace: string
}

interface V17ToV18Progress {
	readonly installed: true
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value)

const decodeCounts = (value: unknown): Readonly<Record<string, string>> => {
	if (!isRecord(value)) throw new Error("v17 -> v18 rawRows must be an object")
	const counts: Record<string, string> = {}
	for (const table of RAW_TABLES) {
		const count = value[table]
		if (!isCount(count)) throw new Error(`v17 -> v18 rawRows.${table} must be an unsigned decimal string`)
		counts[table] = count
	}
	if (Object.keys(value).some((table) => !RAW_TABLES.includes(table as (typeof RAW_TABLES)[number])))
		throw new Error("v17 -> v18 rawRows contains an unknown table")
	return counts
}

const decodeProductEventRows = (value: unknown): ProductEventRowCounts => {
	if (!isRecord(value)) throw new Error("v17 -> v18 productEventRows must be an object")
	if (Object.keys(value).some((key) => key !== "existing" && key !== "expectedTrace"))
		throw new Error("v17 -> v18 productEventRows contains an unknown field")
	if (!isCount(value.existing))
		throw new Error("v17 -> v18 productEventRows.existing must be an unsigned decimal string")
	if (!isCount(value.expectedTrace))
		throw new Error("v17 -> v18 productEventRows.expectedTrace must be an unsigned decimal string")
	return { existing: value.existing, expectedTrace: value.expectedTrace }
}

const decodeState = (value: unknown): V17ToV18State => {
	if (!isRecord(value)) throw new Error("v17 -> v18 state must be an object")
	const allowed = new Set(["module", "version", "rawRows", "productEventRows", "retentionDays"])
	if (Object.keys(value).some((key) => !allowed.has(key)))
		throw new Error("v17 -> v18 state contains an unknown field")
	if (value.module !== MODULE_ID || value.version !== 1)
		throw new Error("v17 -> v18 state has an unsupported module or version")
	if (
		value.retentionDays !== undefined &&
		(typeof value.retentionDays !== "number" || !Number.isSafeInteger(value.retentionDays))
	)
		throw new Error("v17 -> v18 retentionDays must be an integer")
	return {
		module: MODULE_ID,
		version: 1,
		rawRows: decodeCounts(value.rawRows),
		productEventRows: decodeProductEventRows(value.productEventRows),
		...(!(value.retentionDays === undefined) ? { retentionDays: value.retentionDays } : undefined),
	}
}

const decodeProgress = (value: unknown): V17ToV18Progress | undefined => {
	if (value === undefined) return undefined
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "installed") || value.installed !== true)
		throw new Error("v17 -> v18 progress is invalid")
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
	if (!isCount(count)) throw new Error(`v17 -> v18 count query returned no row: ${sql}`)
	return count
}

const productEventRowCounts = (db: Chdb): ProductEventRowCounts => ({
	existing: scalarCount(db, "SELECT toString(count()) AS count FROM product_events"),
	expectedTrace: scalarCount(
		db,
		`SELECT toString(count()) AS count FROM traces WHERE ${PRODUCT_EVENTS_TRACE_FILTER}`,
	),
})

const expectedManifest = (manifest: typeof LOCAL_SCHEMA_V17_MANIFEST, retentionDays: number | undefined) =>
	retentionDays === undefined
		? manifest
		: withRawTelemetryRetentionFloor(manifest, RAW_TABLES, retentionDays)

const preflight = async (context: MigrationModuleContext): Promise<V17ToV18State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const { rawRows, productEventRows } = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V17_MANIFEST, retentionDays))
			return { rawRows: rawRowCounts(db), productEventRows: productEventRowCounts(db) }
		},
		{ schemaSql: LOCAL_SCHEMA_V17_SQL, bootstrapSchema: false },
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
	state: V17ToV18State,
): Promise<V17ToV18State> => {
	await context.closeStores()
	const source = resolve(context.sourceDataDir)
	const target = resolve(context.targetDataDir)
	if (source !== target) {
		await cloneStoreForStaging(source, target)
	}
	return state
}

// Columns, index and both view drops run in the v17 block: the v18 bootstrap is
// all `IF NOT EXISTS`, so it neither adds columns to an existing table nor
// replaces a view that is still there. The backfill runs after the bootstrap
// and writes `product_events` directly, so no view double-fires.
const apply = async (context: MigrationModuleContext): Promise<V17ToV18Progress> => {
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
		{ schemaSql: LOCAL_SCHEMA_V17_SQL, bootstrapSchema: false },
	)
	return context.openTarget(
		(db) => {
			// Scoped to the backfill's own source window, matching migration 0028:
			// `product_events` keeps 365 days and `traces` 30, so an unbounded delete
			// on a re-run would destroy rows the backfill cannot rebuild. The count
			// guard keeps an empty `traces` (min() = 1970) from doing the same.
			db.exec(
				"DELETE FROM product_events WHERE Source = 'trace' AND (SELECT count() FROM traces) > 0 AND Timestamp >= (SELECT min(Timestamp) FROM traces)",
			)
			db.exec(
				`INSERT INTO product_events (${PRODUCT_EVENTS_TRACE_COLUMNS}) SELECT ${PRODUCT_EVENTS_TRACE_PROJECTION_SQL} FROM traces WHERE ${PRODUCT_EVENTS_TRACE_FILTER}`,
			)
			return { installed: true } as const
		},
		{ schemaSql: LOCAL_SCHEMA_V18_SQL, bootstrapSchema: true },
	)
}

const verify = async (
	context: MigrationModuleContext,
	state: V17ToV18State,
	_progress: V17ToV18Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V18_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new Error(`v17 -> v18 raw telemetry verification failed for ${table}`)
			}
			// Two equalities, not a total: one proves nothing was disturbed, the
			// other that every annotated span arrived.
			const existing = scalarCount(
				db,
				"SELECT toString(count()) AS count FROM product_events WHERE Source != 'trace'",
			)
			if (existing !== state.productEventRows.existing)
				throw new Error(
					`v17 -> v18 pre-existing product_events row count changed: expected ${state.productEventRows.existing}, found ${existing}`,
				)
			const backfilled = scalarCount(
				db,
				"SELECT toString(count()) AS count FROM product_events WHERE Source = 'trace'",
			)
			if (backfilled !== state.productEventRows.expectedTrace)
				throw new Error(
					`v17 -> v18 backfilled trace product_events row count mismatch: expected ${state.productEventRows.expectedTrace}, found ${backfilled}`,
				)
		},
		{ schemaSql: LOCAL_SCHEMA_V18_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v17-store",
		description: "Clone the stopped v17 store into the staged migration target",
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
		id: "verify-v18-schema",
		description:
			"Verify the v18 physical schema, retained raw telemetry counts, and that the backfill added exactly the annotated spans and disturbed no existing row",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v17 store is cloned byte-for-byte before any DDL runs.",
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
			"Two columns are added as metadata-only defaults, no part is rewritten, and the count of rows whose Source is not 'trace' is verified unchanged after the backfill. Counts, not contents: the byte-level claim rests on ADD COLUMN being metadata-only, which this edge does not independently verify.",
	},
	{
		// Rebuilt within the raw window, then accrued: `traces` is the source, so
		// its shorter retention is the only bound.
		name: "product_events (trace rows)",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Every annotated span still inside raw traces retention is re-projected, and the resulting row count is verified to equal the count of matching spans. Annotated spans older than that window are gone from traces and cannot be rebuilt; the table accrues them from the migration forward.",
		preservationInterval: "the raw traces retention window",
		// Schema default; a custom raw-telemetry floor (`readRawTelemetryRetentionDays`)
		// overrides it and the backfill follows the store.
		sourceRetentionDays: 30,
		targetRetentionDays: 365,
	},
]

export const v17ToV18ProductEventsFromTracesModule: LocalStoreMigrationModule<
	V17ToV18State,
	V17ToV18Progress
> = {
	id: MODULE_ID,
	moduleVersion: 1,
	description:
		"Add TraceId/SpanId to product_events and project spans annotated with maple.product_event.name into it, backfilled from retained traces",
	from: LOCAL_SCHEMA_V17,
	to: LOCAL_SCHEMA_V18,
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
