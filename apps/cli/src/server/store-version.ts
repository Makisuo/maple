// Durable identity for a local chDB store.
//
// The short `schema` field is retained for compatibility with the original
// marker format.  It is a bundle identity, not proof that the physical store
// currently has that schema.  New markers carry a versioned identity and a
// stable store id; physical-schema checks are performed before a store is
// activated.

import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { CHDB_VERSION } from "../version"
import { durableRemove, durableWrite } from "./durable-files"

export const STORE_MARKER_FORMAT_VERSION = 2 as const

export type StoreActivation = "active" | "staging"

export interface StoreMigrationStamp {
	readonly id: string
	readonly completedAt: string
	readonly fromVersion: number
	readonly toVersion: number
}

/** The v2 marker written by current Maple builds. */
export interface StoreMarkerV2 {
	readonly formatVersion: typeof STORE_MARKER_FORMAT_VERSION
	readonly storeId: string
	/** libchdb package/release identity that owns the on-disk format. */
	readonly chdb: string
	/** Maple version that first created the store. */
	readonly maple: string
	/** Immutable store creation timestamp. */
	readonly createdAt: string
	/** Immutable creator identity; useful when `maple` is a dev build. */
	readonly createdByMaple: string
	/** Monotonic local schema version. */
	readonly schemaVersion: number
	/** Full normalized bundled-schema digest. */
	readonly schemaDigest: string
	/** Legacy 16-character bundle fingerprint. */
	readonly schema: string
	/** A staged store is never eligible for ordinary startup. */
	readonly activation: StoreActivation
	readonly lastMigration?: StoreMigrationStamp
}

/** Marker shape written before v2. Keep this type explicit so callers can
 * distinguish an old marker from a current identity. */
export interface LegacyStoreMarker {
	readonly formatVersion: 1
	readonly chdb: string
	readonly maple: string
	readonly createdAt: string
	readonly schema: string
	readonly storeId?: undefined
	readonly schemaVersion?: undefined
	readonly schemaDigest?: undefined
	readonly activation?: undefined
}

export type StoreMarker = StoreMarkerV2 | LegacyStoreMarker

export type MarkerReadState =
	| { readonly kind: "missing" }
	| { readonly kind: "malformed"; readonly message: string }
	| { readonly kind: "valid"; readonly marker: StoreMarker }

/** Path to the marker for a given data dir (beside it, like the PID file). */
export const storeMarkerPath = (dataDir: string): string => join(dirname(dataDir), "maple-store-version.json")

/** True once chDB has bootstrapped a store here (it creates `store/`/`metadata/`). */
export const storeHasData = (dataDir: string): boolean =>
	existsSync(join(dataDir, "store")) || existsSync(join(dataDir, "metadata"))

// Clean-shutdown sentinel. Present from the moment chDB opens successfully until
// it closes cleanly. It is deliberately separate from the migration journal:
// a staged target must never look like an active store.

/** Path to the clean-shutdown sentinel for a given data dir (beside it). */
export const storeOpenMarkerPath = (dataDir: string): string => join(dirname(dataDir), "maple-store-open")

/** Mark the store as open (not yet cleanly closed). */
export const markStoreOpen = (dataDir: string): void => {
	writeFileSync(storeOpenMarkerPath(dataDir), `${process.pid}\n`, { mode: 0o600 })
}

/** Clear the clean-shutdown sentinel. Best effort: a missing marker is fine. */
export const markStoreClosed = (dataDir: string): void => {
	try {
		unlinkSync(storeOpenMarkerPath(dataDir))
	} catch {
		// already gone — nothing to clear
	}
}

/** Durably clear the clean-shutdown sentinel for a restore transaction. */
export const markStoreClosedDurable = async (dataDir: string): Promise<void> => {
	const path = storeOpenMarkerPath(dataDir)
	if (existsSync(path)) await durableRemove(path)
}

/** True when the store holds data and was not cleanly closed. */
export const isStoreDirty = (dataDir: string): boolean =>
	storeHasData(dataDir) && existsSync(storeOpenMarkerPath(dataDir))

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const isIsoOrUnknown = (value: unknown): value is string =>
	typeof value === "string" && (value === "unknown" || Number.isFinite(Date.parse(value)))

const isHexDigest = (value: unknown): value is string =>
	typeof value === "string" && /^[0-9a-f]{64}$/i.test(value)

const parseMarker = (value: unknown): StoreMarker => {
	if (!isRecord(value) || typeof value.chdb !== "string" || value.chdb.length === 0) {
		throw new Error("marker must contain a non-empty chdb string")
	}
	const maple = typeof value.maple === "string" ? value.maple : "unknown"
	const createdAt = typeof value.createdAt === "string" ? value.createdAt : "unknown"
	const schema = typeof value.schema === "string" ? value.schema : ""
	if (!isIsoOrUnknown(createdAt)) throw new Error("marker createdAt is invalid")
	if (
		value.formatVersion !== undefined &&
		value.formatVersion !== 1 &&
		value.formatVersion !== STORE_MARKER_FORMAT_VERSION
	) {
		throw new Error(`unsupported marker format ${String(value.formatVersion)}`)
	}

	if (value.formatVersion === STORE_MARKER_FORMAT_VERSION) {
		if (typeof value.storeId !== "string" || value.storeId.length === 0) {
			throw new Error("v2 marker storeId is missing")
		}
		if (!Number.isInteger(value.schemaVersion) || (value.schemaVersion as number) < 0) {
			throw new Error("v2 marker schemaVersion is invalid")
		}
		if (!isHexDigest(value.schemaDigest)) throw new Error("v2 marker schemaDigest is invalid")
		if (!/^[0-9a-f]{16}$/i.test(schema)) throw new Error("v2 marker schema fingerprint is invalid")
		if (value.activation !== "active" && value.activation !== "staging") {
			throw new Error("v2 marker activation is invalid")
		}
		const lastMigration = value.lastMigration
		if (lastMigration !== undefined) {
			if (
				!isRecord(lastMigration) ||
				typeof lastMigration.id !== "string" ||
				!Number.isInteger(lastMigration.fromVersion) ||
				!Number.isInteger(lastMigration.toVersion) ||
				!isIsoOrUnknown(lastMigration.completedAt)
			) {
				throw new Error("v2 marker lastMigration is invalid")
			}
		}
		return {
			formatVersion: STORE_MARKER_FORMAT_VERSION,
			storeId: value.storeId,
			chdb: value.chdb,
			maple,
			createdAt,
			createdByMaple: typeof value.createdByMaple === "string" ? value.createdByMaple : maple,
			schemaVersion: value.schemaVersion as number,
			schemaDigest: value.schemaDigest,
			schema,
			activation: value.activation,
			...(lastMigration === undefined
				? {}
				: {
						lastMigration: {
							id: lastMigration.id as string,
							completedAt: lastMigration.completedAt as string,
							fromVersion: lastMigration.fromVersion as number,
							toVersion: lastMigration.toVersion as number,
						},
					}),
		}
	}

	// The original marker had no formatVersion. Treat it as v1. A malformed
	// object must not silently become a legacy store, so the required chdb field
	// above is the only compatibility relaxation.
	return { formatVersion: 1, chdb: value.chdb, maple, createdAt, schema }
}

/** Read the marker with an explicit missing/malformed distinction. */
export const readMarkerState = (dataDir: string): MarkerReadState => {
	const path = storeMarkerPath(dataDir)
	if (!existsSync(path)) return { kind: "missing" }
	try {
		return { kind: "valid", marker: parseMarker(JSON.parse(readFileSync(path, "utf8")) as unknown) }
	} catch (error) {
		return { kind: "malformed", message: error instanceof Error ? error.message : String(error) }
	}
}

/** Read a marker, or null when missing/unparseable (legacy API). */
export const readMarker = (dataDir: string): StoreMarker | null => {
	const result = readMarkerState(dataDir)
	return result.kind === "valid" ? result.marker : null
}

export interface StoreMarkerWriteOptions {
	readonly storeId?: string
	readonly createdAt?: string
	readonly createdByMaple?: string
	readonly schemaVersion?: number
	readonly schemaDigest?: string
	readonly activation?: StoreActivation
	readonly lastMigration?: StoreMigrationStamp
}

/** Construct a v2 marker. The caller may provide a stable store id when
 * creating a target or upgrading a legacy marker. */
export const makeStoreMarker = (
	maple: string,
	now: string,
	schema: string,
	options: StoreMarkerWriteOptions = {},
): StoreMarkerV2 => {
	if (!/^[0-9a-f]{16}$/i.test(schema)) {
		throw new Error("a 16-character schema fingerprint is required for a v2 marker")
	}
	if (!options.schemaDigest || !/^[0-9a-f]{64}$/i.test(options.schemaDigest)) {
		throw new Error("a full 64-character schemaDigest is required for a v2 marker")
	}
	if (options.schemaVersion === undefined || !Number.isInteger(options.schemaVersion)) {
		throw new Error("a schemaVersion is required for a v2 marker")
	}
	return {
		formatVersion: STORE_MARKER_FORMAT_VERSION,
		storeId: options.storeId ?? randomUUID(),
		chdb: CHDB_VERSION,
		maple,
		createdAt: options.createdAt ?? now,
		createdByMaple: options.createdByMaple ?? maple,
		schemaVersion: options.schemaVersion,
		schemaDigest: options.schemaDigest,
		schema,
		activation: options.activation ?? "active",
		...(options.lastMigration === undefined ? {} : { lastMigration: options.lastMigration }),
	}
}

/** Serialize a current marker for a known identity. */
export const storeMarkerJson = (
	maple: string,
	now: string,
	schema: string,
	options: StoreMarkerWriteOptions = {},
): string => {
	// Keep this helper source-compatible for tests and third-party tooling that
	// used it to manufacture a pre-v2 marker. Production callers use
	// `ensureStoreMarkerDurable`, which always supplies the full identity.
	if (options.schemaDigest === undefined || options.schemaVersion === undefined) {
		return `${JSON.stringify({ chdb: CHDB_VERSION, maple, createdAt: now, schema })}\n`
	}
	return `${JSON.stringify(makeStoreMarker(maple, now, schema, options), null, 2)}\n`
}

/** Upgrade a legacy marker or create a new marker, preserving immutable
 * provenance when it already exists. */
export const ensureStoreMarkerDurable = async (
	dataDir: string,
	identity: { readonly version: number; readonly digest: string; readonly fingerprint: string },
	maple: string,
	now = new Date().toISOString(),
	options: Pick<StoreMarkerWriteOptions, "activation" | "lastMigration" | "storeId"> = {},
): Promise<StoreMarkerV2> => {
	const existing = readMarker(dataDir)
	if (existing?.formatVersion === STORE_MARKER_FORMAT_VERSION) {
		if (existing.activation === "staging" && options.activation !== "active") {
			return existing
		}
		const updated: StoreMarkerV2 = {
			...existing,
			schemaVersion: identity.version,
			schemaDigest: identity.digest,
			schema: identity.fingerprint,
			activation: options.activation ?? existing.activation,
			...(options.lastMigration === undefined ? {} : { lastMigration: options.lastMigration }),
		}
		await durableWrite(storeMarkerPath(dataDir), `${JSON.stringify(updated, null, 2)}\n`)
		return updated
	}

	const created = makeStoreMarker(maple, now, identity.fingerprint, {
		...identity,
		schemaVersion: identity.version,
		schemaDigest: identity.digest,
		createdAt: existing?.createdAt !== undefined ? existing.createdAt : now,
		createdByMaple: existing?.maple,
		storeId: options.storeId ?? existing?.storeId,
		activation: options.activation,
		lastMigration: options.lastMigration,
	})
	await durableWrite(storeMarkerPath(dataDir), `${JSON.stringify(created, null, 2)}\n`)
	return created
}

/** Backward-compatible durable writer used by checkpoint restore. It preserves
 * the existing store id and creation timestamp rather than rewriting them. */
export const writeStoreMarkerDurable = async (
	dataDir: string,
	maple: string,
	now: string,
	schema: string,
	options: StoreMarkerWriteOptions & {
		readonly schemaVersion?: number
		readonly schemaDigest?: string
	} = {},
): Promise<void> => {
	if (options.schemaVersion === undefined || options.schemaDigest === undefined) {
		// Checkpoint restore is only called by a build that knows its current schema;
		// callers that have not been migrated yet retain the old shape rather than
		// inventing an identity. The next start will fail closed and offer migration.
		await durableWrite(
			storeMarkerPath(dataDir),
			`${JSON.stringify({ chdb: CHDB_VERSION, maple, createdAt: now, schema })}\n`,
		)
		return
	}
	await ensureStoreMarkerDurable(
		dataDir,
		{
			version: options.schemaVersion,
			digest: options.schemaDigest,
			fingerprint: schema,
		},
		maple,
		now,
		options,
	)
}

/** Stable normalized bundled-schema text used by both the legacy short
 * fingerprint and the v2 full digest. This is intentionally not described as
 * a physical-schema hash: regex normalization cannot parse SQL literals. */
export const normalizedSchemaSql = (schemaSql: string): string =>
	schemaSql
		.replace(/--[^\n]*/g, "")
		.replace(/\s+/g, " ")
		.trim()

export const schemaDigest = (schemaSql: string): string =>
	createHash("sha256").update(normalizedSchemaSql(schemaSql)).digest("hex")

/** Legacy bundle fingerprint retained for compatibility and diagnostics. */
export const schemaFingerprint = (schemaSql: string): string => schemaDigest(schemaSql).slice(0, 16)

/** True when a populated store was bootstrapped from a different bundled
 * schema. The caller must choose migration or explicit reset. */
export const isSchemaStale = (dataDir: string, currentFingerprint: string): boolean =>
	storeHasData(dataDir) && readMarker(dataDir)?.schema !== currentFingerprint

/** Stronger v2 identity gate used before opening a populated store. The legacy
 * helper above remains intentionally fingerprint-only for archive/checkpoint
 * compatibility metadata. */
export const isSchemaIdentityStale = (
	dataDir: string,
	identity: { readonly version: number; readonly digest: string; readonly fingerprint: string },
): boolean => {
	if (!storeHasData(dataDir)) return false
	const marker = readMarker(dataDir)
	if (marker === null) return true
	if (marker.formatVersion === STORE_MARKER_FORMAT_VERSION) {
		return (
			marker.schemaVersion !== identity.version ||
			marker.schemaDigest !== identity.digest ||
			marker.schema !== identity.fingerprint
		)
	}
	return marker.schema !== identity.fingerprint
}

export type StoreCompatibility =
	| { readonly compatible: true }
	| { readonly compatible: false; readonly found: string; readonly current: string }

/** Decide whether the current libchdb may open the store at `dataDir`. */
export const checkStoreCompatible = (dataDir: string): StoreCompatibility => {
	if (!storeHasData(dataDir)) return { compatible: true }
	const state = readMarkerState(dataDir)
	if (state.kind === "missing") {
		return { compatible: false, found: "an unversioned legacy store", current: CHDB_VERSION }
	}
	if (state.kind === "malformed") {
		return { compatible: false, found: "a malformed store marker", current: CHDB_VERSION }
	}
	if (state.marker.chdb !== CHDB_VERSION) {
		return { compatible: false, found: state.marker.chdb, current: CHDB_VERSION }
	}
	if (state.marker.formatVersion === STORE_MARKER_FORMAT_VERSION && state.marker.activation !== "active") {
		return { compatible: false, found: "a staged/incomplete store", current: "an active store" }
	}
	return { compatible: true }
}
