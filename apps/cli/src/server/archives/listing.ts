import { createHash } from "node:crypto"
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import {
	readArchiveGenerationManifest,
	parseArchiveActivePointer,
	shardFilePath,
	type ArchiveGenerationManifest,
} from "./manifest"
import {
	activePointerPath,
	assertNoSymlinkSync,
	assertRealFileSync,
	catalogPath,
	generationManifestPath,
	generationsRoot,
	signalRoot,
} from "./paths"
import { ARCHIVE_SIGNALS, type ArchiveSignalName } from "./signals"
import { withMaintenanceLock } from "../checkpoints"

// Archive read-side: listing, active-path resolution, and catalog rebuild.
//
// `archive list` reports the active generation per (signal, range) with sizes
// and paths, and only ever exposes the active generation's Parquet paths — a
// superseded generation is retained on disk but never returned to queries or to
// the listing, so late-arrival history cannot be double-counted. The catalog is
// a rebuildable index: if `catalog.jsonl` is missing or truncated, it can be
// regenerated from the authoritative generation manifests without rescanning
// Parquet bytes.

export interface ActiveGenerationSummary {
	readonly signal: string
	readonly rangeStart: string
	readonly generationId: string
	readonly archivedRowCount: number
	readonly shardCount: number
	readonly createdAt: string
	readonly checkpointId: string
	/** Absolute paths of the active generation's Parquet shards, in order. */
	readonly shardPaths: ReadonlyArray<string>
	/** Total bytes of the active generation's shards. */
	readonly shardBytes: number
}

export interface ArchiveListingError {
	readonly signal: string
	readonly rangeStart: string
	readonly error: string
}

export interface ArchiveListing {
	readonly archiveDir: string
	/** Listing validates topology and manifest-bound sizes, but does not hash shard contents. */
	readonly integrity: "metadata-only"
	readonly active: ReadonlyArray<ActiveGenerationSummary>
	readonly signals: ReadonlyArray<string>
	/** Preserved errors surfaced (not silently skipped) so a corrupt range is visible (H-7). */
	readonly errors: ReadonlyArray<ArchiveListingError>
}

/** Sum the byte sizes of a generation's shard records. */
const shardBytes = (manifest: Pick<ArchiveGenerationManifest, "shards">): number =>
	manifest.shards.reduce((sum, shard) => sum + shard.bytes, 0)

/**
 * List the active generation for every (signal, range) that has an `active.json`
 * pointer. Superseded generations are present on disk but never appear here. A
 * malformed or unreadable active pointer or manifest for one range is SURFACED in
 * `errors` (not silently skipped) so the operator sees corrupt state; unaffected
 * ranges are still listed. The pointer/manifest files themselves are preserved
 * untouched.
 */
export const listActiveGenerations = (archiveDir: string): ArchiveListing => {
	const active: ActiveGenerationSummary[] = []
	const signalsPresent: string[] = []
	const errors: ArchiveListingError[] = []
	for (const signal of ARCHIVE_SIGNALS) {
		const sRoot = signalRoot(archiveDir, signal.name)
		if (!existsSync(sRoot)) continue
		let ranges: string[]
		try {
			ranges = readdirSync(sRoot).filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry))
		} catch (error) {
			errors.push({
				signal: signal.name,
				rangeStart: "",
				error: `signal root unreadable: ${messageOf(error)}`,
			})
			continue
		}
		let signalHasActive = false
		for (const rangeDate of ranges) {
			const pointerPath = activePointerPath(archiveDir, signal.name, rangeDate)
			if (!existsSync(pointerPath)) continue
			let generationId: string
			try {
				// Refuse a symlinked or non-regular pointer path (HIGH-1 read-side):
				// a symlinked range dir or a non-file (socket, device) would make
				// this read attacker-controlled or undefined content.
				assertNoSymlinkSync(archiveDir, pointerPath, "archive active pointer")
				assertRealFileSync(pointerPath, "archive active pointer")
				const pointer = parseArchiveActivePointer(
					JSON.parse(readFileSync(pointerPath, "utf8")) as unknown,
					signal.name,
					rangeDate,
				)
				generationId = pointer.generationId
			} catch (error) {
				errors.push({
					signal: signal.name,
					rangeStart: rangeDate,
					error: `active pointer: ${messageOf(error)}`,
				})
				continue
			}
			let manifest: ArchiveGenerationManifest
			try {
				manifest = readArchiveGenerationManifest(archiveDir, signal.name, rangeDate, generationId)
			} catch (error) {
				errors.push({
					signal: signal.name,
					rangeStart: rangeDate,
					error: `manifest: ${messageOf(error)}`,
				})
				continue
			}
			signalHasActive = true
			// Cheap metadata listing verifies path topology, regular-file type, and
			// manifest-bound byte size. Content hashing is deliberately reserved for
			// explicit `archive verify`, which streams every shard with bounded memory.
			let shardPaths: string[]
			try {
				shardPaths = manifest.shards.map((shard) => {
					const p = shardFilePath(archiveDir, signal.name, rangeDate, generationId, shard.name)
					assertNoSymlinkSync(archiveDir, p, "archive shard")
					assertRealFileSync(p, "archive shard")
					const actualBytes = statSync(p).size
					if (actualBytes !== shard.bytes) {
						throw new Error(
							`shard ${shard.name} byte size mismatch: manifest ${shard.bytes}, actual ${actualBytes}`,
						)
					}
					return p
				})
			} catch (error) {
				errors.push({
					signal: signal.name,
					rangeStart: rangeDate,
					error: `shard path: ${messageOf(error)}`,
				})
				continue
			}
			active.push({
				signal: signal.name,
				rangeStart: rangeDate,
				generationId,
				archivedRowCount: manifest.archivedRowCount,
				shardCount: manifest.shards.length,
				createdAt: manifest.createdAt,
				checkpointId: manifest.checkpointId,
				shardPaths,
				shardBytes: shardBytes(manifest),
			})
		}
		if (signalHasActive) signalsPresent.push(signal.name)
	}
	return { archiveDir, integrity: "metadata-only", active, signals: signalsPresent, errors }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const ARCHIVE_VERIFY_BUFFER_BYTES = 1024 * 1024

/** Compute SHA-256 with a fixed 1 MiB stream buffer rather than allocating a
 * full shard-sized buffer. Verification processes one shard at a time. */
const sha256FileStreaming = async (path: string): Promise<string> => {
	const hash = createHash("sha256")
	const stream = createReadStream(path, { highWaterMark: ARCHIVE_VERIFY_BUFFER_BYTES })
	for await (const chunk of stream) hash.update(chunk)
	return hash.digest("hex")
}

export interface ArchiveVerification {
	readonly archiveDir: string
	readonly signals: ReadonlyArray<string>
	readonly generationCount: number
	readonly shardCount: number
	readonly verifiedBytes: number
}

/** Explicitly verify every selected active shard against its manifest SHA-256.
 * Listing errors fail the operation before any partial success is reported. */
export const verifyActiveGenerations = async (
	archiveDir: string,
	signal?: ArchiveSignalName,
): Promise<ArchiveVerification> => {
	const listing = listActiveGenerations(archiveDir)
	const relevantErrors = signal ? listing.errors.filter((error) => error.signal === signal) : listing.errors
	if (relevantErrors.length > 0) {
		const detail = relevantErrors
			.map((error) => `${error.signal}/${error.rangeStart || "(root)"}: ${error.error}`)
			.join("; ")
		throw new Error(`refusing archive integrity verification: ${detail}`)
	}
	const active = signal ? listing.active.filter((summary) => summary.signal === signal) : listing.active
	let shardCount = 0
	let verifiedBytes = 0
	for (const summary of active) {
		const manifest = readArchiveGenerationManifest(
			archiveDir,
			summary.signal,
			summary.rangeStart,
			summary.generationId,
		)
		for (const shard of manifest.shards) {
			const path = shardFilePath(
				archiveDir,
				summary.signal,
				summary.rangeStart,
				summary.generationId,
				shard.name,
			)
			assertNoSymlinkSync(archiveDir, path, "archive shard")
			assertRealFileSync(path, "archive shard")
			const actualBytes = statSync(path).size
			if (actualBytes !== shard.bytes) {
				throw new Error(
					`shard ${summary.signal}/${summary.rangeStart}/${shard.name} byte size mismatch: ` +
						`manifest ${shard.bytes}, actual ${actualBytes}`,
				)
			}
			const actualSha = await sha256FileStreaming(path)
			if (actualSha !== shard.sha256) {
				throw new Error(
					`shard ${summary.signal}/${summary.rangeStart}/${shard.name} SHA-256 mismatch: ` +
						`manifest ${shard.sha256.slice(0, 16)}…, actual ${actualSha.slice(0, 16)}…`,
				)
			}
			shardCount++
			verifiedBytes += actualBytes
		}
	}
	return {
		archiveDir,
		signals: signal ? [signal] : listing.signals,
		generationCount: active.length,
		shardCount,
		verifiedBytes,
	}
}

/**
 * Resolve the active Parquet shard paths for one signal across all sealed
 * ranges, excluding superseded generations. This is the machine-readable output
 * an operator feeds to DuckDB's `read_parquet`. Returns the paths grouped by
 * range in ascending order.
 *
 * Fail-closed on malformed topology or manifest-bound byte-size mismatches, but
 * deliberately does not hash shard contents. Run `archive verify` for explicit
 * bounded-memory integrity verification before querying when required.
 */
export const activeParquetPaths = (archiveDir: string, signal: ArchiveSignalName): ReadonlyArray<string> => {
	const listing = listActiveGenerations(archiveDir)
	const relevantErrors = listing.errors.filter((e) => e.signal === signal)
	if (relevantErrors.length > 0) {
		const detail = relevantErrors
			.map((e) => `${e.signal}/${e.rangeStart || "(root)"}: ${e.error}`)
			.join("; ")
		throw new Error(
			`refusing to return active Parquet paths for ${signal}: ${relevantErrors.length} malformed range(s) — ` +
				`${detail}. Run 'maple archive rebuild ${signal}' or inspect the archive.`,
		)
	}
	const forSignal = listing.active
		.filter((summary) => summary.signal === signal)
		.sort((a, b) => a.rangeStart.localeCompare(b.rangeStart))
	return forSignal.flatMap((summary) => summary.shardPaths)
}

export interface CatalogEntry {
	readonly generationId: string
	readonly signal: string
	readonly rangeStart: string
	readonly checkpointId: string
	readonly archivedRowCount: number
	readonly shardCount: number
	readonly createdAt: string
}

const serializeCatalogEntries = (entries: ReadonlyArray<CatalogEntry>): string =>
	`${entries.map((entry) => JSON.stringify({ ...entry, formatVersion: 1 as const })).join("\n")}\n`

/**
 * Read every authoritative manifest for a signal and derive the exact canonical
 * catalog entries without mutating the catalog. This is shared by rebuild and
 * crash reconciliation so a journal phase can never substitute for observed
 * catalog state.
 */
export const authoritativeCatalogEntries = (
	archiveDir: string,
	signal: ArchiveSignalName,
): ReadonlyArray<CatalogEntry> => {
	const sRoot = signalRoot(archiveDir, signal)
	if (!existsSync(sRoot)) return []
	let ranges: string[]
	try {
		ranges = readdirSync(sRoot).filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry))
	} catch (error) {
		throw new Error(`archive catalog rebuild: signal root unreadable: ${messageOf(error)}`)
	}
	const entries: CatalogEntry[] = []
	for (const rangeDate of ranges.sort()) {
		const gensRoot = generationsRoot(archiveDir, signal, rangeDate)
		if (!existsSync(gensRoot)) continue
		let generationIds: string[]
		try {
			generationIds = readdirSync(gensRoot)
		} catch (error) {
			throw new Error(
				`archive catalog rebuild: generations root unreadable for ${signal}/${rangeDate}: ${messageOf(error)}`,
			)
		}
		for (const generationId of generationIds.sort()) {
			const manifestPath = generationManifestPath(archiveDir, signal, rangeDate, generationId)
			if (!existsSync(manifestPath)) {
				throw new Error(
					`archive catalog rebuild: generation ${signal}/${rangeDate}/${generationId} is missing its manifest; ` +
						`remove the orphan generation directory or restore the manifest before rebuilding`,
				)
			}
			const manifest = readArchiveGenerationManifest(archiveDir, signal, rangeDate, generationId)
			entries.push({
				generationId: manifest.generationId,
				signal: manifest.signal,
				rangeStart: manifest.rangeStart,
				checkpointId: manifest.checkpointId,
				archivedRowCount: manifest.archivedRowCount,
				shardCount: manifest.shards.length,
				createdAt: manifest.createdAt,
			})
		}
	}
	return entries
}

/**
 * Assert that the on-disk catalog is byte-for-byte the canonical index derived
 * from authoritative manifests. Missing, duplicated, reordered, truncated, or
 * tampered entries all fail closed.
 */
export const assertCatalogExact = (archiveDir: string, signal: ArchiveSignalName): void => {
	const path = catalogPath(archiveDir, signal)
	assertNoSymlinkSync(archiveDir, path, "archive catalog")
	assertRealFileSync(path, "archive catalog")
	const expected = serializeCatalogEntries(authoritativeCatalogEntries(archiveDir, signal))
	const actual = readFileSync(path, "utf8")
	if (actual !== expected) {
		throw new Error(`archive catalog does not exactly match authoritative manifests for ${signal}`)
	}
}

/**
 * Rebuild `catalog.jsonl` for a signal from the authoritative generation
 * manifests. Every promoted generation (active or superseded) appears once,
 * because the catalog indexes all retained generations, not just the active one.
 *
 * Fail-closed (H-7): the rebuild PREFLIGHTS every manifest before writing. If
 * any generation manifest is missing, malformed, or on a symlinked path, the
 * existing catalog is PRESERVED untouched and the call throws. A partial rebuild
 * that silently drops corrupt generations would make the catalog lie about what
 * is archived, which is worse than a visible error. The operator inspects the
 * named generation and recovers.
 */
export const rebuildCatalog = async (
	archiveDir: string,
	signal: ArchiveSignalName,
): Promise<ReadonlyArray<CatalogEntry>> => {
	if (!existsSync(signalRoot(archiveDir, signal))) return []
	// Phase 1 — preflight every authoritative manifest before touching catalog.
	const entries = authoritativeCatalogEntries(archiveDir, signal)
	// Phase 2 — write: only reached if every manifest preflighted clean. Use the
	// durable atomic-write primitive (temp + fsync + rename + dir sync) so an
	// ENOSPC, short write, or interruption cannot destroy the prior catalog.
	const path = catalogPath(archiveDir, signal)
	assertNoSymlinkSync(archiveDir, path, "archive catalog")
	const { durableWrite } = await import("../durable-files")
	await durableWrite(path, serializeCatalogEntries(entries))
	return entries
}

/**
 * Operator-facing catalog rebuild entry point. Catalog reconstruction takes a
 * snapshot of authoritative manifests and must therefore share the maintenance
 * lock with create and GC; otherwise a stale snapshot can overwrite their
 * freshly published catalog.
 */
export const rebuildCatalogWithMaintenanceLock = async (
	dataDir: string,
	archiveDir: string,
	signal: ArchiveSignalName,
	operationId: string,
): Promise<ReadonlyArray<CatalogEntry>> =>
	withMaintenanceLock(dataDir, operationId, () => rebuildCatalog(archiveDir, signal))
