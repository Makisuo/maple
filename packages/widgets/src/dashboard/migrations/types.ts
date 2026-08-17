import type { DashboardSchemaVersion } from "../version"

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
 *
 * Lives in its own module so a step can import the interface without importing
 * the chain that lists it.
 */
export interface DashboardMigration {
	readonly from: DashboardSchemaVersion
	readonly to: DashboardSchemaVersion
	readonly description: string
	readonly migrate: (document: Record<string, unknown>) => Record<string, unknown>
}
