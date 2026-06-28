import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import {
	readArchiveGenerationManifest,
	parseArchiveActivePointer,
	shardFilePath,
	type ArchiveGenerationManifest,
} from "./manifest"
import { activePointerPath, catalogPath, generationManifestPath, generationsRoot, signalRoot } from "./paths"
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

export interface ArchiveListing {
	readonly archiveDir: string
	readonly active: ReadonlyArray<ActiveGenerationSummary>
	readonly signals: ReadonlyArray<string>
}

/** Sum the byte sizes of a generation's shard records. */
const shardBytes = (manifest: Pick<ArchiveGenerationManifest, "shards">): number =>
	manifest.shards.reduce((sum, shard) => sum + shard.bytes, 0)

/**
 * List the active generation for every (signal, range) that has an `active.json`
 * pointer. Superseded generations are present on disk but never appear here. A
 * malformed or unreadable active pointer is skipped (not fatal) so a corrupt
 * pointer for one range cannot hide the others; the pointer file itself is
 * preserved untouched.
 */
export const listActiveGenerations = (archiveDir: string): ArchiveListing => {
	const active: ActiveGenerationSummary[] = []
	const signalsPresent: string[] = []
	for (const signal of ARCHIVE_SIGNALS) {
		const sRoot = signalRoot(archiveDir, signal.name)
		if (!existsSync(sRoot)) continue
		let ranges: string[]
		try {
			ranges = readdirSync(sRoot).filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry))
		} catch {
			continue
		}
		let signalHasActive = false
		for (const rangeDate of ranges) {
			const pointerPath = activePointerPath(archiveDir, signal.name, rangeDate)
			if (!existsSync(pointerPath)) continue
			let generationId: string
			try {
				const pointer = parseArchiveActivePointer(
					JSON.parse(readFileSync(pointerPath, "utf8")) as unknown,
				)
				generationId = pointer.generationId
			} catch {
				continue
			}
			let manifest: ArchiveGenerationManifest
			try {
				manifest = readArchiveGenerationManifest(archiveDir, signal.name, rangeDate, generationId)
			} catch {
				continue
			}
			signalHasActive = true
			active.push({
				signal: signal.name,
				rangeStart: rangeDate,
				generationId,
				archivedRowCount: manifest.archivedRowCount,
				shardCount: manifest.shards.length,
				createdAt: manifest.createdAt,
				checkpointId: manifest.checkpointId,
				shardPaths: manifest.shards.map((shard) =>
					shardFilePath(archiveDir, signal.name, rangeDate, generationId, shard.name),
				),
				shardBytes: shardBytes(manifest),
			})
		}
		if (signalHasActive) signalsPresent.push(signal.name)
	}
	return { archiveDir, active, signals: signalsPresent }
}

/**
 * Resolve the active Parquet shard paths for one signal across all sealed
 * ranges, excluding superseded generations. This is the machine-readable output
 * an operator feeds to DuckDB's `read_parquet`. Returns the paths grouped by
 * range in ascending order.
 */
export const activeParquetPaths = (archiveDir: string, signal: ArchiveSignalName): ReadonlyArray<string> => {
	const listing = listActiveGenerations(archiveDir)
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
 * manifests. A truncated final catalog line is ignored. Every promoted
 * generation (active or superseded) appears once, because the catalog indexes
 * all retained generations, not just the active one. Returns the rebuilt
 * entries and writes them durably. Does not delete unknown catalog state; the
 * catalog is fully regenerated from manifests, so a stale or corrupt catalog is
 * simply overwritten by the rebuilt authoritative index.
 */
export const rebuildCatalog = (
	archiveDir: string,
	signal: ArchiveSignalName,
): ReadonlyArray<CatalogEntry> => {
	const entries: CatalogEntry[] = []
	const sRoot = signalRoot(archiveDir, signal)
	if (!existsSync(sRoot)) return entries
	let ranges: string[]
	try {
		ranges = readdirSync(sRoot).filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry))
	} catch {
		return entries
	}
	for (const rangeDate of ranges.sort()) {
		const gensRoot = generationsRoot(archiveDir, signal, rangeDate)
		if (!existsSync(gensRoot)) continue
		let generationIds: string[]
		try {
			generationIds = readdirSync(gensRoot)
		} catch {
			continue
		}
		for (const generationId of generationIds.sort()) {
			const manifestPath = generationManifestPath(archiveDir, signal, rangeDate, generationId)
			if (!existsSync(manifestPath)) continue
			let manifest: ArchiveGenerationManifest
			try {
				manifest = readArchiveGenerationManifest(archiveDir, signal, rangeDate, generationId)
			} catch {
				continue
			}
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
	// Durably rewrite the catalog from the rebuilt index. Existing content is
	// replaced wholesale because the manifests are authoritative. The catalog
	// lives at the signal root, not under a range.
	const path = catalogPath(archiveDir, signal)
	const lines = entries.map((entry) => JSON.stringify(entry)).join("\n")
	if (lines.length > 0) {
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, `${lines}\n`)
	}
	return entries
}
