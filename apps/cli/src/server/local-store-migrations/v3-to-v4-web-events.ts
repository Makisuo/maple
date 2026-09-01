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
	LOCAL_SCHEMA_V3,
	LOCAL_SCHEMA_V3_MANIFEST,
	LOCAL_SCHEMA_V3_SQL,
	LOCAL_SCHEMA_V4,
	LOCAL_SCHEMA_V4_MANIFEST,
	LOCAL_SCHEMA_V4_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

/** Stamped into the journal and matched on the way back out. */
const MODULE_ID = "local-0003-to-0004-web-events" as const

const V3ToV4StateCodec = makeRawRowsState(MODULE_ID)

type V3ToV4State = typeof V3ToV4StateCodec.schema.Type
type V3ToV4Progress = InstalledProgress

const decodeState = V3ToV4StateCodec.decode
const decodeProgress = decodeInstalledProgress

const preflight = async (context: MigrationModuleContext): Promise<V3ToV4State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const rawRows = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V3_MANIFEST, retentionDays))
			return rawRowCounts(db)
		},
		{ schemaSql: LOCAL_SCHEMA_V3_SQL, bootstrapSchema: false },
	)
	// Two literals rather than a conditional spread: `retentionDays` is an
	// `optionalKey`, so an absent floor has to be an absent key, not a present
	// `undefined`.
	return retentionDays === undefined
		? { module: MODULE_ID, version: 1, rawRows }
		: { module: MODULE_ID, version: 1, rawRows, retentionDays }
}

const prepareTarget = async (context: MigrationModuleContext, state: V3ToV4State): Promise<V3ToV4State> => {
	await context.closeStores()
	const source = resolve(context.sourceDataDir)
	const target = resolve(context.targetDataDir)
	if (source !== target) {
		await cloneStoreForStaging(source, target)
	}
	return state
}

/**
 * Purely additive: one new table and the view that fills it. Nothing existing is
 * dropped or rewritten, so unlike v2 -> v3 there is no pre-step here.
 *
 * `web_events` starts empty and stays that way for the store's existing history —
 * a materialized view is an insert trigger, so it only sees rows written after
 * this point. That is the same position a deployed cluster is in after migration
 * 0014, and it is why the read path keeps a raw `session_events` fallback: local
 * mode simply runs with the rollup unpopulated until fresh telemetry arrives.
 * Backfilling here would mean rewriting a store we have just promised to clone
 * byte-for-byte.
 */
const apply = async (context: MigrationModuleContext): Promise<V3ToV4Progress> =>
	context.openTarget(() => ({ installed: true }), {
		schemaSql: LOCAL_SCHEMA_V4_SQL,
		bootstrapSchema: true,
	})

const verify = async (
	context: MigrationModuleContext,
	state: V3ToV4State,
	_progress: V3ToV4Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V4_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new Error(`v3 -> v4 raw telemetry verification failed for ${table}`)
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V4_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v3-store",
		description: "Clone the stopped v3 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "install-web-events",
		description: "Install the web_events fact table and its materialized view",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v4-schema",
		description: "Verify the v4 physical schema and retained raw telemetry counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v3 store is cloned byte-for-byte before additive DDL runs.",
	},
	{
		name: "session_events",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee:
			"The source of the new view is neither read nor rewritten; web_events fills from writes made after the migration.",
	},
	{
		// Created empty and filled forward by the view, never backfilled — the
		// store was just promised byte-for-byte, and rewriting it to seed a rollup
		// would break that. It converges anyway: source and target share a 30-day
		// TTL, so once the horizon passes there is nothing left for the rollup to
		// be missing. Until then the web analytics read path falls back to raw
		// session_events, which is the same position a deployed cluster is in
		// immediately after migration 0014.
		name: "web_events",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Filled forward from session_events writes; complete by construction once the shared 30-day retention horizon passes, with the raw read path covering the interim.",
		preservationInterval: "session_events retention horizon",
		sourceRetentionDays: 30,
		targetRetentionDays: 30,
	},
]

export const v3ToV4WebEventsModule: LocalStoreMigrationModule<V3ToV4State, V3ToV4Progress> = {
	id: MODULE_ID,
	moduleVersion: 1,
	description: "Add the web_events analytics fact table and its materialized view to v3",
	from: LOCAL_SCHEMA_V3,
	to: LOCAL_SCHEMA_V4,
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
