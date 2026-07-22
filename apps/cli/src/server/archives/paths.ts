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
	// Reject impossible calendar dates (e.g. 2026-02-31). JavaScript's Date
	// constructor normalizes impossible dates (rolls Feb 31 to Mar 3) rather
	// than returning NaN, so we must verify the date round-trips: construct the
	// date, then check its UTC year/month/day match the input exactly.
	const [, y, m, d] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)!
	const year = Number(y)
	const month = Number(m) - 1 // JS months are 0-based
	const day = Number(d)
	const date = new Date(Date.UTC(year, month, day))
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
		throw new Error(`invalid archive range date (impossible calendar date): ${value}`)
	}
	return value
}

/**
 * Compute the exclusive end of a UTC day as the next day's midnight in ISO form
 * (e.g. `2026-06-01` → `2026-06-02T00:00:00.000Z`). Used for the
 * `rangeEndExclusive` manifest field; the prior `23:59:59.999999999Z` was
 * inclusive, not exclusive.
 */
export const nextMidnightUtc = (rangeDate: string): string => {
	const validated = validateRangeDate(rangeDate)
	const [, y, m, d] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(validated)!
	const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
	date.setUTCDate(date.getUTCDate() + 1)
	return date.toISOString()
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

export type ArchivePathTopology = "absent" | "real-directory" | "real-file"

/**
 * Classify a path beneath a trusted root without following symlinks.
 *
 * A final-path `lstatSync` alone is insufficient: an absent leaf beneath an
 * existing symlinked ancestor also reports ENOENT. Walk and validate every
 * existing component first, then classify the final entry. Only a genuinely
 * missing component on a symlink-free path is reported as absent.
 */
export const classifyArchivePathSync = (
	root: string,
	candidate: string,
	label: string,
): ArchivePathTopology => {
	const absoluteCandidate = assertContained(root, candidate, label)
	assertNoSymlinkSync(root, absoluteCandidate, label)
	try {
		const info = lstatSync(absoluteCandidate)
		if (info.isDirectory()) return "real-directory"
		if (info.isFile()) return "real-file"
		if (info.isSymbolicLink()) {
			// assertNoSymlinkSync already rejects this. Keep the explicit branch
			// as a fail-closed guard against a same-user race between checks.
			throw new Error(`refusing symlink in ${label}: ${absoluteCandidate}`)
		}
		throw new Error(`unexpected entry type for ${label}: ${absoluteCandidate}`)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"
		throw error
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
export const ensurePrivateDirectory = async (path: string, root: string): Promise<void> => {
	const absolute = resolve(path)
	const absoluteRoot = resolve(root)
	// The root must exist or be creatable as the first component. If the root
	// itself does not exist yet (fresh archive root), create it with restrictive
	// permissions before walking. A fresh root that fails ENOENT on lstat is
	// expected here; the prior code treated a missing root as the walk start and
	// then failed when lstat on the first child hit a non-existent parent.
	const rel = relative(absoluteRoot, absolute)
	if (rel === "") {
		// path IS the root: ensure it exists as a real private directory.
		try {
			const info = await lstat(absoluteRoot)
			if (info.isSymbolicLink()) throw new Error(`refusing symlink archive root: ${absoluteRoot}`)
			if (!info.isDirectory()) throw new Error(`archive root must be a directory: ${absoluteRoot}`)
			return
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			await mkdir(absoluteRoot, { recursive: true, mode: 0o700 })
			return
		}
	}
	if (rel.startsWith("..")) throw new Error(`archive path escapes root: ${path}`)
	// Ensure the root exists first (handles fresh-root creation).
	try {
		const rootInfo = await lstat(absoluteRoot)
		if (rootInfo.isSymbolicLink()) throw new Error(`refusing symlink archive root: ${absoluteRoot}`)
		if (!rootInfo.isDirectory()) throw new Error(`archive root must be a directory: ${absoluteRoot}`)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		await mkdir(absoluteRoot, { recursive: true, mode: 0o700 })
	}
	// Walk from the root down, checking each existing component is a real dir and
	// creating missing ones. This refuses to cross a symlink at any depth.
	let current = absoluteRoot
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
}

/**
 * Synchronously verify a path is a real (non-symlink) regular file before
 * reading it. Use at every read site so a symlinked or non-file entry cannot
 * feed attacker-controlled or undefined content to a parser.
 */
export const assertRealFileSync = (path: string, label: string): void => {
	const info = lstatSync(path)
	if (info.isSymbolicLink() || !info.isFile()) {
		throw new Error(`${label} must be a real file: ${path}`)
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
