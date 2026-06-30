import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { durableJson, durableRename, durableRemove, syncDirectory } from "../durable-files"
import {
	activePointerPath,
	archiveQuarantineRoot,
	archiveRoot,
	assertNoSymlink,
	assertNoSymlinkSync,
	assertRealDirectory,
	assertRealFile,
	assertRealFileSync,
	ensurePrivateDirectory,
	rangeRoot,
	signalRoot,
	validateArchiveId,
	validateRangeDate,
} from "./paths"
import { parseArchiveActivePointer } from "./manifest"
import { archiveSignal } from "./signals"

// Archive generation operation journal and reconciliation (Gate 3).
//
// `createArchiveGeneration` performs a multi-step durable state transition
// (resolve → pin → scratch restore → export → validate → promote → pointer →
// catalog → unpin → cleanup). A process kill at any step can leave an orphan
// pin, dangling scratch, or a half-published generation that the next run must
// reconcile correctly. The `finally` block of the operation runs on a thrown
// error but NOT on a real SIGKILL, so the journal — not the finally — is the
// authority for crash recovery.
//
// This module ports the checkpoint subsystem's proven crash-safety pattern
// (reconcileCheckpointOperations in checkpoints.ts): a versioned intent journal
// written BEFORE any destructive boundary, recording exact identities, that the
// next operation reconciles to its exact intended state or fails closed
// (preserving everything; D-004). The journal may be behind filesystem reality
// but never ahead: it records the LAST completed durable boundary, so
// reconciliation validates recorded identity against observed topology before
// acting.
//
// One active operation is permitted at a time. The maintenance lock serializes
// operations, so at most one `operations/active/` entry should exist; if more
// than one is found, the state is ambiguous and reconciliation fails closed.

/** Versioned journal format. The parser accepts only this version (fail-closed). */
export const ARCHIVE_OPERATION_FORMAT_VERSION = 2 as const

/**
 * Phases record the last COMPLETED durable boundary. Advancement happens only
 * AFTER the named boundary is fsync-durable, so the journal is never ahead of
 * the filesystem. Reconciliation reads the phase to know what is owned and what
 * remains.
 *
 * Ordering: each phase implies every earlier boundary is also durable.
 */
export const ARCHIVE_OPERATION_PHASES = [
	"intent", // journal durably written; pin not yet acquired
	"pin-acquired", // the journal-named pin exists
	"scratch-allocated", // owned scratch subdir created
	"restored", // checkpoint restored into scratch; db open was possible
	"building-created", // owned building/<gen>/ created
	"shards-written", // all shards durably written under building/<gen>/shards/
	"manifest-written", // generation manifest written inside building/<gen>/
	"promoted", // building/ renamed to final generations/<gen>/ location
	"pointer-complete", // active pointer durably selects this generation
	"catalog-complete", // catalog rebuilt/upserted
	"pin-released", // the journal-named pin removed
	"scratch-removed", // owned scratch subdir removed
	"complete", // operation journal moved to operations/completed/
	"aborted", // pre-publication op reconciled away cleanly (nothing published)
] as const
export type ArchiveOperationPhase = (typeof ARCHIVE_OPERATION_PHASES)[number]

const PHASE_ORDER: Readonly<Record<ArchiveOperationPhase, number>> = Object.fromEntries(
	ARCHIVE_OPERATION_PHASES.map((phase, index) => [phase, index]),
) as Readonly<Record<ArchiveOperationPhase, number>>

export const phaseAtLeast = (a: ArchiveOperationPhase, b: ArchiveOperationPhase): boolean =>
	PHASE_ORDER[a] >= PHASE_ORDER[b]

const phaseRequiresManifest = (phase: ArchiveOperationPhase): boolean =>
	phase !== "aborted" && phaseAtLeast(phase, "manifest-written")

export interface ArchiveOperationIntent {
	readonly formatVersion: typeof ARCHIVE_OPERATION_FORMAT_VERSION
	readonly operationId: string
	readonly generationId: string
	readonly signal: string
	readonly rangeStart: string
	readonly checkpointId: string
	/** Configured roots recorded so reconciliation can locate owned state. */
	readonly archiveDir: string
	readonly dataDir: string
	readonly scratchRoot: string
	/** Deterministic identities recorded BEFORE allocation. */
	readonly pinId: string
	readonly pinPurpose: string
	readonly scratchSubdir: string
	/** SHA-256 of the exact durable manifest bytes once phase >= manifest-written. */
	readonly manifestSha256: string | null
	/** The generation this operation supersedes, or null if none (CAS base). */
	readonly baseActiveGenerationId: string | null
	readonly phase: ArchiveOperationPhase
	readonly createdAt: string
	readonly updatedAt: string
}

/** Directory holding a single active operation's journal. */
export const operationDir = (archiveDir: string, operationId: string): string =>
	join(activeOperationsRoot(archiveDir), `archive-${validateArchiveId(operationId, "operation")}`)

/** `<archiveDir>/operations/active/` — holds the single permitted active op. */
export const activeOperationsRoot = (archiveDir: string): string => join(operationsRoot(archiveDir), "active")

/** `<archiveDir>/operations/completed/` — retained records of completed ops. */
export const completedOperationsRoot = (archiveDir: string): string =>
	join(operationsRoot(archiveDir), "completed")

const operationsRoot = (archiveDir: string): string => join(archiveRoot(archiveDir), "operations")

const intentPath = (archiveDir: string, operationId: string): string =>
	join(operationDir(archiveDir, operationId), "intent.json")

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null

const requiredString = (value: unknown, field: string): string => {
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`journal field ${field} missing or not a string`)
	return value
}

/**
 * Strict parse of an operation intent. Validates format version, every identity,
 * phase, and path containment. Throws on any defect (fail-closed); the caller
 * preserves the offending files. The parsed identities are validated to be real
 * archive IDs / range dates so a corrupted or hand-edited journal cannot direct
 * reconciliation at arbitrary paths.
 */
export const parseArchiveOperationIntent = (
	archiveDir: string,
	raw: unknown,
	expectedDataDir?: string,
	expectedScratchRoot?: string,
): ArchiveOperationIntent => {
	if (!isRecord(raw)) throw new Error("archive operation intent is not a record")
	if (raw.formatVersion !== ARCHIVE_OPERATION_FORMAT_VERSION) {
		throw new Error(`unsupported archive operation format version: ${String(raw.formatVersion)}`)
	}
	const operationId = validateArchiveId(requiredString(raw.operationId, "operationId"), "operation")
	const generationId = validateArchiveId(requiredString(raw.generationId, "generationId"), "generation")
	const signal = archiveSignal(requiredString(raw.signal, "signal")).name
	const rangeStart = validateRangeDate(requiredString(raw.rangeStart, "rangeStart"))
	const checkpointId = validateArchiveId(requiredString(raw.checkpointId, "checkpointId"), "checkpoint")
	const phase = requiredString(raw.phase, "phase") as ArchiveOperationPhase
	if (!ARCHIVE_OPERATION_PHASES.includes(phase)) {
		throw new Error(`invalid archive operation phase: ${phase}`)
	}
	const pinId = validateArchiveId(requiredString(raw.pinId, "pinId"), "pin")
	const scratchSubdir = requiredString(raw.scratchSubdir, "scratchSubdir")
	if (scratchSubdir !== `archive-${operationId}`) {
		throw new Error(`invalid scratch subdir in journal: ${scratchSubdir}`)
	}
	const pinPurpose = requiredString(raw.pinPurpose, "pinPurpose")
	if (pinPurpose !== `archive:${generationId}`) {
		throw new Error(`archive operation pin purpose does not match generation: ${pinPurpose}`)
	}
	const recordedArchiveDir = resolve(requiredString(raw.archiveDir, "archiveDir"))
	const recordedDataDir = resolve(requiredString(raw.dataDir, "dataDir"))
	const recordedScratchRoot = resolve(requiredString(raw.scratchRoot, "scratchRoot"))
	if (recordedArchiveDir !== resolve(archiveDir)) {
		throw new Error(
			`archive operation root mismatch: journal ${recordedArchiveDir}, invocation ${resolve(archiveDir)}`,
		)
	}
	if (expectedDataDir !== undefined && recordedDataDir !== resolve(expectedDataDir)) {
		throw new Error(
			`archive operation data root mismatch: journal ${recordedDataDir}, invocation ${resolve(expectedDataDir)}`,
		)
	}
	if (expectedScratchRoot !== undefined && recordedScratchRoot !== resolve(expectedScratchRoot)) {
		throw new Error(
			`archive operation scratch root mismatch: journal ${recordedScratchRoot}, invocation ${resolve(expectedScratchRoot)}`,
		)
	}
	const manifestSha256Raw = raw.manifestSha256
	const manifestSha256 =
		manifestSha256Raw === null ? null : requiredString(manifestSha256Raw, "manifestSha256").toLowerCase()
	if (manifestSha256 !== null && !/^[0-9a-f]{64}$/.test(manifestSha256)) {
		throw new Error("invalid archive operation manifestSha256")
	}
	if (phaseRequiresManifest(phase) !== (manifestSha256 !== null)) {
		throw new Error(`archive operation manifest hash is inconsistent with phase ${phase}`)
	}
	const baseActiveGenerationIdRaw = raw.baseActiveGenerationId
	const baseActiveGenerationId =
		baseActiveGenerationIdRaw === null
			? null
			: validateArchiveId(
					requiredString(baseActiveGenerationIdRaw, "baseActiveGenerationId"),
					"base generation",
				)
	// Roots are recorded for inspection/recovery; they are not authority to act
	// outside the archive root. The archive root itself is re-derived.
	const intent: ArchiveOperationIntent = {
		formatVersion: ARCHIVE_OPERATION_FORMAT_VERSION,
		operationId,
		generationId,
		signal,
		rangeStart,
		checkpointId,
		archiveDir: recordedArchiveDir,
		dataDir: recordedDataDir,
		scratchRoot: recordedScratchRoot,
		pinId,
		pinPurpose,
		scratchSubdir,
		manifestSha256,
		baseActiveGenerationId,
		phase,
		createdAt: requiredString(raw.createdAt, "createdAt"),
		updatedAt: requiredString(raw.updatedAt, "updatedAt"),
	}
	void archiveDir
	return intent
}

/** Read and strictly parse the intent for an operation dir. */
const readIntent = (
	archiveDir: string,
	operationId: string,
	expectedDataDir?: string,
	expectedScratchRoot?: string,
): ArchiveOperationIntent => {
	const path = intentPath(archiveDir, operationId)
	assertNoSymlinkSync(archiveDir, path, "archive operation intent")
	assertRealFileSync(path, "archive operation intent")
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
	return parseArchiveOperationIntent(archiveDir, parsed, expectedDataDir, expectedScratchRoot)
}

/**
 * Persist the initial intent BEFORE pin acquisition or any allocation. The
 * recorded identities (pinId, scratchSubdir, generationId) are the exact ones
 * the operation will allocate, so a crash between journal-write and allocation
 * leaves a reconcilable record of intended ownership.
 */
export const writeInitialIntent = async (intent: {
	readonly archiveDir: string
	readonly operationId: string
	readonly generationId: string
	readonly signal: string
	readonly rangeStart: string
	readonly checkpointId: string
	readonly dataDir: string
	readonly scratchRoot: string
	readonly pinId: string
	readonly pinPurpose: string
	readonly scratchSubdir: string
	readonly baseActiveGenerationId: string | null
}): Promise<void> => {
	const dir = operationDir(intent.archiveDir, intent.operationId)
	await ensurePrivateDirectory(dir, archiveRoot(intent.archiveDir))
	await assertNoSymlink(intent.archiveDir, dir, "archive operation")
	const now = new Date().toISOString()
	const record: ArchiveOperationIntent = {
		formatVersion: ARCHIVE_OPERATION_FORMAT_VERSION,
		operationId: intent.operationId,
		generationId: intent.generationId,
		signal: intent.signal,
		rangeStart: intent.rangeStart,
		checkpointId: intent.checkpointId,
		archiveDir: resolve(intent.archiveDir),
		dataDir: resolve(intent.dataDir),
		scratchRoot: resolve(intent.scratchRoot),
		pinId: intent.pinId,
		pinPurpose: intent.pinPurpose,
		scratchSubdir: intent.scratchSubdir,
		manifestSha256: null,
		baseActiveGenerationId: intent.baseActiveGenerationId,
		phase: "intent",
		createdAt: now,
		updatedAt: now,
	}
	await durableJson(intentPath(intent.archiveDir, intent.operationId), record)
	await syncDirectory(dir)
}

/**
 * Advance the recorded phase to the next completed durable boundary. Called
 * only AFTER the named boundary is fsync-durable. Reads the current intent,
 * validates the transition is a forward step, and rewrites it durably.
 */
export const advancePhase = async (
	archiveDir: string,
	operationId: string,
	next: ArchiveOperationPhase,
	manifestSha256?: string,
): Promise<ArchiveOperationIntent> => {
	const current = readIntent(archiveDir, operationId)
	// Allow re-advancing to the same phase (idempotent reconciliation replay)
	// but refuse a backward or invalid transition.
	if (PHASE_ORDER[next] < PHASE_ORDER[current.phase]) {
		throw new Error(`archive operation phase regression: ${current.phase} -> ${next}`)
	}
	const updated: ArchiveOperationIntent = {
		...current,
		phase: next,
		manifestSha256: next === "aborted" ? null : (manifestSha256 ?? current.manifestSha256),
		updatedAt: new Date().toISOString(),
	}
	if (
		phaseRequiresManifest(next) &&
		(updated.manifestSha256 === null || !/^[0-9a-f]{64}$/.test(updated.manifestSha256))
	) {
		throw new Error(`archive operation phase ${next} requires a manifest SHA-256`)
	}
	await durableJson(intentPath(archiveDir, operationId), updated)
	await syncDirectory(operationDir(archiveDir, operationId))
	return updated
}

/**
 * Enumerate active operation dirs under `operations/active/`. Returns the
 * validated operation IDs. Fails closed on any non-conforming entry, symlink,
 * or unexpected content — these signal ambiguous or corrupt state that
 * reconciliation must surface, not silently act on.
 *
 * Returns at most the IDs present; the caller enforces "at most one".
 */
export const listActiveOperationIds = (archiveDir: string): string[] => {
	const root = activeOperationsRoot(archiveDir)
	if (!existsSync(root)) return []
	assertNoSymlinkSync(archiveDir, root, "archive active operations root")
	const rootInfo = lstatSync(root)
	if (!rootInfo.isDirectory()) {
		throw new Error(`archive active operations root is not a real directory: ${root}`)
	}
	const entries = readdirSync(root, { withFileTypes: true })
	const ids: string[] = []
	for (const entry of entries) {
		// Any non-directory entry (file, symlink, socket) is unrecognized debris.
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(`unrecognized active operation debris: ${join(root, entry.name)}`)
		}
		const prefix = "archive-"
		if (!entry.name.startsWith(prefix)) {
			throw new Error(`unrecognized active operation entry: ${join(root, entry.name)}`)
		}
		ids.push(validateArchiveId(entry.name.slice(prefix.length), "operation"))
	}
	return ids
}

export interface ActiveOperation {
	readonly operationId: string
	readonly dir: string
	readonly intent: ArchiveOperationIntent
}

/**
 * Read the single permitted active operation, or null if none. Fails closed if
 * there is more than one active operation dir (ambiguous state; the maintenance
 * lock should prevent this, so its presence signals corruption or a bug).
 */
export const readActiveOperation = (
	archiveDir: string,
	expectedDataDir?: string,
	expectedScratchRoot?: string,
): ActiveOperation | null => {
	const ids = listActiveOperationIds(archiveDir)
	if (ids.length === 0) return null
	if (ids.length > 1) {
		throw new Error(
			`multiple active archive operations require operator inspection: ${ids
				.map((id) => operationDir(archiveDir, id))
				.join(", ")}`,
		)
	}
	const operationId = ids[0]!
	const dir = operationDir(archiveDir, operationId)
	const intentPathFile = intentPath(archiveDir, operationId)
	if (!existsSync(intentPathFile)) {
		throw new Error(`active operation missing its intent journal: ${dir}`)
	}
	const intent = readIntent(archiveDir, operationId, expectedDataDir, expectedScratchRoot)
	// The intent's operationId must match its directory (identity binding).
	if (intent.operationId !== operationId) {
		throw new Error(
			`archive operation identity mismatch (directory: ${operationId}; intent: ${intent.operationId})`,
		)
	}
	return { operationId, dir, intent }
}

/**
 * Move a completed operation's journal from `operations/active/` to the retained
 * `operations/completed/` location so it no longer blocks later work. The
 * completed record is retained for inspection (D-004: never silently deleted).
 */
export const archiveCompletedOperation = async (archiveDir: string, operationId: string): Promise<void> => {
	const activeDir = operationDir(archiveDir, operationId)
	const completedDir = completedOperationsRoot(archiveDir)
	await ensurePrivateDirectory(completedDir, archiveRoot(archiveDir))
	const dest = join(completedDir, `archive-${validateArchiveId(operationId, "operation")}`)
	if (existsSync(dest)) {
		// A completed record already exists for this id — ambiguous; fail closed
		// rather than overwriting retained history.
		throw new Error(`completed archive operation already exists; refusing to overwrite: ${dest}`)
	}
	await durableRename(activeDir, dest)
	await syncDirectory(activeOperationsRoot(archiveDir))
}

/**
 * Quarantine an operation dir (pre-publication incomplete output) by renaming it
 * under `quarantine/` with a stable, owned name, so archive evidence is retained
 * for inspection rather than silently deleted (D-004). Returns the quarantine
 * destination path.
 */
export const quarantineOperation = async (archiveDir: string, operationId: string): Promise<string> => {
	const activeDir = operationDir(archiveDir, operationId)
	const quarantineRoot = archiveQuarantineRoot(archiveDir)
	await ensurePrivateDirectory(quarantineRoot, archiveRoot(archiveDir))
	const dest = join(quarantineRoot, `operation-${validateArchiveId(operationId, "operation")}`)
	if (existsSync(dest)) {
		throw new Error(`quarantined operation already exists; refusing to overwrite: ${dest}`)
	}
	await durableRename(activeDir, dest)
	await syncDirectory(activeOperationsRoot(archiveDir))
	return dest
}

/** Remove the active operation dir entirely (used after a clean abort). */
export const removeActiveOperation = async (archiveDir: string, operationId: string): Promise<void> => {
	const activeDir = operationDir(archiveDir, operationId)
	if (existsSync(activeDir)) {
		await durableRemove(activeDir)
		await syncDirectory(activeOperationsRoot(archiveDir))
	}
}

/**
 * Read the active generation id currently selected by the pointer for a
 * (signal, range), or null if no pointer exists. Throws on a malformed or
 * location-mismatched pointer (binding the pointer to its on-disk location).
 */
export const readActiveGenerationId = (
	archiveDir: string,
	signal: string,
	rangeDate: string,
): string | null => {
	const pointerPath = activePointerPath(archiveDir, signal, rangeDate)
	if (!existsSync(pointerPath)) return null
	assertNoSymlinkSync(archiveDir, pointerPath, "archive active pointer")
	assertRealFileSync(pointerPath, "archive active pointer")
	const parsed = JSON.parse(readFileSync(pointerPath, "utf8")) as unknown
	const pointer = parseArchiveActivePointer(parsed, signal, rangeDate)
	return pointer.generationId
}

/**
 * Resolve the base active generation id strictly, returning null only when there
 * is genuinely no pointer. Used to record the CAS base before promotion.
 */
export const resolveBaseActiveGenerationId = (
	archiveDir: string,
	signal: string,
	rangeDate: string,
): string | null => readActiveGenerationId(archiveDir, signal, rangeDate)

/**
 * Pre-allocate the owned building and final-generation paths from the archive
 * root and identities, for inspection and for the operation to record. These are
 * pure path computations; they do not create anything.
 */
export const ownedPathsFor = (intent: {
	readonly archiveDir: string
	readonly generationId: string
	readonly signal: string
	readonly rangeStart: string
}): { readonly finalGeneration: string; readonly building: string } => {
	const finalGeneration = join(
		rangeRoot(intent.archiveDir, intent.signal, intent.rangeStart),
		"generations",
		intent.generationId,
	)
	const building = join(archiveRoot(intent.archiveDir), "building", intent.generationId)
	void signalRoot
	return { finalGeneration, building }
}

/**
 * Assert the journal's recorded (signal, range) topology exists consistently
 * with the on-disk pointer for that location. Used by reconcile to validate that
 * the recorded CAS base still matches reality before flipping the pointer.
 */
export const assertPointerConsistent = (archiveDir: string, intent: ArchiveOperationIntent): void => {
	const current = readActiveGenerationId(archiveDir, intent.signal, intent.rangeStart)
	// The pointer must either still select the recorded base, or already select
	// the intended generation (an earlier promotion completed). Anything else
	// means concurrent activity moved the pointer and a blind flip would clobber
	// it — fail closed.
	if (current !== intent.baseActiveGenerationId && current !== intent.generationId) {
		throw new Error(
			`archive active pointer no longer matches the recorded base for ${intent.signal}/${intent.rangeStart}: ` +
				`recorded base ${intent.baseActiveGenerationId}, now ${current} (concurrent activity; refusing to clobber)`,
		)
	}
}

/**
 * Assert that a path is a real directory beneath the archive root (no symlink),
 * if it exists. Used by reconcile to validate owned topology before acting.
 */
export const assertOwnedDirectoryIfPresent = async (
	archiveDir: string,
	path: string,
	label: string,
): Promise<void> => {
	if (!existsSync(path)) return
	await assertNoSymlink(archiveDir, path, label)
	await assertRealDirectory(path, label)
	await assertRealFile(join(path, "intent.json"), `${label} intent`).catch(() => {
		throw new Error(`${label} is missing its intent.json: ${path}`)
	})
}
