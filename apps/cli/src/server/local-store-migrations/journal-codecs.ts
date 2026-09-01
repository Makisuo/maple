// Shared journal codecs for the local-store migration edges.
//
// Every versioned edge from v1 onward round-trips the same journal state: which
// module wrote it, the raw-telemetry row counts it must preserve, and the
// retention floor in force at the time. Each edge used to carry its own copy of
// `isRecord` + a `decodeCounts` loop + five `throw new Error` branches — six
// identical copies, drifting only in the strings.
//
// The decoders here are synchronous and throwing because
// `LocalStoreMigrationModule.decodeState` is: the runner that drives these
// modules is plain TypeScript. The schemas are the declarative part, and
// `Schema.decodeUnknownEffect` is a one-line swap if that runner ever moves
// into Effect.
import { Schema } from "effect"
import { cp, mkdir, rm } from "node:fs/promises"
import { dirname, join, sep } from "node:path"
import { RAW_TELEMETRY_TTL_COLUMNS, type Chdb } from "../chdb"
import { decodeTableRowCounts } from "../chdb-rows"
import { withRawTelemetryRetentionFloor, type LocalSchemaManifest } from "../schema-manifest"

const RAW_TABLES_INTERNAL = RAW_TELEMETRY_TTL_COLUMNS.map(([table]) => table)

/**
 * Unsigned decimal string.
 *
 * Row counts and ClickHouse UInt64 cursors are carried as text because they can
 * exceed `Number.MAX_SAFE_INTEGER`, and the journal has to round-trip them
 * exactly. The pattern is not cosmetic: these values are interpolated into SQL
 * comparisons, so anything that could change their meaning has to fail here.
 */
export const UnsignedDecimal = Schema.String.check(Schema.isPattern(/^\d+$/))

/**
 * Exactly the raw tables, each required.
 *
 * Built from `RAW_TELEMETRY_TTL_COLUMNS` rather than written out, so a table
 * added there is covered without touching any edge. With
 * `onExcessProperty: "error"` at the decode site this rejects a missing table
 * and an unknown one alike, which is what the hand-rolled loop did in two
 * separate passes.
 */
export const RawRowsSchema = Schema.Struct(
	Object.fromEntries(RAW_TABLES_INTERNAL.map((table) => [table, UnsignedDecimal])),
)

/**
 * Rejecting unknown fields is not tidiness. A journal carrying a field this
 * build does not know about was written by a different build, and silently
 * dropping it would resume someone else's migration under our assumptions.
 */
const strict = { onExcessProperty: "error" } as const

/**
 * The journal state shared by every versioned edge.
 *
 * `retentionDays` is `optionalKey`, not `optional`: the journal is JSON, where
 * an absent retention floor is an absent key rather than a present `undefined`.
 */
export const makeRawRowsState = <const Id extends string>(moduleId: Id) => {
	const schema = Schema.Struct({
		module: Schema.Literal(moduleId),
		version: Schema.Literal(1),
		rawRows: RawRowsSchema,
		retentionDays: Schema.optionalKey(Schema.Int),
	})
	return { schema, decode: Schema.decodeUnknownSync(schema, strict) }
}

/** Progress for an edge whose apply step is a single idempotent install. */
export const InstalledProgressSchema = Schema.Struct({ installed: Schema.Literal(true) })

export type InstalledProgress = typeof InstalledProgressSchema.Type

const decodeInstalled = Schema.decodeUnknownSync(InstalledProgressSchema, strict)

/**
 * Absent progress means the step has not run; it is not the same as invalid
 * progress, which means the journal disagrees with this build.
 */
export const decodeInstalledProgress = (value: unknown): InstalledProgress | undefined =>
	value === undefined ? undefined : decodeInstalled(value)

/**
 * `decodeUnknownSync` with the strict excess-property policy, for an edge whose
 * progress is not the plain `installed` flag.
 */
export const strictDecoder = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S) =>
	Schema.decodeUnknownSync(schema, strict)

/** Exactly the raw telemetry tables a migration must preserve, in a stable order. */
export const RAW_TABLES: ReadonlyArray<string> = RAW_TABLES_INTERNAL

/**
 * Row counts per raw table, straight from `system.parts`.
 *
 * Every versioned edge carried a byte-identical copy of this. It is the input
 * to the only guarantee those edges make — that a structural DDL change moves
 * no telemetry — so it belongs in one place where that query can be reasoned
 * about once.
 */
export const rawRowCounts = (db: Chdb): Readonly<Record<string, string>> => {
	const quotedTables = RAW_TABLES_INTERNAL.map((table) => `'${table}'`).join(", ")
	const rows = decodeTableRowCounts(
		db.query(
			`SELECT table, toString(sum(rows)) AS rowCount FROM system.parts WHERE database = 'default' AND active = 1 AND table IN (${quotedTables}) GROUP BY table`,
		),
	)
	const byTable = new Map(rows.map((row) => [row.table, row.rowCount]))
	return Object.fromEntries(RAW_TABLES_INTERNAL.map((table) => [table, byTable.get(table) ?? "0"]))
}

/**
 * The manifest an edge should expect to find, given the retention floor an
 * operator pinned for this store. A pinned floor rewrites the raw tables' TTL
 * intervals, so comparing against the bundled manifest verbatim would report a
 * drift the operator asked for.
 */
export const expectedManifest = (
	manifest: LocalSchemaManifest,
	retentionDays: number | undefined,
): LocalSchemaManifest =>
	retentionDays === undefined
		? manifest
		: withRawTelemetryRetentionFloor(manifest, RAW_TABLES_INTERNAL, retentionDays)

/**
 * Clone a clean, stopped store into a staged migration target — WITHOUT its
 * checkpoint registry. `<dataDir>/backups` belongs to the retained source: its
 * manifests pin the source's schema fingerprint, so a copied registry fails
 * every post-promotion resolution against the new fingerprint, classifying the
 * registry "unusable" and blocking the fresh checkpoint the migration tells
 * the user to create. Checkpoints stay with the rollback source, as the stated
 * preservation envelope already promises.
 */
export const cloneStoreForStaging = async (source: string, target: string): Promise<void> => {
	await rm(target, { recursive: true, force: true })
	await mkdir(dirname(target), { recursive: true, mode: 0o700 })
	const checkpointRoot = join(source, "backups")
	await cp(source, target, {
		recursive: true,
		preserveTimestamps: true,
		filter: (src) => src !== checkpointRoot && !src.startsWith(`${checkpointRoot}${sep}`),
	})
}
