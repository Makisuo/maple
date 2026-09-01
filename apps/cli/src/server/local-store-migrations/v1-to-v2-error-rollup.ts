// SAFETY-FILE: JSON rows here come from fixed internal formats and are validated before domain use.
import { resolve } from "node:path"
import { Schema } from "effect"
import { decodeRowCounts } from "../chdb-rows"
import {
	cloneStoreForStaging,
	UnsignedDecimal,
	makeRawRowsState,
	strictDecoder,
	RAW_TABLES,
	rawRowCounts,
	expectedManifest,
} from "./journal-codecs"
import { applyRawTelemetryRetentionFloor, readRawTelemetryRetentionDays } from "../chdb"
import type {
	LocalStoreMigrationModule,
	MigrationModuleContext,
	MigrationOperation,
	StateDispositionEntry,
} from "../local-store-migration-module"
import {
	LOCAL_SCHEMA_V1,
	LOCAL_SCHEMA_V1_MANIFEST,
	LOCAL_SCHEMA_V1_SQL,
	LOCAL_SCHEMA_V2,
	LOCAL_SCHEMA_V2_MANIFEST,
	LOCAL_SCHEMA_V2_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

/** Stamped into the journal and matched on the way back out. */
const MODULE_ID = "local-0001-to-0002-error-rollup" as const

const V1ToV2StateCodec = makeRawRowsState(MODULE_ID)

/**
 * Unlike its siblings this edge backfills, so its progress is a resumable
 * cursor rather than an installed flag: how many `error_events` rows the
 * backfill has written so far, as an unsigned decimal because the count is a
 * ClickHouse UInt64.
 */
const V1ToV2ProgressSchema = Schema.Struct({ backfilledErrorEvents: UnsignedDecimal })

type V1ToV2State = typeof V1ToV2StateCodec.schema.Type
type V1ToV2Progress = typeof V1ToV2ProgressSchema.Type

const decodeState = V1ToV2StateCodec.decode
const decodeV1ToV2Progress = strictDecoder(V1ToV2ProgressSchema)
const decodeProgress = (value: unknown): V1ToV2Progress | undefined =>
	value === undefined ? undefined : decodeV1ToV2Progress(value)

const preflight = async (context: MigrationModuleContext): Promise<V1ToV2State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const rawRows = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V1_MANIFEST, retentionDays))
			return rawRowCounts(db)
		},
		{ schemaSql: LOCAL_SCHEMA_V1_SQL, bootstrapSchema: false },
	)
	// Two literals rather than a conditional spread: `retentionDays` is an
	// `optionalKey`, so an absent floor has to be an absent key, not a present
	// `undefined`.
	return retentionDays === undefined
		? { module: MODULE_ID, version: 1, rawRows }
		: { module: MODULE_ID, version: 1, rawRows, retentionDays }
}

const prepareTarget = async (context: MigrationModuleContext, state: V1ToV2State): Promise<V1ToV2State> => {
	await context.closeStores()
	const source = resolve(context.sourceDataDir)
	const target = resolve(context.targetDataDir)
	if (source !== target) {
		await cloneStoreForStaging(source, target)
	}
	return state
}

const backfillSql = `INSERT INTO error_fingerprints_minutely
SELECT
	OrgId,
	toStartOfMinute(Timestamp) AS Minute,
	FingerprintHash,
	anyLast(ServiceName) AS ServiceName,
	anyLast(ExceptionType) AS ExceptionType,
	anyLast(ExceptionMessage) AS ExceptionMessage,
	anyLast(ErrorLabel) AS ErrorLabel,
	anyLast(TopFrame) AS TopFrame,
	count() AS OccurrenceCount,
	min(Timestamp) AS FirstSeen,
	max(Timestamp) AS LastSeen
FROM error_events
GROUP BY OrgId, Minute, FingerprintHash`

const apply = async (
	context: MigrationModuleContext,
	state: V1ToV2State,
	_progress: V1ToV2Progress | undefined,
): Promise<V1ToV2Progress> => {
	await context.openTarget(
		(db) => {
			db.exec("DROP TABLE IF EXISTS error_fingerprints_minutely_mv")
			db.exec("DROP TABLE IF EXISTS error_fingerprints_minutely")
			db.exec("DROP TABLE IF EXISTS error_events_by_time_mv")
		},
		{ schemaSql: LOCAL_SCHEMA_V1_SQL, bootstrapSchema: false },
	)
	return context.openTarget(
		(db) => {
			if (state.retentionDays !== undefined) applyRawTelemetryRetentionFloor(db, state.retentionDays)
			db.exec(backfillSql)
			const [row] = decodeRowCounts(
				db.query(
					"SELECT toString(sum(OccurrenceCount)) AS rowCount FROM error_fingerprints_minutely",
				),
			)
			return { backfilledErrorEvents: row?.rowCount ?? "0" }
		},
		{ schemaSql: LOCAL_SCHEMA_V2_SQL, bootstrapSchema: true },
	)
}

const verify = async (
	context: MigrationModuleContext,
	state: V1ToV2State,
	progress: V1ToV2Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V2_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new Error(`v1 -> v2 raw telemetry verification failed for ${table}`)
			}
			const [row] = decodeRowCounts(db.query("SELECT toString(count()) AS rowCount FROM error_events"))
			if ((row?.rowCount ?? "0") !== progress.backfilledErrorEvents)
				throw new Error("v1 -> v2 error rollup backfill verification failed")
		},
		{ schemaSql: LOCAL_SCHEMA_V2_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v1-store",
		description: "Clone the stopped v1 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "replace-error-rollups",
		description: "Replace the error fan-out view and backfill the minutely fingerprint rollup",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v2-schema",
		description: "Verify the v2 physical schema, raw telemetry, and error rollup totals",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v1 store is cloned byte-for-byte before target-only DDL changes.",
	},
	{
		name: "error_fingerprints_minutely",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee: "The new rollup is rebuilt from retained canonical error_events rows.",
		preservationInterval: "error_events retention horizon",
		sourceRetentionDays: 90,
		targetRetentionDays: 90,
	},
]

export const v1ToV2ErrorRollupModule: LocalStoreMigrationModule<V1ToV2State, V1ToV2Progress> = {
	id: MODULE_ID,
	moduleVersion: 1,
	description: "Add the durable minutely error-fingerprint rollup to a v1 local store",
	from: LOCAL_SCHEMA_V1,
	to: LOCAL_SCHEMA_V2,
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
