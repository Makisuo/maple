// chDB on-disk-store compatibility guard.
//
// A data directory written by one libchdb/ClickHouse build is NOT guaranteed to
// load in another: re-reading a persisted materialized view can crash the C++
// runtime natively (SIGTRAP) inside `StorageMaterializedView` — uncatchable from
// JS. So instead of opening a store and hoping, we stamp a marker recording the
// chDB version that owns it and refuse, up front, to open one stamped by a
// different (or no) version.
//
// The marker lives BESIDE the data dir (same convention as the PID file) so it
// stays out of ClickHouse's data path and is removed by `maple reset`.

import { createHash } from "node:crypto"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { CHDB_VERSION } from "../version"
import { durableRemove, durableWrite } from "./durable-files"

export interface StoreMarker {
	/** libchdb version that created the store (e.g. "v26.1.0"); "dev" in dev builds. */
	readonly chdb: string
	/** maple binary version that created the store. */
	readonly maple: string
	/** ISO timestamp the store was bootstrapped. */
	readonly createdAt: string
	/** Fingerprint of the bundled schema DDL the store was bootstrapped from
	 *  (see `schemaFingerprint`). Empty for legacy stores stamped before schema
	 *  fingerprinting existed. */
	readonly schema: string
}

/** Path to the version marker for a given data dir (beside it, like the PID file). */
export const storeMarkerPath = (dataDir: string): string => join(dirname(dataDir), "maple-store-version.json")

/** True once chDB has bootstrapped a store here (it creates `store/`/`metadata/`). */
export const storeHasData = (dataDir: string): boolean =>
	existsSync(join(dataDir, "store")) || existsSync(join(dataDir, "metadata"))

// Clean-shutdown sentinel. Present from the moment chDB opens successfully until
// it closes cleanly; a leftover marker means the previous server died without
// running its close finalizer. Reopening such a store can crash the C++ runtime
// natively (uncatchable from JS) when a persisted MV was left inconsistent — so
// `maple start` checks for it and auto-rebootstraps. This is NOT a concurrency
// lock (the PID file already guards concurrent opens); it lives beside the data
// dir like the PID file / version marker, so `maple reset` removes it.

/** Path to the clean-shutdown sentinel for a given data dir (beside it). */
export const storeOpenMarkerPath = (dataDir: string): string => join(dirname(dataDir), "maple-store-open")

/** Mark the store as open (not yet cleanly closed). Call right after a
 *  successful chDB open; the PID is written purely for debuggability. */
export const markStoreOpen = (dataDir: string): void =>
	writeFileSync(storeOpenMarkerPath(dataDir), `${process.pid}\n`)

/** Clear the clean-shutdown sentinel. Call as the last step of a clean close;
 *  best-effort (a missing marker is fine). */
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

/** True when the store holds data AND was not cleanly closed (the sentinel
 *  survives). Gated on `storeHasData`: a marker over an empty store means a
 *  fresh open that never persisted anything — safe to reopen. */
export const isStoreDirty = (dataDir: string): boolean =>
	storeHasData(dataDir) && existsSync(storeOpenMarkerPath(dataDir))

/** Read the marker, or `null` when missing/unparseable. */
export const readMarker = (dataDir: string): StoreMarker | null => {
	const path = storeMarkerPath(dataDir)
	if (!existsSync(path)) return null
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreMarker>
		if (typeof parsed.chdb !== "string") return null
		return {
			chdb: parsed.chdb,
			maple: parsed.maple ?? "unknown",
			createdAt: parsed.createdAt ?? "unknown",
			schema: parsed.schema ?? "",
		}
	} catch {
		return null
	}
}

/** Serialize a marker for the current build. */
export const storeMarkerJson = (maple: string, now: string, schema: string): string =>
	`${JSON.stringify({ chdb: CHDB_VERSION, maple, createdAt: now, schema } satisfies StoreMarker, null, 2)}\n`

/** Atomically and durably stamp the store version after a live restore swap. */
export const writeStoreMarkerDurable = async (
	dataDir: string,
	maple: string,
	now: string,
	schema: string,
): Promise<void> => durableWrite(storeMarkerPath(dataDir), storeMarkerJson(maple, now, schema))

/**
 * Stable fingerprint of the bundled schema DDL. Comments and whitespace are
 * stripped first so cosmetic edits (a reworded comment, reindentation) don't
 * force a rebuild, while any structural change — a new column, table, or
 * materialized-view body — changes the digest.
 */
export const schemaFingerprint = (schemaSql: string): string =>
	createHash("sha256")
		.update(
			schemaSql
				.replace(/--[^\n]*/g, "")
				.replace(/\s+/g, " ")
				.trim(),
		)
		.digest("hex")
		.slice(0, 16)

/**
 * True when a populated store was bootstrapped from a different schema than the
 * one bundled in this build. `CREATE … IF NOT EXISTS` cannot evolve an existing
 * store — a column added to the schema never reaches it, so queries referencing
 * it fail — so the caller rebuilds the store from scratch (local telemetry is
 * ephemeral and re-ingested). A store with no schema stamp (created before
 * fingerprinting) reads as stale and is rebuilt once.
 */
export const isSchemaStale = (dataDir: string, currentFingerprint: string): boolean =>
	storeHasData(dataDir) && readMarker(dataDir)?.schema !== currentFingerprint

export type StoreCompatibility =
	| { readonly compatible: true }
	| { readonly compatible: false; readonly found: string; readonly current: string }

/**
 * Decide whether the current libchdb may open the store at `dataDir`.
 *
 * - Empty/fresh dir → compatible (first bootstrap stamps the marker afterwards).
 * - Has data + matching marker → compatible.
 * - Has data + no marker → a legacy store (pre-marker, e.g. the old Rust binary).
 * - Has data + mismatched marker → created by a different chDB version.
 *
 * The latter two would crash chDB on load, so they are reported incompatible.
 */
export const checkStoreCompatible = (dataDir: string): StoreCompatibility => {
	if (!storeHasData(dataDir)) return { compatible: true }
	const marker = readMarker(dataDir)
	if (marker === null) {
		return { compatible: false, found: "an unversioned legacy store", current: CHDB_VERSION }
	}
	if (marker.chdb !== CHDB_VERSION) {
		return { compatible: false, found: marker.chdb, current: CHDB_VERSION }
	}
	return { compatible: true }
}
