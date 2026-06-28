import { lstat, mkdir, readdir } from "node:fs/promises"
import { existsSync, lstatSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { randomUUID } from "node:crypto"

// Archive path model and path-safety primitives.
//
// The archive root is operator-configured (an external volume in deployment).
// It never lives inside the live Maple data directory. Every component below it
// is constructed from validated IDs and a validated signal/range, then resolved
// and proven to stay inside the configured root before any mutation — mirroring
// the checkpoint module's path discipline. Symlinks are rejected at every level
// a path is used as state, operation, manifest, shard, quarantine, or building
// input, because a symlinked descendant can escape the configured root and
// mutate unrelated filesystem content (a defect the Phase 1 review caught and
// closed for checkpoints; the same hazard exists for archives).

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** A UTC date in `YYYY-MM-DD` form, naming a sealed archive range's start. */
const RANGE_DATE = /^\d{4}-\d{2}-\d{2}$/

export const validateArchiveId = (value: string, kind: string): string => {
	if (!ID.test(value)) throw new Error(`invalid ${kind} ID: ${value}`)
	return value.toLowerCase()
}

export const validateRangeDate = (value: string): string => {
	if (!RANGE_DATE.test(value)) throw new Error(`invalid archive range date: ${value}`)
	// Reject impossible calendar dates so a typo cannot create a bogus range.
	const date = new Date(`${value}T00:00:00.000Z`)
	if (Number.isNaN(date.getTime())) throw new Error(`invalid archive range date: ${value}`)
	return value
}

export const newArchiveGenerationId = (): string => validateArchiveId(randomUUID(), "archive generation")

export const archiveRoot = (archiveDir: string): string => resolve(archiveDir)

export const signalRoot = (archiveDir: string, signal: string): string =>
	join(archiveRoot(archiveDir), signal)

export const rangeRoot = (archiveDir: string, signal: string, rangeDate: string): string =>
	join(signalRoot(archiveDir, signal), validateRangeDate(rangeDate))

export const generationsRoot = (archiveDir: string, signal: string, rangeDate: string): string =>
	join(rangeRoot(archiveDir, signal, rangeDate), "generations")

export const generationRoot = (
	archiveDir: string,
	signal: string,
	rangeDate: string,
	generationId: string,
): string =>
	join(generationsRoot(archiveDir, signal, rangeDate), validateArchiveId(generationId, "generation"))

export const generationManifestPath = (
	archiveDir: string,
	signal: string,
	rangeDate: string,
	generationId: string,
): string => join(generationRoot(archiveDir, signal, rangeDate, generationId), "manifest.json")

export const shardsRoot = (
	archiveDir: string,
	signal: string,
	rangeDate: string,
	generationId: string,
): string => join(generationRoot(archiveDir, signal, rangeDate, generationId), "shards")

export const activePointerPath = (archiveDir: string, signal: string, rangeDate: string): string =>
	join(rangeRoot(archiveDir, signal, rangeDate), "active.json")

export const catalogPath = (archiveDir: string, signal: string): string =>
	join(signalRoot(archiveDir, signal), "catalog.jsonl")

export const buildingRoot = (archiveDir: string): string => join(archiveRoot(archiveDir), "building")

export const buildingGenerationRoot = (archiveDir: string, generationId: string): string =>
	join(buildingRoot(archiveDir), validateArchiveId(generationId, "generation"))

export const archiveQuarantineRoot = (archiveDir: string): string =>
	join(archiveRoot(archiveDir), "quarantine")

/**
 * Resolve `candidate` and prove it stays inside `root`. Returns the absolute
 * candidate. Anything that resolves outside the root, or to the root itself via
 * `..`, is rejected. This is the same containment check the checkpoint module
 * uses; path string-prefix checks alone are insufficient.
 */
export const assertContained = (root: string, candidate: string, label: string): string => {
	const absoluteRoot = resolve(root)
	const absoluteCandidate = resolve(candidate)
	const rel = relative(absoluteRoot, absoluteCandidate)
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(`${label} escapes configured archive root`)
	}
	return absoluteCandidate
}

/**
 * Refuse a symlink at any depth of `candidate` beneath `root`. Walks each path
 * component with `lstat` immediately before use; a symlink anywhere on the path
 * fails closed. Missing components are allowed (the path may not exist yet).
 */
export const assertNoSymlink = async (root: string, candidate: string, label: string): Promise<void> => {
	const absoluteRoot = resolve(root)
	const absoluteCandidate = assertContained(absoluteRoot, candidate, label)
	try {
		if ((await lstat(absoluteRoot)).isSymbolicLink()) {
			throw new Error(`refusing symlink archive root: ${absoluteRoot}`)
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	const rel = relative(absoluteRoot, absoluteCandidate)
	let current = absoluteRoot
	for (const part of rel.split(sep)) {
		current = join(current, part)
		try {
			if ((await lstat(current)).isSymbolicLink()) {
				throw new Error(`refusing symlink in ${label}: ${current}`)
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			return
		}
	}
}

/**
 * Synchronous variant of {@link assertNoSymlink} for use in synchronous
 * read-side code (listing, catalog rebuild). Walks each existing component with
 * `lstatSync`; a symlink anywhere on the path from `root` to `candidate` fails
 * closed.
 */
export const assertNoSymlinkSync = (root: string, candidate: string, label: string): void => {
	const absoluteRoot = resolve(root)
	const absoluteCandidate = assertContained(absoluteRoot, candidate, label)
	try {
		if (lstatSync(absoluteRoot).isSymbolicLink()) {
			throw new Error(`refusing symlink archive root: ${absoluteRoot}`)
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	const rel = relative(absoluteRoot, absoluteCandidate)
	let current = absoluteRoot
	for (const part of rel.split(sep)) {
		current = join(current, part)
		try {
			if (lstatSync(current).isSymbolicLink()) {
				throw new Error(`refusing symlink in ${label}: ${current}`)
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			return
		}
	}
}

export const assertRealDirectory = async (path: string, label: string): Promise<void> => {
	const info = await lstat(path)
	if (info.isSymbolicLink() || !info.isDirectory()) {
		throw new Error(`${label} must be a real directory: ${path}`)
	}
}

export const assertRealFile = async (path: string, label: string): Promise<void> => {
	const info = await lstat(path)
	if (info.isSymbolicLink() || !info.isFile()) {
		throw new Error(`${label} must be a real file: ${path}`)
	}
}

/**
 * Recursively walk a directory tree, refusing symlinks and unsupported special
 * files at every depth. Returns the total byte size of real files. Used to
 * validate a Parquet shard tree and to measure generated output before any
 * manifest or pointer commit — a symlinked shard could otherwise point outside
 * the archive root.
 */
export const treeBytes = async (path: string): Promise<number> => {
	let total = 0
	const stack: string[] = [path]
	while (stack.length > 0) {
		const current = stack.pop()!
		const info = await lstat(current)
		if (info.isSymbolicLink()) throw new Error(`refusing symlink in archive tree: ${current}`)
		if (info.isFile()) {
			total += info.size
			continue
		}
		if (!info.isDirectory()) throw new Error(`unsupported archive entry type: ${current}`)
		for (const entry of await readdir(current)) stack.push(join(current, entry))
	}
	return total
}

/**
 * Ensure `path` exists with restrictive permissions, refusing a pre-existing
 * symlink or non-directory at ANY ancestor. `mkdir -p` followed by a single
 * `lstat` of the final entry is unsafe: a symlinked ancestor (e.g.
 * `<archive>/traces -> /outside`) is followed by recursive mkdir, silently
 * creating the tree under the symlink target outside the configured root.
 *
 * This walks each existing ancestor with `lstat` first, creates missing
 * components one at a time (refusing to cross a symlink), then verifies the
 * final entry. `root` must be an ancestor of `path`; every component from `root`
 * to `path` is checked.
 */
export const ensurePrivateDirectory = async (path: string, root?: string): Promise<void> => {
	const absolute = resolve(path)
	const absoluteRoot = root ? resolve(root) : absolute
	// Walk from the root down, checking each existing component is a real dir and
	// creating missing ones. This refuses to cross a symlink at any depth.
	let current = absoluteRoot
	const rel = relative(absoluteRoot, absolute)
	if (rel.startsWith("..")) throw new Error(`archive path escapes root: ${path}`)
	for (const part of rel.split(sep)) {
		if (part === "") continue
		current = join(current, part)
		let info
		try {
			info = await lstat(current)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			await mkdir(current, { mode: 0o700 })
			continue
		}
		if (info.isSymbolicLink()) throw new Error(`refusing symlink in archive path: ${current}`)
		if (!info.isDirectory()) throw new Error(`archive path component is not a directory: ${current}`)
	}
	// Final entry: ensure restrictive mode on the leaf we own.
	try {
		const finalInfo = await lstat(absolute)
		if (finalInfo.isSymbolicLink() || !finalInfo.isDirectory()) {
			throw new Error(`archive path must be a real directory: ${absolute}`)
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		// Should not happen after the walk, but be safe.
		await mkdir(absolute, { recursive: true, mode: 0o700 })
	}
}

/** Reject an archive root that is, or sits inside, the live Maple data dir. */
export const assertArchiveRootSeparate = (archiveDir: string, dataDir: string): void => {
	const archive = resolve(archiveDir)
	const data = resolve(dataDir)
	const rel = relative(data, archive)
	if (archive === data || rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`))) {
		throw new Error(
			`archive root must not be the live data directory or one of its descendants: ${archiveDir}`,
		)
	}
	if (existsSync(archive) && lstatSync(archive).isSymbolicLink()) {
		throw new Error(`archive root must not be a symlink: ${archive}`)
	}
}
