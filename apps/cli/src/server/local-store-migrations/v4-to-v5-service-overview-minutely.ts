// SAFETY-FILE: JSON rows here come from fixed internal formats and are validated before domain use.
import { cp, mkdir, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { decodeInstalledProgress, makeRawRowsState, type InstalledProgress } from "./journal-codecs"
import { RAW_TELEMETRY_TTL_COLUMNS, readRawTelemetryRetentionDays, type Chdb } from "../chdb"
import type {
	LocalStoreMigrationModule,
	MigrationModuleContext,
	MigrationOperation,
	StateDispositionEntry,
} from "../local-store-migration-module"
import { withRawTelemetryRetentionFloor } from "../schema-manifest"
import {
	LOCAL_SCHEMA_V4,
	LOCAL_SCHEMA_V4_MANIFEST,
	LOCAL_SCHEMA_V4_SQL,
	LOCAL_SCHEMA_V5,
	LOCAL_SCHEMA_V5_MANIFEST,
	LOCAL_SCHEMA_V5_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

const RAW_TABLES = RAW_TELEMETRY_TTL_COLUMNS.map(([table]) => table)

/** Stamped into the journal and matched on the way back out. */
const MODULE_ID = "local-0004-to-0005-service-overview-minutely" as const

const V4ToV5StateCodec = makeRawRowsState(MODULE_ID)

type V4ToV5State = typeof V4ToV5StateCodec.schema.Type
type V4ToV5Progress = InstalledProgress

const decodeState = V4ToV5StateCodec.decode
const decodeProgress = decodeInstalledProgress

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

const expectedManifest = (manifest: typeof LOCAL_SCHEMA_V4_MANIFEST, retentionDays: number | undefined) =>
	retentionDays === undefined
		? manifest
		: withRawTelemetryRetentionFloor(manifest, RAW_TABLES, retentionDays)

const preflight = async (context: MigrationModuleContext): Promise<V4ToV5State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const rawRows = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V4_MANIFEST, retentionDays))
			return rawRowCounts(db)
		},
		{ schemaSql: LOCAL_SCHEMA_V4_SQL, bootstrapSchema: false },
	)
	// Two literals rather than a conditional spread: `retentionDays` is an
	// `optionalKey`, so an absent floor has to be an absent key, not a present
	// `undefined`.
	return retentionDays === undefined
		? { module: MODULE_ID, version: 1, rawRows }
		: { module: MODULE_ID, version: 1, rawRows, retentionDays }
}

const prepareTarget = async (context: MigrationModuleContext, state: V4ToV5State): Promise<V4ToV5State> => {
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
 * Purely additive, exactly like v3 -> v4: one new table and the view that fills
 * it. Nothing existing is dropped or rewritten, so there is no pre-step.
 *
 * `service_overview_minutely` starts empty and fills forward only — a
 * materialized view is an insert trigger, so it sees nothing already in the
 * store. That is the same position a deployed cluster is in immediately after
 * migration 0015 on managed Tinybird, and it is bounded here in a way it is not
 * there: the minute tier is only consulted for windows under ~5 days, so the
 * store is self-sufficient again within days of the upgrade, and until then the
 * read path's hour tier and raw edge still answer. Backfilling would mean
 * rewriting a store we have just promised to clone byte-for-byte.
 */
const apply = async (context: MigrationModuleContext): Promise<V4ToV5Progress> =>
	context.openTarget(() => ({ installed: true }), {
		schemaSql: LOCAL_SCHEMA_V5_SQL,
		bootstrapSchema: true,
	})

const verify = async (
	context: MigrationModuleContext,
	state: V4ToV5State,
	_progress: V4ToV5Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V5_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new Error(`v4 -> v5 raw telemetry verification failed for ${table}`)
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V5_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v4-store",
		description: "Clone the stopped v4 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "install-service-overview-minutely",
		description: "Install the service_overview_minutely rollup and its materialized view",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v5-schema",
		description: "Verify the v5 physical schema and retained raw telemetry counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v4 store is cloned byte-for-byte before additive DDL runs.",
	},
	{
		name: "traces",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee:
			"The source of the new view is neither read nor rewritten; service_overview_minutely fills from writes made after the migration.",
	},
	{
		// Created empty and filled forward by the view, never backfilled — the
		// store was just promised byte-for-byte. It converges fast: the tier is
		// only read for windows under ~5 days, so once that horizon passes there
		// is nothing left for it to be missing, and the hourly tier plus the raw
		// edge answer in the interim.
		name: "service_overview_minutely",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Filled forward from traces writes; complete by construction once the ~5-day sub-hour bucket horizon passes, with the hourly tier and raw edge covering the interim.",
		preservationInterval: "sub-hour bucket horizon",
		sourceRetentionDays: 30,
		targetRetentionDays: 90,
	},
]

export const v4ToV5ServiceOverviewMinutelyModule: LocalStoreMigrationModule<V4ToV5State, V4ToV5Progress> = {
	id: MODULE_ID,
	moduleVersion: 1,
	description: "Add the service_overview_minutely rollup and its materialized view to v4",
	from: LOCAL_SCHEMA_V4,
	to: LOCAL_SCHEMA_V5,
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
