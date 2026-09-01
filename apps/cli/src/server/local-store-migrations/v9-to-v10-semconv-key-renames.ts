// SAFETY-FILE: JSON rows here come from fixed internal formats and are validated before domain use.
import { resolve } from "node:path"
import {
	cloneStoreForStaging,
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
	LOCAL_SCHEMA_V9,
	LOCAL_SCHEMA_V9_MANIFEST,
	LOCAL_SCHEMA_V9_SQL,
	LOCAL_SCHEMA_V10,
	LOCAL_SCHEMA_V10_MANIFEST,
	LOCAL_SCHEMA_V10_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

/** Stamped into the journal and matched on the way back out. */
const MODULE_ID = "local-0009-to-0010-semconv-key-renames" as const

const V9ToV10StateCodec = makeRawRowsState(MODULE_ID)

type V9ToV10State = typeof V9ToV10StateCodec.schema.Type
type V9ToV10Progress = InstalledProgress

const decodeState = V9ToV10StateCodec.decode
const decodeProgress = decodeInstalledProgress

/**
 * Every view whose body reads one of the renamed keys.
 *
 * The bundled v10 DDL is `CREATE ... IF NOT EXISTS` throughout, so a view whose
 * body changed has to be dropped first or the v9 version simply survives — the
 * same trap the v8 -> v9 edge documents. No table or column changes here: the
 * `TO` targets are identical in v9 and v10.
 *
 * chDB materializes views as tables, so `DROP TABLE` is the right verb.
 */
const DROPPED_VIEWS = [
	"error_events_by_time_mv",
	"error_events_mv",
	"logs_aggregates_hourly_mv",
	"service_external_edges_hourly_mv",
	"service_map_children_mv",
	"service_map_db_edges_hourly_mv",
	"service_map_db_query_shapes_hourly_mv",
	"service_map_spans_mv",
	"service_operations_minutely_mv",
	"service_overview_hourly_mv",
	"service_overview_minutely_mv",
	"service_overview_spans_mv",
	"service_platforms_hourly_mv",
	"trace_list_mv_mv",
	"traces_aggregates_hourly_mv",
] as const

const preflight = async (context: MigrationModuleContext): Promise<V9ToV10State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const rawRows = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V9_MANIFEST, retentionDays))
			return rawRowCounts(db)
		},
		{ schemaSql: LOCAL_SCHEMA_V9_SQL, bootstrapSchema: false },
	)
	// Two literals rather than a conditional spread: `retentionDays` is an
	// `optionalKey`, so an absent floor has to be an absent key, not a present
	// `undefined`.
	return retentionDays === undefined
		? { module: MODULE_ID, version: 1, rawRows }
		: { module: MODULE_ID, version: 1, rawRows, retentionDays }
}

const prepareTarget = async (context: MigrationModuleContext, state: V9ToV10State): Promise<V9ToV10State> => {
	await context.closeStores()
	const source = resolve(context.sourceDataDir)
	const target = resolve(context.targetDataDir)
	if (source !== target) {
		await cloneStoreForStaging(source, target)
	}
	return state
}

/**
 * The local mirror of ClickHouse migration 0020: every view that pre-extracts
 * `DeploymentEnv` now reads `deployment.environment.name` with the deprecated
 * `deployment.environment` as fallback, and the external-edge rollup reads
 * `messaging.destination.name` with `messaging.destination` as fallback —
 * instead of the deprecated spelling alone in both cases.
 *
 * Forward-only. Rows already materialized keep what the v9 bodies wrote — an
 * empty environment for a service that only ever sent the canonical key, a
 * system-labelled edge for a current producer span — and the targets converge as
 * their TTL rolls. That is the same position a deployed cluster is in right
 * after migration 0020, and rebuilding them would mean rewriting a store this
 * edge has just promised to clone byte-for-byte.
 */
const apply = async (context: MigrationModuleContext): Promise<V9ToV10Progress> => {
	await context.openTarget(
		(db) => {
			for (const view of DROPPED_VIEWS) db.exec(`DROP TABLE IF EXISTS ${view}`)
		},
		{ schemaSql: LOCAL_SCHEMA_V9_SQL, bootstrapSchema: false },
	)
	return context.openTarget(() => ({ installed: true }), {
		schemaSql: LOCAL_SCHEMA_V10_SQL,
		bootstrapSchema: true,
	})
}

const verify = async (
	context: MigrationModuleContext,
	state: V9ToV10State,
	_progress: V9ToV10Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V10_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new Error(`v9 -> v10 raw telemetry verification failed for ${table}`)
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V10_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v9-store",
		description: "Clone the stopped v9 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "rebuild-semconv-rename-views",
		description: "Rebuild every view that reads a renamed OTel key so it accepts both spellings",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v10-schema",
		description: "Verify the v10 physical schema and retained raw telemetry counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v9 store is cloned byte-for-byte before any view is replaced.",
	},
	{
		name: "traces",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee:
			"The source of every replaced view is neither read nor rewritten; only view definitions change.",
	},
	{
		name: "service and trace rollups",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Existing rows are preserved untouched; buckets materialized after the migration resolve both the environment and the messaging destination under either semconv spelling, and rows written with an empty DeploymentEnv or a system-labelled target age out with the rollup TTL.",
		preservationInterval: "rollup retention horizon",
		sourceRetentionDays: 365,
		targetRetentionDays: 365,
	},
]

export const v9ToV10SemconvKeyRenamesModule: LocalStoreMigrationModule<V9ToV10State, V9ToV10Progress> = {
	id: MODULE_ID,
	moduleVersion: 1,
	description: "Rebuild every view that reads a renamed OTel attribute to accept both spellings",
	from: LOCAL_SCHEMA_V9,
	to: LOCAL_SCHEMA_V10,
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
