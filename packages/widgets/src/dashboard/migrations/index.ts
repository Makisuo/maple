import { CURRENT_DASHBOARD_SCHEMA_VERSION, type DashboardSchemaVersion } from "../version"
import type { DashboardMigration } from "./types"
import { v1ToV2 } from "./v1-to-v2"

export type { DashboardMigration } from "./types"

/**
 * Ordered chain, one entry per version step. `migrations.test.ts` asserts the
 * chain is contiguous and terminates at `CURRENT_DASHBOARD_SCHEMA_VERSION`, so a
 * step added out of order fails there rather than silently skipping a document.
 */
export const DASHBOARD_MIGRATIONS: ReadonlyArray<DashboardMigration> = [v1ToV2]

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

// Includes 3 even though no chain step produces it: `detectSchemaVersion` reads
// an unrecognised version as 1, so leaving 3 out would make a backfilled document
// look like a pre-versioning one and run it through `v1ToV2` again.
const KNOWN_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1, 2, 3])

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

	// A document declaring a version this build has never heard of comes from a
	// NEWER build — a rollback, or a stale worker reading a freshly-written
	// document. Return it untouched.
	//
	// Restamping it downward (which is what the unconditional stamp below used to
	// do) is the worst available outcome: `detectSchemaVersion` reads an unknown
	// version as 1, so the document would be run through the whole migration
	// chain as though it were the oldest shape, then written back claiming to be
	// current. Decode fails either way — but stamped, the next writer persists the
	// lie and the original version is gone. Failing to decode a document we
	// genuinely cannot read is recoverable; corrupting it is not.
	const declared = document.schemaVersion
	if (typeof declared === "number" && declared > CURRENT_DASHBOARD_SCHEMA_VERSION) {
		return document
	}

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

	// Stamped with the version actually REACHED, not with the current one.
	//
	// These differ during the v3 window: the chain ends at 2 while
	// `CURRENT_DASHBOARD_SCHEMA_VERSION` is 3, because the v2 -> v3 transform is a
	// one-shot backfill (`upgrade-to-v3.ts`) rather than a chain step. Stamping 3
	// on a document still in v2 shape would be a lie that decode immediately
	// catches — `parseStoredDashboard` returns `Rejected` and the writable path
	// refuses it, so nothing corrupt reaches storage — but a lie the version
	// history and the span annotation would both repeat.
	//
	// This whole module is deleted once the backfill has run; until then it should
	// report what is true.
	return { ...current, schemaVersion: version }
}
