// SAFETY-FILE: JSON rows here come from fixed internal formats and are validated before domain use.
import { cp, mkdir, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
	decodeInstalledProgress,
	makeRawRowsState,
	type InstalledProgress,
	RAW_TABLES,
	rawRowCounts,
	expectedManifest,
} from "./journal-codecs"
import { readRawTelemetryRetentionDays } from "../chdb"
import type {
	LocalStoreMigrationModule,
	MigrationModuleContext,
	MigrationOperation,
	StateDispositionEntry,
} from "../local-store-migration-module"
import {
	LOCAL_SCHEMA_V8,
	LOCAL_SCHEMA_V8_MANIFEST,
	LOCAL_SCHEMA_V8_SQL,
	LOCAL_SCHEMA_V9,
	LOCAL_SCHEMA_V9_MANIFEST,
	LOCAL_SCHEMA_V9_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

/** Stamped into the journal and matched on the way back out. */
const MODULE_ID = "local-0008-to-0009-mv-sweep" as const

const V8ToV9StateCodec = makeRawRowsState(MODULE_ID)

type V8ToV9State = typeof V8ToV9StateCodec.schema.Type
type V8ToV9Progress = InstalledProgress

const decodeState = V8ToV9StateCodec.decode
const decodeProgress = decodeInstalledProgress

/**
 * Views and tables this edge must remove before the v9 DDL installs.
 *
 * The bundled DDL is `CREATE ... IF NOT EXISTS` throughout, so a view whose body
 * changed has to be dropped or the v8 version simply survives. `error_spans` and
 * its view go further — they are gone from v9 entirely, and `assertPhysicalSchema`
 * fails on LEFTOVER objects, not only missing ones (`unexpected materialized_view`).
 * A clone-only edge would therefore fail verification rather than silently drift.
 *
 * chDB materializes views as tables, so `DROP TABLE` is the right verb for both —
 * the same spelling v5 -> v6 and v7 -> v8 use.
 *
 * ORDER: every view precedes the table it writes into. The inverse leaves an MV
 * pointing at a missing target and wedges inserts into the source table.
 */
const DROPPED_VIEWS = [
	"error_spans_mv",
	"trace_detail_spans_mv",
	"log_attribute_values_mv",
	"metric_attribute_values_mv",
	"trace_span_attribute_values_mv",
	"trace_resource_attribute_values_mv",
	"span_metrics_calls_hourly_mv",
] as const

const DROPPED_TABLES = ["error_spans"] as const

/**
 * Columns removed from `trace_detail_spans`, dropped explicitly for the same
 * reason the views above are: the bundled v9 DDL is `CREATE TABLE IF NOT EXISTS`,
 * so on a store where the table already exists it is a no-op and the wide v8
 * table survives. Installing the narrowed schema is NOT enough — `assertPhysicalSchema`
 * then fails with `unexpected column EventsTimestamp`.
 */
const DROPPED_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
	["trace_detail_spans", "EventsTimestamp"],
	["trace_detail_spans", "EventsName"],
	["trace_detail_spans", "EventsAttributes"],
]

const preflight = async (context: MigrationModuleContext): Promise<V8ToV9State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const rawRows = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V8_MANIFEST, retentionDays))
			return rawRowCounts(db)
		},
		{ schemaSql: LOCAL_SCHEMA_V8_SQL, bootstrapSchema: false },
	)
	// Two literals rather than a conditional spread: `retentionDays` is an
	// `optionalKey`, so an absent floor has to be an absent key, not a present
	// `undefined`.
	return retentionDays === undefined
		? { module: MODULE_ID, version: 1, rawRows }
		: { module: MODULE_ID, version: 1, rawRows, retentionDays }
}

const prepareTarget = async (context: MigrationModuleContext, state: V8ToV9State): Promise<V8ToV9State> => {
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
 * The local mirror of ClickHouse migration 0019. Four changes, one edge:
 *
 *  - `error_spans` and its view are dropped outright. Nothing read them.
 *  - `trace_detail_spans` loses its three `Events*` columns, via an explicit
 *    `ALTER ... DROP COLUMN`. Declaring the narrowed table in the v9 DDL is not
 *    enough — that DDL is `CREATE TABLE IF NOT EXISTS`, so on an existing store
 *    it is a no-op and the wide v8 table survives verification as
 *    `unexpected column EventsTimestamp`. Same `IF NOT EXISTS` trap as the views.
 *  - The four attribute-value views gain a cardinality bound.
 *  - The span-metrics calls view starts matching the metric name the collector
 *    actually emits.
 *
 * Every one of these is forward-only. Rows already materialized keep whatever
 * the v8 bodies produced, and the targets converge as their TTL rolls — the same
 * position a deployed cluster is in right after migration 0019. Backfilling
 * would mean rewriting a store this edge has just promised to clone
 * byte-for-byte, and for `attribute_values_hourly` the whole point is that the
 * old rows are the ones we no longer want to keep.
 */
const apply = async (context: MigrationModuleContext): Promise<V8ToV9Progress> => {
	await context.openTarget(
		(db) => {
			for (const view of DROPPED_VIEWS) db.exec(`DROP TABLE IF EXISTS ${view}`)
			for (const table of DROPPED_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`)
			for (const [table, column] of DROPPED_COLUMNS) {
				db.exec(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${column}`)
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V8_SQL, bootstrapSchema: false },
	)
	return context.openTarget(() => ({ installed: true }), {
		schemaSql: LOCAL_SCHEMA_V9_SQL,
		bootstrapSchema: true,
	})
}

const verify = async (
	context: MigrationModuleContext,
	state: V8ToV9State,
	_progress: V8ToV9Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V9_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new Error(`v8 -> v9 raw telemetry verification failed for ${table}`)
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V9_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v8-store",
		description: "Clone the stopped v8 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "sweep-materialized-views",
		description:
			"Drop the unread error_spans table and rebuild the trace-detail, attribute-value and span-metrics views",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v9-schema",
		description: "Verify the v9 physical schema and retained raw telemetry counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v8 store is cloned byte-for-byte before any view is replaced.",
	},
	{
		name: "traces",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee:
			"The source of every replaced view is neither read nor rewritten; only view definitions and their targets change.",
	},
	{
		// Removed outright, and it does not come back — hence `invalidate` rather
		// than one of the rebuild dispositions.
		name: "error_spans",
		classification: "derived",
		disposition: "invalidate",
		guarantee:
			"Dropped permanently along with its view. It had no readers: every error query reads error_events / error_events_by_time, and the rows were reproducible from traces in any case.",
	},
	{
		// Narrowed, not rebuilt: the three Events columns had no readers.
		name: "trace_detail_spans",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Rows are preserved; the unread EventsTimestamp/EventsName/EventsAttributes columns are gone from the v9 table and converge as the 30-day window rolls.",
		preservationInterval: "trace retention horizon",
		sourceRetentionDays: 30,
		targetRetentionDays: 30,
	},
	{
		name: "attribute_values_hourly",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Existing rows are preserved untouched; the cardinality bound applies to values materialized after the migration and the unbounded history ages out with the 90-day TTL.",
		preservationInterval: "attribute retention horizon",
		sourceRetentionDays: 90,
		targetRetentionDays: 90,
	},
	{
		// Empty on every existing store: the view never matched a metric name.
		name: "span_metrics_calls_hourly",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"The rollup was empty because its view matched a name nothing emits; it begins filling from the corrected view and is complete within the 90-day horizon.",
		preservationInterval: "metric rollup horizon",
		sourceRetentionDays: 90,
		targetRetentionDays: 90,
	},
]

export const v8ToV9MvSweepModule: LocalStoreMigrationModule<V8ToV9State, V8ToV9Progress> = {
	id: MODULE_ID,
	moduleVersion: 1,
	description:
		"Drop the unread error_spans table and rebuild the trace-detail, attribute-value and span-metrics views",
	from: LOCAL_SCHEMA_V8,
	to: LOCAL_SCHEMA_V9,
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
