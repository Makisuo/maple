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
	LOCAL_SCHEMA_V10,
	LOCAL_SCHEMA_V10_MANIFEST,
	LOCAL_SCHEMA_V10_SQL,
	LOCAL_SCHEMA_V11,
	LOCAL_SCHEMA_V11_MANIFEST,
	LOCAL_SCHEMA_V11_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

const RAW_TABLES = RAW_TELEMETRY_TTL_COLUMNS.map(([table]) => table)

const MODULE_ID = "local-0010-to-0011-product-events" as const

/**
 * Row counts the backfills must reproduce, captured on the v10 source before
 * anything is rewritten and re-checked on the v11 target after.
 *
 * `browserEvents` is the number of `session_events` rows the projection admits;
 * `identityPairs` is the number of distinct `(OrgId, VisitorId, UserId)`
 * triples in `session_replays` — distinct because `identity_links` is a
 * ReplacingMergeTree, so a raw count would depend on merge timing.
 */
interface V10ToV11SourceRows {
	readonly browserEvents: string
	readonly identityPairs: string
}

interface V10ToV11State {
	readonly module: typeof MODULE_ID
	readonly version: 1
	readonly rawRows: Readonly<Record<string, string>>
	readonly sourceRows: V10ToV11SourceRows
	readonly retentionDays?: number
}

interface V10ToV11Progress {
	readonly installed: true
}

/**
 * The browser-row projection, byte-for-byte the SELECT of `product_events_mv`
 * in the v11 snapshot and of `PRODUCT_EVENTS_PROJECTION_SQL` in migration 0021.
 * A second copy is a second chance for a backfilled row and a live row of the
 * same event to disagree; the verifier below pins the count, and the physical
 * schema gate pins the view body, so drift between the two fails the migration
 * rather than surfacing later as a page-view count that shifts at the backfill
 * boundary.
 */
const PRODUCT_EVENTS_PROJECTION_SQL = `OrgId,
  Timestamp,
  'browser' AS Source,
  SessionId,
  Seq,
  VisitorId,
  UserId,
  GroupId,
  Type AS Kind,
  if(Type = 'navigation', '$pageview', Message) AS EventName,
  domain(Url) AS Host,
  path(Url) AS PagePath,
  Url,
  '' AS ServiceName,
  Attributes`

const PRODUCT_EVENTS_COLUMNS =
	"OrgId, Timestamp, Source, SessionId, Seq, VisitorId, UserId, GroupId, Kind, EventName, Host, PagePath, Url, ServiceName, Attributes"

const PRODUCT_EVENTS_SOURCE_FILTER = "Type IN ('navigation', 'custom')"

const IDENTITY_LINKS_SOURCE_FILTER = "VisitorId != '' AND UserId != ''"

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value)

const decodeCounts = (value: unknown): Readonly<Record<string, string>> => {
	if (!isRecord(value)) throw new Error("v10 -> v11 rawRows must be an object")
	const counts: Record<string, string> = {}
	for (const table of RAW_TABLES) {
		const count = value[table]
		if (!isCount(count)) throw new Error(`v10 -> v11 rawRows.${table} must be an unsigned decimal string`)
		counts[table] = count
	}
	if (Object.keys(value).some((table) => !RAW_TABLES.includes(table as (typeof RAW_TABLES)[number])))
		throw new Error("v10 -> v11 rawRows contains an unknown table")
	return counts
}

const decodeSourceRows = (value: unknown): V10ToV11SourceRows => {
	if (!isRecord(value)) throw new Error("v10 -> v11 sourceRows must be an object")
	if (Object.keys(value).some((key) => key !== "browserEvents" && key !== "identityPairs"))
		throw new Error("v10 -> v11 sourceRows contains an unknown field")
	if (!isCount(value.browserEvents))
		throw new Error("v10 -> v11 sourceRows.browserEvents must be an unsigned decimal string")
	if (!isCount(value.identityPairs))
		throw new Error("v10 -> v11 sourceRows.identityPairs must be an unsigned decimal string")
	return { browserEvents: value.browserEvents, identityPairs: value.identityPairs }
}

const decodeState = (value: unknown): V10ToV11State => {
	if (!isRecord(value)) throw new Error("v10 -> v11 state must be an object")
	const allowed = new Set(["module", "version", "rawRows", "sourceRows", "retentionDays"])
	if (Object.keys(value).some((key) => !allowed.has(key)))
		throw new Error("v10 -> v11 state contains an unknown field")
	if (value.module !== MODULE_ID || value.version !== 1)
		throw new Error("v10 -> v11 state has an unsupported module or version")
	if (
		value.retentionDays !== undefined &&
		(typeof value.retentionDays !== "number" || !Number.isSafeInteger(value.retentionDays))
	)
		throw new Error("v10 -> v11 retentionDays must be an integer")
	return {
		module: MODULE_ID,
		version: 1,
		rawRows: decodeCounts(value.rawRows),
		sourceRows: decodeSourceRows(value.sourceRows),
		...(!(value.retentionDays === undefined) ? { retentionDays: value.retentionDays } : undefined),
	}
}

const decodeProgress = (value: unknown): V10ToV11Progress | undefined => {
	if (value === undefined) return undefined
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "installed") || value.installed !== true)
		throw new Error("v10 -> v11 progress is invalid")
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
	if (!isCount(count)) throw new Error(`v10 -> v11 count query returned no row: ${sql}`)
	return count
}

/** What the backfills must reproduce, measured on whichever side is open. */
const sourceRowCounts = (db: Chdb): V10ToV11SourceRows => ({
	browserEvents: scalarCount(
		db,
		`SELECT toString(count()) AS count FROM session_events WHERE ${PRODUCT_EVENTS_SOURCE_FILTER}`,
	),
	identityPairs: scalarCount(
		db,
		`SELECT toString(uniqExact(OrgId, VisitorId, UserId)) AS count FROM session_replays WHERE ${IDENTITY_LINKS_SOURCE_FILTER}`,
	),
})

const targetRowCounts = (db: Chdb): V10ToV11SourceRows => ({
	browserEvents: scalarCount(
		db,
		"SELECT toString(count()) AS count FROM product_events WHERE Source = 'browser'",
	),
	identityPairs: scalarCount(
		db,
		"SELECT toString(uniqExact(OrgId, VisitorId, UserId)) AS count FROM identity_links",
	),
})

const expectedManifest = (manifest: typeof LOCAL_SCHEMA_V10_MANIFEST, retentionDays: number | undefined) =>
	retentionDays === undefined
		? manifest
		: withRawTelemetryRetentionFloor(manifest, RAW_TABLES, retentionDays)

const preflight = async (context: MigrationModuleContext): Promise<V10ToV11State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const { rawRows, sourceRows } = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V10_MANIFEST, retentionDays))
			return { rawRows: rawRowCounts(db), sourceRows: sourceRowCounts(db) }
		},
		{ schemaSql: LOCAL_SCHEMA_V10_SQL, bootstrapSchema: false },
	)
	return {
		module: MODULE_ID,
		version: 1,
		rawRows,
		sourceRows,
		...(!(retentionDays === undefined) ? { retentionDays } : undefined),
	}
}

const prepareTarget = async (
	context: MigrationModuleContext,
	state: V10ToV11State,
): Promise<V10ToV11State> => {
	await context.closeStores()
	const source = resolve(context.sourceDataDir)
	const target = resolve(context.targetDataDir)
	if (source !== target) {
		await cloneStoreForStaging(source, target)
	}
	return state
}

/**
 * The local mirror of migration 0021, in its order:
 *
 * 1. `session_events` gains `VisitorId`/`UserId`/`GroupId` — metadata-only
 *    `ADD COLUMN IF NOT EXISTS`, no part is rewritten. The v11 bootstrap's
 *    `CREATE TABLE IF NOT EXISTS session_events` is a no-op on the cloned
 *    store, so the columns have to be added here or the physical gate fails.
 * 2. The v11 snapshot bootstrap creates `product_events`, `identity_links` and
 *    their views. Views on `session_events`/`session_replays` are insert
 *    triggers on *those* tables, so their presence during the backfill below is
 *    inert — the `INSERT … SELECT` targets `product_events` directly.
 * 3. Backfill. Unlike v3 -> v4 (which left `web_events` empty on purpose) the
 *    old table is being dropped, and `product_events` is the only place the
 *    30-day `session_events` window can still be projected into; leaving it
 *    empty would lose the browser history the reader had yesterday. The
 *    idempotency step is 0021's `DELETE WHERE Source = 'browser'` — a
 *    lightweight delete, verified against the bundled chDB — rather than
 *    `TRUNCATE`: local mode has no direct `product_events` ingest yet, but the
 *    invariant is that a re-run of this step never destroys a row it cannot
 *    rebuild, and that stays true the day it does. `identity_links` needs no
 *    clear: a re-insert of a pair into a ReplacingMergeTree collapses on merge,
 *    and the verifier counts distinct triples for that reason.
 * 4. `web_events_mv` then `web_events`, last, once the replacement is populated
 *    and its writer live. Every reader moved to `product_events` in the same
 *    release; the old table cannot be rebuilt past what the new one holds.
 *
 * Every statement is idempotent, so a resume after a crash between them lands
 * in the same place.
 */
const apply = async (context: MigrationModuleContext): Promise<V10ToV11Progress> => {
	await context.openTarget(
		(db) => {
			db.exec("ALTER TABLE session_events ADD COLUMN IF NOT EXISTS VisitorId String DEFAULT ''")
			db.exec("ALTER TABLE session_events ADD COLUMN IF NOT EXISTS UserId String DEFAULT ''")
			db.exec("ALTER TABLE session_events ADD COLUMN IF NOT EXISTS GroupId String DEFAULT ''")
		},
		{ schemaSql: LOCAL_SCHEMA_V10_SQL, bootstrapSchema: false },
	)
	return context.openTarget(
		(db) => {
			db.exec("DELETE FROM product_events WHERE Source = 'browser'")
			db.exec(
				`INSERT INTO product_events (${PRODUCT_EVENTS_COLUMNS}) SELECT ${PRODUCT_EVENTS_PROJECTION_SQL} FROM session_events WHERE ${PRODUCT_EVENTS_SOURCE_FILTER}`,
			)
			db.exec(
				`INSERT INTO identity_links (OrgId, VisitorId, UserId, FirstSeen) SELECT OrgId, VisitorId, UserId, StartTime AS FirstSeen FROM session_replays WHERE ${IDENTITY_LINKS_SOURCE_FILTER}`,
			)
			db.exec("DROP VIEW IF EXISTS web_events_mv")
			db.exec("DROP TABLE IF EXISTS web_events")
			return { installed: true } as const
		},
		{ schemaSql: LOCAL_SCHEMA_V11_SQL, bootstrapSchema: true },
	)
}

const verify = async (
	context: MigrationModuleContext,
	state: V10ToV11State,
	_progress: V10ToV11Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V11_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new Error(`v10 -> v11 raw telemetry verification failed for ${table}`)
			}
			// The source is cloned, so re-measuring it on the target is the same
			// number the preflight saw; comparing against the persisted state as
			// well pins the resume path — a re-run cannot pass by projecting a
			// source that changed under it.
			const sourceRows = sourceRowCounts(db)
			const backfilled = targetRowCounts(db)
			for (const key of ["browserEvents", "identityPairs"] as const) {
				if (sourceRows[key] !== state.sourceRows[key])
					throw new Error(`v10 -> v11 source ${key} changed between preflight and verify`)
				if (backfilled[key] !== state.sourceRows[key])
					throw new Error(
						`v10 -> v11 backfill verification failed for ${key}: expected ${state.sourceRows[key]}, found ${backfilled[key]}`,
					)
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V11_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v10-store",
		description: "Clone the stopped v10 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "add-session-event-identity",
		description: "Add the VisitorId, UserId and GroupId columns to session_events",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "install-product-events",
		description:
			"Install product_events and identity_links with their materialized views, backfill both from session_events and session_replays, then drop web_events",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v11-schema",
		description:
			"Verify the v11 physical schema, retained raw telemetry counts, and the backfilled row counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v10 store is cloned byte-for-byte before any DDL runs.",
	},
	{
		name: "session_events",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee:
			"Three columns are added as metadata-only defaults; no part is rewritten and every existing row reads back unchanged with '' in the new columns.",
	},
	{
		name: "session_replays",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "Read once to seed identity_links; neither rewritten nor re-keyed.",
	},
	{
		// The browser half of product_events is rebuilt in full from the source
		// window that still exists: session_events keeps 30 days, so the new
		// table starts with exactly what web_events could have held. It is
		// verified row-for-row against the source count. Rows written to
		// product_events directly, once local ingest carries them, have no
		// source and are never touched by the browser-only clear.
		name: "product_events",
		classification: "derived",
		disposition: "rebuild-complete",
		guarantee:
			"Browser rows are projected from every retained session_events row and the count is verified; the projection is the view body, so backfilled and live rows agree.",
		preservationInterval: "session_events retention horizon",
		sourceRetentionDays: 30,
		targetRetentionDays: 365,
	},
	{
		name: "identity_links",
		classification: "derived",
		disposition: "rebuild-complete",
		guarantee:
			"Every identified (VisitorId, UserId) pair in retained session_replays is linked; distinct-pair count verified against the source.",
		preservationInterval: "session_replays retention horizon",
		sourceRetentionDays: 30,
		targetRetentionDays: 365,
	},
	{
		// Dropped, not migrated: product_events supersedes it and holds a
		// superset of what it could contain (same source, same window, wider
		// projection). Its rows were derived from session_events, which is
		// preserved, so nothing authoritative leaves the store.
		name: "web_events",
		classification: "derived",
		disposition: "invalidate",
		guarantee:
			"Replaced by product_events, which is backfilled from the same session_events window before web_events is dropped; every reader moved in the same release.",
	},
]

export const v10ToV11ProductEventsModule: LocalStoreMigrationModule<V10ToV11State, V10ToV11Progress> = {
	id: MODULE_ID,
	moduleVersion: 1,
	description:
		"Add identity columns to session_events; replace web_events with the backfilled product_events table and add identity_links",
	from: LOCAL_SCHEMA_V10,
	to: LOCAL_SCHEMA_V11,
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
