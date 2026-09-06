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
	LOCAL_SCHEMA_V18,
	LOCAL_SCHEMA_V18_MANIFEST,
	LOCAL_SCHEMA_V18_SQL,
	LOCAL_SCHEMA_V19,
	LOCAL_SCHEMA_V19_MANIFEST,
	LOCAL_SCHEMA_V19_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

const RAW_TABLES = RAW_TELEMETRY_TTL_COLUMNS.map(([table]) => table)

const MODULE_ID = "local-0018-to-0019-ai-trace-index-usage-conventions" as const

/**
 * The local mirror of ClickHouse migration 0029.
 *
 * v19 adds `ResponseId` to `ai_trace_index` — the provider's id for the
 * response, so two observations of one model call (the app's own span and a
 * gateway's mirror of it, which land in the same session as separate traces)
 * are counted once — and recreates `ai_trace_index_mv` to fill it and to
 * count `Tokens` under the reporter's own usage convention
 * (`genAiUsageConvention` in `@maple/domain`, the table the web app reads):
 * v18 summed the five `gen_ai.usage.*` buckets as if they were disjoint, and
 * on OpenAI-shaped wires — OpenRouter included — the prompt figure already
 * contains the cached tokens and the completion figure the reasoning, so a
 * cache-heavy agent loop read ~1.6x its billed tokens in the list. No row
 * moves and no table is rebuilt.
 *
 * Two things the bundled v19 DDL cannot do on its own, both done in a
 * pre-bootstrap block exactly as the v17 -> v18 edge did:
 *
 * 1. Widen the table. The DDL is `CREATE TABLE IF NOT EXISTS`, a no-op against
 *    the v18 table, so the explicit `ADD COLUMN IF NOT EXISTS` is what adds the
 *    column — metadata-only, defaulting every existing row to `''`.
 * 2. Replace the view. A materialized view's SELECT is frozen at creation, so
 *    the v18 view is dropped first or it simply survives the bootstrap's
 *    `IF NOT EXISTS`. chDB materializes views as tables, hence `DROP TABLE`.
 *
 * NOTHING IS BACKFILLED, as in 0029: rows materialized under v18 keep their
 * over-counted `Tokens` and an empty `ResponseId` — such a session ranks and
 * filters by the larger figure while its detail page shows the billed one,
 * and a gateway mirror it holds stays a second call — until raw `traces`'
 * retention ages them out. The managed side accepts the same gap.
 *
 * Every statement is idempotent, so a resume after a crash lands in the same
 * place.
 */

/** Columns v19 adds to `ai_trace_index`, with the type the v19 DDL declares. */
const ADDED_COLUMNS = [["ResponseId", "String"]] as const

interface V18ToV19State {
	readonly module: typeof MODULE_ID
	readonly version: 1
	readonly rawRows: Readonly<Record<string, string>>
	readonly retentionDays?: number
}

interface V18ToV19Progress {
	readonly installed: true
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value)

const decodeCounts = (value: unknown): Readonly<Record<string, string>> => {
	if (!isRecord(value)) throw new Error("v18 -> v19 rawRows must be an object")
	const counts: Record<string, string> = {}
	for (const table of RAW_TABLES) {
		const count = value[table]
		if (!isCount(count)) throw new Error(`v18 -> v19 rawRows.${table} must be an unsigned decimal string`)
		counts[table] = count
	}
	if (Object.keys(value).some((table) => !RAW_TABLES.includes(table as (typeof RAW_TABLES)[number])))
		throw new Error("v18 -> v19 rawRows contains an unknown table")
	return counts
}

const decodeState = (value: unknown): V18ToV19State => {
	if (!isRecord(value)) throw new Error("v18 -> v19 state must be an object")
	const allowed = new Set(["module", "version", "rawRows", "retentionDays"])
	if (Object.keys(value).some((key) => !allowed.has(key)))
		throw new Error("v18 -> v19 state contains an unknown field")
	if (value.module !== MODULE_ID || value.version !== 1)
		throw new Error("v18 -> v19 state has an unsupported module or version")
	if (
		value.retentionDays !== undefined &&
		(typeof value.retentionDays !== "number" || !Number.isSafeInteger(value.retentionDays))
	)
		throw new Error("v18 -> v19 retentionDays must be an integer")
	return {
		module: MODULE_ID,
		version: 1,
		rawRows: decodeCounts(value.rawRows),
		...(!(value.retentionDays === undefined) ? { retentionDays: value.retentionDays } : undefined),
	}
}

const decodeProgress = (value: unknown): V18ToV19Progress | undefined => {
	if (value === undefined) return undefined
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "installed") || value.installed !== true)
		throw new Error("v18 -> v19 progress is invalid")
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

const expectedManifest = (manifest: typeof LOCAL_SCHEMA_V18_MANIFEST, retentionDays: number | undefined) =>
	retentionDays === undefined
		? manifest
		: withRawTelemetryRetentionFloor(manifest, RAW_TABLES, retentionDays)

const preflight = async (context: MigrationModuleContext): Promise<V18ToV19State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const rawRows = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V18_MANIFEST, retentionDays))
			return rawRowCounts(db)
		},
		{ schemaSql: LOCAL_SCHEMA_V18_SQL, bootstrapSchema: false },
	)
	return {
		module: MODULE_ID,
		version: 1,
		rawRows,
		...(!(retentionDays === undefined) ? { retentionDays } : undefined),
	}
}

const prepareTarget = async (
	context: MigrationModuleContext,
	state: V18ToV19State,
): Promise<V18ToV19State> => {
	await context.closeStores()
	const source = resolve(context.sourceDataDir)
	const target = resolve(context.targetDataDir)
	if (source !== target) {
		await cloneStoreForStaging(source, target)
	}
	return state
}

const apply = async (context: MigrationModuleContext): Promise<V18ToV19Progress> => {
	await context.openTarget(
		(db) => {
			db.exec("DROP TABLE IF EXISTS ai_trace_index_mv")
			for (const [column, type] of ADDED_COLUMNS) {
				db.exec(`ALTER TABLE ai_trace_index ADD COLUMN IF NOT EXISTS ${column} ${type}`)
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V18_SQL, bootstrapSchema: false },
	)
	// The v19 bootstrap recreates the view with its new SELECT; every other
	// object already exists and its `IF NOT EXISTS` is a no-op.
	return context.openTarget(() => ({ installed: true }) as const, {
		schemaSql: LOCAL_SCHEMA_V19_SQL,
		bootstrapSchema: true,
	})
}

const verify = async (
	context: MigrationModuleContext,
	state: V18ToV19State,
	_progress: V18ToV19Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V19_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new Error(`v18 -> v19 raw telemetry verification failed for ${table}`)
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V19_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v18-store",
		description: "Clone the stopped v18 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "widen-ai-trace-index",
		description:
			"Add ResponseId to ai_trace_index and rebuild ai_trace_index_mv to fill it and to count Tokens under the reporter's usage convention",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v19-schema",
		description: "Verify the v19 physical schema and the retained raw telemetry counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v18 store is cloned byte-for-byte before any DDL runs.",
	},
	{
		name: "traces",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee:
			"The source of the replaced view is neither read nor rewritten; only the view definition and the index's column list change.",
	},
	{
		// Existing rows are kept with the Tokens the v18 view computed — the
		// over-count where a reporter nests its cache or reasoning — and an
		// empty ResponseId. The rebuilt MV fills both for spans ingested after
		// the edge. Forward-only, bounded by the 30-day TTL, and the same gap
		// the managed side accepts.
		name: "ai_trace_index",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Existing rows are preserved untouched with their v18 Tokens and an empty ResponseId; the rebuilt view fills both for spans materialized after the migration and the gap closes as the retention window rolls.",
		preservationInterval: "from the migration forward",
		sourceRetentionDays: 30,
		targetRetentionDays: 30,
	},
]

export const v18ToV19AiTraceIndexUsageConventionsModule: LocalStoreMigrationModule<
	V18ToV19State,
	V18ToV19Progress
> = {
	id: MODULE_ID,
	moduleVersion: 1,
	description: "Recreate ai_trace_index_mv so Tokens counts nested cache and reasoning buckets once, and add ResponseId",
	from: LOCAL_SCHEMA_V18,
	to: LOCAL_SCHEMA_V19,
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
