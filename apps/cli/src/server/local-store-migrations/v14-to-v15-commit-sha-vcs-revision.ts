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
	LOCAL_SCHEMA_V14,
	LOCAL_SCHEMA_V14_MANIFEST,
	LOCAL_SCHEMA_V14_SQL,
	LOCAL_SCHEMA_V15,
	LOCAL_SCHEMA_V15_MANIFEST,
	LOCAL_SCHEMA_V15_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

/** Stamped into the journal and matched on the way back out. */
const MODULE_ID = "local-0014-to-0015-commit-sha-vcs-revision" as const

const V14ToV15StateCodec = makeRawRowsState(MODULE_ID)

type V14ToV15State = typeof V14ToV15StateCodec.schema.Type
type V14ToV15Progress = InstalledProgress

const decodeState = V14ToV15StateCodec.decode
const decodeProgress = decodeInstalledProgress

/**
 * The three views whose body pre-extracts `CommitSha`.
 *
 * The bundled v15 DDL is `CREATE ... IF NOT EXISTS` throughout, so a view whose
 * body changed has to be dropped first or the v14 version simply survives — the
 * same trap the v9 -> v10 edge documents. No table or column changes here: the
 * `TO` targets are identical in v14 and v15.
 *
 * chDB materializes views as tables, so `DROP TABLE` is the right verb.
 */
const DROPPED_VIEWS = [
	"service_overview_hourly_mv",
	"service_overview_minutely_mv",
	"service_overview_spans_mv",
] as const

const preflight = async (context: MigrationModuleContext): Promise<V14ToV15State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const rawRows = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V14_MANIFEST, retentionDays))
			return rawRowCounts(db)
		},
		{ schemaSql: LOCAL_SCHEMA_V14_SQL, bootstrapSchema: false },
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
	state: V14ToV15State,
): Promise<V14ToV15State> => {
	await context.closeStores()
	const source = resolve(context.sourceDataDir)
	const target = resolve(context.targetDataDir)
	if (source !== target) {
		await cloneStoreForStaging(source, target)
	}
	return state
}

/**
 * The local mirror of ClickHouse migration 0025: the three service-overview
 * views now pre-extract `CommitSha` from the semconv `vcs.ref.head.revision`
 * instead of Maple's retired vendor key `deployment.commit_sha`. A service
 * instrumented to the semconv key only wrote an empty commit into every
 * rollup, so it had no release markers and no deploys.
 *
 * Forward-only. Rows already materialized keep what the v14 bodies wrote — an
 * empty commit for such a service — and the targets converge as their TTL
 * rolls. That is the same position a deployed cluster is in right after
 * migration 0025, and rebuilding them would mean rewriting a store this edge
 * has just promised to clone byte-for-byte.
 */
const apply = async (context: MigrationModuleContext): Promise<V14ToV15Progress> => {
	await context.openTarget(
		(db) => {
			for (const view of DROPPED_VIEWS) db.exec(`DROP TABLE IF EXISTS ${view}`)
		},
		{ schemaSql: LOCAL_SCHEMA_V14_SQL, bootstrapSchema: false },
	)
	return context.openTarget(() => ({ installed: true }), {
		schemaSql: LOCAL_SCHEMA_V15_SQL,
		bootstrapSchema: true,
	})
}

const verify = async (
	context: MigrationModuleContext,
	state: V14ToV15State,
	_progress: V14ToV15Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V15_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new Error(`v14 -> v15 raw telemetry verification failed for ${table}`)
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V15_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v14-store",
		description: "Clone the stopped v14 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "rebuild-commit-sha-views",
		description:
			"Rebuild the three service-overview views so CommitSha reads vcs.ref.head.revision instead of the retired deployment.commit_sha",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v15-schema",
		description: "Verify the v15 physical schema and retained raw telemetry counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v14 store is cloned byte-for-byte before any view is replaced.",
	},
	{
		name: "traces",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee:
			"The source of every replaced view is neither read nor rewritten; only view definitions change.",
	},
	{
		name: "service overview rollups",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Existing rows are preserved untouched; buckets materialized after the migration carry the commit under either key, and rows written with an empty CommitSha age out with the rollup TTL.",
		preservationInterval: "rollup retention horizon",
		sourceRetentionDays: 365,
		targetRetentionDays: 365,
	},
]

export const v14ToV15CommitShaVcsRevisionModule: LocalStoreMigrationModule<V14ToV15State, V14ToV15Progress> =
	{
		id: MODULE_ID,
		moduleVersion: 1,
		description:
			"Rebuild the service-overview views so CommitSha reads vcs.ref.head.revision instead of the retired deployment.commit_sha",
		from: LOCAL_SCHEMA_V14,
		to: LOCAL_SCHEMA_V15,
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
