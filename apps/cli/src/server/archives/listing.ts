import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
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
			// Verify each shard is a real regular file with the correct SHA-256
			// and byte size before returning it to DuckDB (HIGH-1 + cross-check HIGH +
			// tamper verification): a planted symlink, a missing shard, OR a tampered
			// shard whose actual hash/size disagrees with the manifest must fail
			// closed. The manifest is authoritative; a mismatched regular file is
			// rejected, not silently returned.
			let shardPaths: string[]
			try {
				shardPaths = manifest.shards.map((shard) => {
					const p = shardFilePath(archiveDir, signal.name, rangeDate, generationId, shard.name)
					assertNoSymlinkSync(archiveDir, p, "archive shard")
					assertRealFileSync(p, "archive shard")
					// Verify the file's actual SHA-256 and byte size match the manifest.
					const actualSha = sha256FileSync(p)
					if (actualSha !== shard.sha256) {
						throw new Error(
							`shard ${shard.name} SHA-256 mismatch: manifest ${shard.sha256.slice(0, 16)}…, actual ${actualSha.slice(0, 16)}… (file may be tampered)`,
						)
					}
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
	return { archiveDir, active, signals: signalsPresent, errors }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Compute SHA-256 of a file. Reads the whole file into memory; acceptable for
 *  bounded shards (maxShardBytes) but not suitable for unbounded files. */
const sha256FileSync = (path: string): string => {
	const hash = createHash("sha256")
	const data = readFileSync(path)
	hash.update(data)
	return hash.digest("hex")
}

/**
 * Resolve the active Parquet shard paths for one signal across all sealed
 * ranges, excluding superseded generations. This is the machine-readable output
 * an operator feeds to DuckDB's `read_parquet`. Returns the paths grouped by
 * range in ascending order.
 *
 * Fail-closed: if ANY range for this signal has a malformed pointer, manifest,
 * or shard path, the call THROWS rather than returning a partial path list. A
 * partial list would silently feed DuckDB incomplete data, which is worse than a
 * visible error. The operator runs `archive rebuild` or inspects the error to
 * recover.
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
	const sRoot = signalRoot(archiveDir, signal)
	if (!existsSync(sRoot)) return []
	let ranges: string[]
	try {
		ranges = readdirSync(sRoot).filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry))
	} catch (error) {
		throw new Error(`archive catalog rebuild: signal root unreadable: ${messageOf(error)}`)
	}
	// Phase 1 — preflight: read and validate EVERY manifest before touching the
	// catalog. Collect entries; on any error, throw without writing.
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
			// readArchiveGenerationManifest asserts no-symlink + real-file + strict
			// parse + location binding; it throws on any defect.
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
	// Phase 2 — write: only reached if every manifest preflighted clean. Use the
	// durable atomic-write primitive (temp + fsync + rename + dir sync) so an
	// ENOSPC, short write, or interruption cannot destroy the prior catalog.
	const path = catalogPath(archiveDir, signal)
	assertNoSymlinkSync(archiveDir, path, "archive catalog")
	const lines = entries.map((entry) => JSON.stringify({ ...entry, formatVersion: 1 as const })).join("\n")
	const { durableWrite } = await import("../durable-files")
	await durableWrite(path, `${lines}\n`)
	return entries
}
