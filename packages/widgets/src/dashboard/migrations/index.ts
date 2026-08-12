import { CURRENT_DASHBOARD_SCHEMA_VERSION, type DashboardSchemaVersion } from "../version"

/**
 * One step of the stored-document migration chain.
 *
 * Migrations operate on plain JSON, never on decoded class instances, because
 * they run *before* the current schema can decode a legacy document — that is
 * the whole point of having them.
 *
 * Three invariants keep the rollout of a new version reversible. Defend them in
 * review:
 *
 *   1. Pure and in-memory. A migration never writes to storage, and nothing
 *      rewrites a widget's `dataSource.params` — params are carried forward
 *      byte-for-byte so a rollback to the previous version still reads them.
 *   2. Idempotent. `migrate(migrate(x))` must equal `migrate(x)`; a document may
 *      be migrated on every read for as long as it goes unwritten.
 *   3. Total. A migration that does not understand its input returns the input
 *      unchanged rather than throwing. Decode is the only judge of validity, so
 *      a surprising document produces a decode error naming the field — not an
 *      opaque exception from a migration step.
 */
export interface DashboardMigration {
	readonly from: DashboardSchemaVersion
	readonly to: DashboardSchemaVersion
	readonly description: string
	readonly migrate: (document: Record<string, unknown>) => Record<string, unknown>
}

/**
 * Ordered chain, one entry per version step. Empty while only version 1 exists;
 * `migrations.test.ts` asserts the chain is contiguous and terminates at
 * `CURRENT_DASHBOARD_SCHEMA_VERSION`, so a step added out of order fails there
 * rather than silently skipping a document.
 */
export const DASHBOARD_MIGRATIONS: ReadonlyArray<DashboardMigration> = []

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const KNOWN_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1])

/** Absent, non-numeric, or unrecognised `schemaVersion` all read as version 1. */
export const detectSchemaVersion = (document: unknown): DashboardSchemaVersion => {
	if (!isPlainObject(document)) return 1
	const declared = document.schemaVersion
	return typeof declared === "number" && KNOWN_SCHEMA_VERSIONS.has(declared)
		? (declared as DashboardSchemaVersion)
		: 1
}

/**
 * Walks the chain from the document's declared version to the current one and
 * stamps the result. Never throws — see invariant 3 above.
 */
export const migrateToLatest = (document: unknown): Record<string, unknown> => {
	if (!isPlainObject(document)) return { schemaVersion: CURRENT_DASHBOARD_SCHEMA_VERSION }

	let current: Record<string, unknown> = document
	let version = detectSchemaVersion(document)

	while (version < CURRENT_DASHBOARD_SCHEMA_VERSION) {
		const step = DASHBOARD_MIGRATIONS.find((migration) => migration.from === version)
		// No step for this version means the chain is broken. Stop rather than
		// loop; decode reports what is actually wrong with the document.
		if (step === undefined) break
		current = step.migrate(current)
		version = step.to
	}

	return { ...current, schemaVersion: CURRENT_DASHBOARD_SCHEMA_VERSION }
}
