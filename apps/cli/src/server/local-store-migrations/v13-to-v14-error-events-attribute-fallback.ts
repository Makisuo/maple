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
	LOCAL_SCHEMA_V13,
	LOCAL_SCHEMA_V13_MANIFEST,
	LOCAL_SCHEMA_V13_SQL,
	LOCAL_SCHEMA_V14,
	LOCAL_SCHEMA_V14_MANIFEST,
	LOCAL_SCHEMA_V14_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

/** Stamped into the journal and matched on the way back out. */
const MODULE_ID = "local-0013-to-0014-error-events-attribute-fallback" as const

const V13ToV14StateCodec = makeRawRowsState(MODULE_ID)

type V13ToV14State = typeof V13ToV14StateCodec.schema.Type
type V13ToV14Progress = InstalledProgress

const decodeState = V13ToV14StateCodec.decode
const decodeProgress = decodeInstalledProgress

/**
 * The local mirror of ClickHouse migration 0024.
 *
 * The two error-events views took the exception type, message and stacktrace
 * from the first OTel `exception` span event alone, and fell through to
 * StatusMessage, then 'Unknown Error'. Cloudflare's native Workers tracing
 * records no span events and no status description — a custom span can only
 * `setAttribute()` — so every error span it exported hashed to one "Unknown
 * Error" issue per service. The rebuilt body reads the same three keys off
 * span attributes when there is no event, then semconv `error.type` /
 * `error.message`, before StatusMessage. A span WITH an event keeps exactly
 * the precedence it had.
 *
 * NOTHING IS BACKFILLED. `error_events` keeps no span attributes, so the
 * historical rows cannot be re-derived, and recomputing FingerprintHash would
 * re-bucket every existing local issue. Forward-only, converging as the
 * retention window rolls.
 */

const preflight = async (context: MigrationModuleContext): Promise<V13ToV14State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const rawRows = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V13_MANIFEST, retentionDays))
			return rawRowCounts(db)
		},
		{ schemaSql: LOCAL_SCHEMA_V13_SQL, bootstrapSchema: false },
	)
	// Two literals rather than a conditional spread: `retentionDays` is an
	// `optionalKey`, so an absent floor has to be an absent key, not a present
	// `undefined`.
	return retentionDays === undefined
		? { module: MODULE_ID, version: 1, rawRows }
		: { module: MODULE_ID, version: 1, rawRows, retentionDays }
}

const prepareTarget = async (
	context: MigrationModuleContext,
	state: V13ToV14State,
): Promise<V13ToV14State> => {
	await context.closeStores()
	const source = resolve(context.sourceDataDir)
	const target = resolve(context.targetDataDir)
	if (source !== target) {
		await cloneStoreForStaging(source, target)
	}
	return state
}

/**
 * Like v7 -> v8, this edge replaces the body of two existing views rather than
 * adding anything. A materialized view's SELECT is frozen at creation and the
 * bundled DDL uses `CREATE ... IF NOT EXISTS`, so both views must be dropped
 * before the v14 schema can install its versions. Dropping a view never touches
 * rows already in its target table.
 */
const apply = async (context: MigrationModuleContext): Promise<V13ToV14Progress> => {
	await context.openTarget(
		(db) => {
			db.exec("DROP TABLE IF EXISTS error_events_mv")
			db.exec("DROP TABLE IF EXISTS error_events_by_time_mv")
		},
		{ schemaSql: LOCAL_SCHEMA_V13_SQL, bootstrapSchema: false },
	)
	return context.openTarget(() => ({ installed: true }), {
		schemaSql: LOCAL_SCHEMA_V14_SQL,
		bootstrapSchema: true,
	})
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
		id: "rebuild-error-events-views",
		description:
			"Drop and recreate the error-events views so an exception-less span is labelled from its exception.* / error.* attributes",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v14-schema",
		description: "Verify the v14 physical schema and retained raw telemetry counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v13 store is cloned byte-for-byte before the views are replaced.",
	},
	{
		name: "traces",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee:
			"The source of the replaced views is neither read nor rewritten; only the view definitions change.",
	},
	{
		// Rows already materialized keep their 'Unknown Error' label and hash —
		// error_events holds no span attributes to re-derive them from, and
		// recomputing hashes would re-bucket every existing issue. Forward-only,
		// and bounded by the tables' 90-day TTL.
		name: "error_events",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Existing rows are preserved untouched; the attribute fallback applies to events materialized after the migration and converges as the retention window rolls.",
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

export const v13ToV14ErrorEventsAttributeFallbackModule: LocalStoreMigrationModule<
	V13ToV14State,
	V13ToV14Progress
> = {
	id: MODULE_ID,
	moduleVersion: 1,
	description:
		"Rebuild the error-events views so an exception-less span is labelled from its exception.* / error.* attributes",
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
