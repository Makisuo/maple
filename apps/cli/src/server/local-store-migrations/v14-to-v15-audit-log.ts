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
	LOCAL_SCHEMA_V14,
	LOCAL_SCHEMA_V14_MANIFEST,
	LOCAL_SCHEMA_V14_SQL,
	LOCAL_SCHEMA_V15,
	LOCAL_SCHEMA_V15_MANIFEST,
	LOCAL_SCHEMA_V15_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

/** Stamped into the journal and matched on the way back out. */
const MODULE_ID = "local-0014-to-0015-audit-log" as const

const V14ToV15StateCodec = makeRawRowsState(MODULE_ID)

type V14ToV15State = typeof V14ToV15StateCodec.schema.Type
type V14ToV15Progress = InstalledProgress

const decodeState = V14ToV15StateCodec.decode
const decodeProgress = decodeInstalledProgress

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
	return retentionDays === undefined
		? { module: MODULE_ID, version: 1, rawRows }
		: { module: MODULE_ID, version: 1, rawRows, retentionDays }
}

const prepareTarget = async (context: MigrationModuleContext, state: V14ToV15State): Promise<V14ToV15State> => {
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
 * Purely additive: v15 introduces the `audit_log` table (ClickHouse migration
 * 0025) and touches nothing else. Bootstrapping the v15 DDL over the cloned v14
 * store creates it through `CREATE TABLE IF NOT EXISTS`; every existing table
 * and view is left as it is. Local mode has no authenticated actors, so the
 * table starts and stays empty here — it exists so the local schema keeps
 * mirroring the deployed one.
 */
const apply = async (context: MigrationModuleContext): Promise<V14ToV15Progress> =>
	context.openTarget(() => ({ installed: true }), {
		schemaSql: LOCAL_SCHEMA_V15_SQL,
		bootstrapSchema: true,
	})

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
		id: "create-audit-log",
		description: "Create the empty audit_log table by bootstrapping the v15 schema",
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
		guarantee: "The clean stopped v14 store is cloned byte-for-byte before the new table is created.",
	},
	{
		name: "audit_log",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "Created empty; no existing table is read, rewritten, or dropped.",
	},
]

export const v14ToV15AuditLogModule: LocalStoreMigrationModule<V14ToV15State, V14ToV15Progress> = {
	id: MODULE_ID,
	moduleVersion: 1,
	description: "Add the audit_log table",
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
