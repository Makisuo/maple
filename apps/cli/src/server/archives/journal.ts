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

/**
 * Versioned journal format. The parser accepts only this version (fail-closed on
 * any other). Gate 3b raises v2 → v3 to introduce the `kind` discriminator
 * (create vs gc) so reconcile can dispatch on operation type. A v2 create intent
 * is migrated to v3 under the maintenance lock by {@link migrateV2CreateIntent};
 * the parser never silently reinterprets a v2 record.
 */
export const ARCHIVE_OPERATION_FORMAT_VERSION = 3 as const

/** Operation kind discriminator recorded in every v3 intent. */
export const ARCHIVE_OPERATION_KINDS = ["create", "gc"] as const
export type ArchiveOperationKind = (typeof ARCHIVE_OPERATION_KINDS)[number]

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

/** Fields common to every operation kind. */
export interface ArchiveOperationBase {
	readonly formatVersion: typeof ARCHIVE_OPERATION_FORMAT_VERSION
	readonly kind: ArchiveOperationKind
	readonly operationId: string
	/** Configured roots recorded so reconciliation can locate owned state. */
	readonly archiveDir: string
	readonly dataDir: string
	readonly scratchRoot: string
	readonly phase: ArchiveOperationPhase
	readonly createdAt: string
	readonly updatedAt: string
}

/**
 * A create-generation operation intent (Gate 3a). Carries the deterministic
 * pin/scratch/generation identities and the manifest SHA-256 once published.
 */
export interface CreateOperationIntent extends ArchiveOperationBase {
	readonly kind: "create"
	readonly generationId: string
	readonly signal: string
	readonly rangeStart: string
	readonly checkpointId: string
	/** Deterministic identities recorded BEFORE allocation. */
	readonly pinId: string
	readonly pinPurpose: string
	readonly scratchSubdir: string
	/** SHA-256 of the exact durable manifest bytes once phase >= manifest-written. */
	readonly manifestSha256: string | null
	/** The generation this operation supersedes, or null if none (CAS base). */
	readonly baseActiveGenerationId: string | null
}

/**
 * A single target of garbage collection: one superseded generation to delete,
 * with the evidence (manifest SHA + per-shard bytes/SHA) reconciliation uses to
 * revalidate the source before each tombstone rename, and the recorded active
 * generation for its range so collection can refuse a pointer that came back.
 */
export interface GcTarget {
	readonly signal: string
	readonly rangeStart: string
	readonly generationId: string
	readonly createdAt: string
	readonly manifestSha256: string
	readonly bytes: number
	readonly shards: ReadonlyArray<{ readonly name: string; readonly bytes: number; readonly sha256: string }>
	/** The exact active generation recorded for this target's range at plan time. */
	readonly recordedActiveGenerationId: string
}

/**
 * A garbage-collection operation intent (Gate 3b). Records the FROZEN deletion
 * set computed under the maintenance lock. Reconciliation drives the frozen set
 * to completion idempotently and NEVER expands it — a resumed GC deletes exactly
 * what the original decided.
 */
export interface GcOperationIntent extends ArchiveOperationBase {
	readonly kind: "gc"
	readonly keep: number
	readonly targets: ReadonlyArray<GcTarget>
	/** Number of targets whose deletion has completed (progress cursor). */
	readonly completedTargets: number
}

export type ArchiveOperationIntent = CreateOperationIntent | GcOperationIntent

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
 * Strict parse of an operation intent. Validates format version, the `kind`
 * discriminator, every identity, phase, and path containment, then dispatches
 * create-vs-gc field parsing. Throws on any defect (fail-closed); the caller
 * preserves the offending files. Parsed identities are validated to be real
 * archive IDs / range dates so a corrupted or hand-edited journal cannot direct
 * reconciliation at arbitrary paths. A v2 (pre-kind) record is rejected here;
 * use {@link migrateV2CreateIntent} to lift a v2 create intent to v3 under the
 * maintenance lock before parsing.
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
	const kind = requiredString(raw.kind, "kind") as ArchiveOperationKind
	if (!ARCHIVE_OPERATION_KINDS.includes(kind)) {
		throw new Error(`invalid archive operation kind: ${kind}`)
	}
	const operationId = validateArchiveId(requiredString(raw.operationId, "operationId"), "operation")
	const phase = requiredString(raw.phase, "phase") as ArchiveOperationPhase
	if (!ARCHIVE_OPERATION_PHASES.includes(phase)) {
		throw new Error(`invalid archive operation phase: ${phase}`)
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
	const createdAt = requiredString(raw.createdAt, "createdAt")
	const updatedAt = requiredString(raw.updatedAt, "updatedAt")
	// Roots are recorded for inspection/recovery; they are not authority to act
	// outside the archive root. The archive root itself is re-derived.
	if (kind === "create")
		return parseCreateIntent(
			raw,
			operationId,
			phase,
			recordedArchiveDir,
			recordedDataDir,
			recordedScratchRoot,
			createdAt,
			updatedAt,
		)
	return parseGcIntent(
		raw,
		operationId,
		phase,
		recordedArchiveDir,
		recordedDataDir,
		recordedScratchRoot,
		createdAt,
		updatedAt,
	)
}

const parseCreateIntent = (
	raw: Record<string, unknown>,
	operationId: string,
	phase: ArchiveOperationPhase,
	recordedArchiveDir: string,
	recordedDataDir: string,
	recordedScratchRoot: string,
	createdAt: string,
	updatedAt: string,
): CreateOperationIntent => {
	const generationId = validateArchiveId(requiredString(raw.generationId, "generationId"), "generation")
	const signal = archiveSignal(requiredString(raw.signal, "signal")).name
	const rangeStart = validateRangeDate(requiredString(raw.rangeStart, "rangeStart"))
	const checkpointId = validateArchiveId(requiredString(raw.checkpointId, "checkpointId"), "checkpoint")
	const pinId = validateArchiveId(requiredString(raw.pinId, "pinId"), "pin")
	const scratchSubdir = requiredString(raw.scratchSubdir, "scratchSubdir")
	if (scratchSubdir !== `archive-${operationId}`) {
		throw new Error(`invalid scratch subdir in journal: ${scratchSubdir}`)
	}
	const pinPurpose = requiredString(raw.pinPurpose, "pinPurpose")
	if (pinPurpose !== `archive:${generationId}`) {
		throw new Error(`archive operation pin purpose does not match generation: ${pinPurpose}`)
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
	return {
		formatVersion: ARCHIVE_OPERATION_FORMAT_VERSION,
		kind: "create",
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
		createdAt,
		updatedAt,
	}
}

const parseGcIntent = (
	raw: Record<string, unknown>,
	operationId: string,
	phase: ArchiveOperationPhase,
	recordedArchiveDir: string,
	recordedDataDir: string,
	recordedScratchRoot: string,
	createdAt: string,
	updatedAt: string,
): GcOperationIntent => {
	const keepRaw = raw.keep
	if (typeof keepRaw !== "number" || !Number.isSafeInteger(keepRaw) || keepRaw < 0) {
		throw new Error(`archive operation gc intent has invalid keep: ${String(keepRaw)}`)
	}
	const completedTargetsRaw = raw.completedTargets
	if (
		typeof completedTargetsRaw !== "number" ||
		!Number.isSafeInteger(completedTargetsRaw) ||
		completedTargetsRaw < 0
	) {
		throw new Error(
			`archive operation gc intent has invalid completedTargets: ${String(completedTargetsRaw)}`,
		)
	}
	const targetsRaw = raw.targets
	if (!Array.isArray(targetsRaw)) {
		throw new Error("archive operation gc intent targets is not an array")
	}
	const targets: GcTarget[] = targetsRaw.map((t, i) => parseGcTarget(t, i))
	if (completedTargetsRaw > targets.length) {
		throw new Error(
			`archive operation gc intent completedTargets ${completedTargetsRaw} exceeds targets ${targets.length}`,
		)
	}
	return {
		formatVersion: ARCHIVE_OPERATION_FORMAT_VERSION,
		kind: "gc",
		operationId,
		keep: keepRaw,
		targets,
		completedTargets: completedTargetsRaw,
		archiveDir: recordedArchiveDir,
		dataDir: recordedDataDir,
		scratchRoot: recordedScratchRoot,
		phase,
		createdAt,
		updatedAt,
	}
}

const parseGcTarget = (raw: unknown, index: number): GcTarget => {
	if (!isRecord(raw)) throw new Error(`archive gc target ${index} is not a record`)
	const signal = archiveSignal(requiredString(raw.signal, "signal")).name
	const rangeStart = validateRangeDate(requiredString(raw.rangeStart, "rangeStart"))
	const generationId = validateArchiveId(requiredString(raw.generationId, "generationId"), "generation")
	const createdAt = requiredString(raw.createdAt, "createdAt")
	const manifestSha256 = requiredString(raw.manifestSha256, "manifestSha256").toLowerCase()
	if (!/^[0-9a-f]{64}$/.test(manifestSha256)) {
		throw new Error(`archive gc target ${index} has invalid manifestSha256`)
	}
	const bytesRaw = raw.bytes
	if (typeof bytesRaw !== "number" || !Number.isSafeInteger(bytesRaw) || bytesRaw < 0) {
		throw new Error(`archive gc target ${index} has invalid bytes: ${String(bytesRaw)}`)
	}
	const recordedActiveGenerationId = validateArchiveId(
		requiredString(raw.recordedActiveGenerationId, "recordedActiveGenerationId"),
		"active generation",
	)
	const shardsRaw = raw.shards
	if (!Array.isArray(shardsRaw)) {
		throw new Error(`archive gc target ${index} shards is not an array`)
	}
	const shards = shardsRaw.map((s, j) => {
		if (!isRecord(s)) throw new Error(`archive gc target ${index} shard ${j} is not a record`)
		const name = requiredString(s.name, "name")
		const bytes = s.bytes
		if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
			throw new Error(`archive gc target ${index} shard ${j} invalid bytes`)
		}
		const sha256 = requiredString(s.sha256, "sha256").toLowerCase()
		if (!/^[0-9a-f]{64}$/.test(sha256)) {
			throw new Error(`archive gc target ${index} shard ${j} invalid sha256`)
		}
		return { name, bytes, sha256 }
	})
	return {
		signal,
		rangeStart,
		generationId,
		createdAt,
		manifestSha256,
		bytes: bytesRaw,
		shards,
		recordedActiveGenerationId,
	}
}

/**
 * Migrate a v2 (pre-kind) create intent record to v3 under the maintenance lock.
 * This is a mechanical, validated field addition: `kind: "create"` is the only
 * new field, and no existing semantics change. The input is re-validated strictly
 * so a corrupt v2 record fails migration (and reconciliation) rather than being
 * silently lifted. Returns the v3 record (unparsed, for durably rewriting the
 * intent.json) — callers should re-parse via {@link parseArchiveOperationIntent}.
 *
 * Never used for a v1 record or any record that is not a clean v2 create intent.
 */
export const migrateV2CreateIntent = (
	archiveDir: string,
	raw: unknown,
	expectedDataDir?: string,
	expectedScratchRoot?: string,
): Record<string, unknown> => {
	if (!isRecord(raw)) throw new Error("archive operation intent is not a record (v2 migration)")
	if (raw.formatVersion !== 2) {
		throw new Error(`v2 migration requires formatVersion 2, got ${String(raw.formatVersion)}`)
	}
	// Re-validate every v2 field strictly before lifting. Reuse the create parser
	// by synthesizing a v3 record: parse it, then emit it. This guarantees the
	// migrated record passes the v3 parser byte-for-byte.
	const lifted: Record<string, unknown> = {
		...raw,
		formatVersion: ARCHIVE_OPERATION_FORMAT_VERSION,
		kind: "create",
	}
	// parseArchiveOperationIntent validates all fields + the kind discriminator.
	parseArchiveOperationIntent(archiveDir, lifted, expectedDataDir, expectedScratchRoot)
	return lifted
}

/**
 * If the single active operation's intent is a legacy v2 record, durably migrate
 * it to v3 under the maintenance lock BEFORE reading/parsing it. Returns true if
 * a migration occurred. A v2 record left by a pre-v3 binary (Gate 3a) would
 * otherwise strand — the v3 parser rejects it and reconciliation fails closed,
 * blocking all future archive work. This lifts it so reconcile can proceed.
 *
 * No-op when there is no active op, more than one (ambiguous), or the record is
 * already v3. A malformed v2 record fails migration and reconcile fails closed.
 */
export const migrateActiveIntentIfLegacy = async (
	archiveDir: string,
	expectedDataDir?: string,
	expectedScratchRoot?: string,
): Promise<boolean> => {
	const ids = listActiveOperationIds(archiveDir)
	if (ids.length !== 1) return false
	const operationId = ids[0]!
	const path = intentPath(archiveDir, operationId)
	if (!existsSync(path)) return false
	let raw: unknown
	try {
		raw = JSON.parse(readFileSync(path, "utf8")) as unknown
	} catch {
		return false
	}
	if (!isRecord(raw) || raw.formatVersion !== 2) return false
	// Lift + validate. A corrupt v2 record throws here → reconcile fails closed.
	const lifted = migrateV2CreateIntent(archiveDir, raw, expectedDataDir, expectedScratchRoot)
	const { durableJson } = await import("../durable-files")
	await durableJson(path, lifted)
	await syncDirectory(operationDir(archiveDir, operationId))
	return true
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
	const record: CreateOperationIntent = {
		formatVersion: ARCHIVE_OPERATION_FORMAT_VERSION,
		kind: "create",
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
 * `manifestSha256` applies only to create intents (ignored for gc).
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
	let updated: ArchiveOperationIntent
	if (current.kind === "create") {
		const nextManifestSha256 = next === "aborted" ? null : (manifestSha256 ?? current.manifestSha256)
		if (
			phaseRequiresManifest(next) &&
			(nextManifestSha256 === null || !/^[0-9a-f]{64}$/.test(nextManifestSha256))
		) {
			throw new Error(`archive operation phase ${next} requires a manifest SHA-256`)
		}
		updated = {
			...current,
			phase: next,
			manifestSha256: nextManifestSha256,
			updatedAt: new Date().toISOString(),
		}
	} else {
		updated = { ...current, phase: next, updatedAt: new Date().toISOString() }
	}
	await durableJson(intentPath(archiveDir, operationId), updated)
	await syncDirectory(operationDir(archiveDir, operationId))
	return updated
}

/**
 * Persist the initial GC intent BEFORE any collection. Records the FROZEN
 * deletion set computed under the maintenance lock, so a crashed/resumed GC
 * deletes exactly what the original decided — never re-expanded.
 */
export const writeGcIntent = async (intent: {
	readonly archiveDir: string
	readonly operationId: string
	readonly dataDir: string
	readonly scratchRoot: string
	readonly keep: number
	readonly targets: ReadonlyArray<GcTarget>
}): Promise<void> => {
	const dir = operationDir(intent.archiveDir, intent.operationId)
	await ensurePrivateDirectory(dir, archiveRoot(intent.archiveDir))
	await assertNoSymlink(intent.archiveDir, dir, "archive operation")
	const now = new Date().toISOString()
	const record: GcOperationIntent = {
		formatVersion: ARCHIVE_OPERATION_FORMAT_VERSION,
		kind: "gc",
		operationId: intent.operationId,
		keep: intent.keep,
		targets: intent.targets,
		completedTargets: 0,
		archiveDir: resolve(intent.archiveDir),
		dataDir: resolve(intent.dataDir),
		scratchRoot: resolve(intent.scratchRoot),
		phase: "intent",
		createdAt: now,
		updatedAt: now,
	}
	await durableJson(intentPath(intent.archiveDir, intent.operationId), record)
	await syncDirectory(dir)
}

/**
 * Rewrite a GC intent's progress cursor (completedTargets) + phase. Used by the
 * crash-safe collector after each target completes so a resume resumes at the
 * right point. The frozen target list is never mutated.
 */
export const persistGcProgress = async (
	archiveDir: string,
	operationId: string,
	completedTargets: number,
	phase: ArchiveOperationPhase,
): Promise<GcOperationIntent> => {
	const current = readIntent(archiveDir, operationId)
	if (current.kind !== "gc") {
		throw new Error(`archive operation is not a gc operation: ${operationId}`)
	}
	if (PHASE_ORDER[phase] < PHASE_ORDER[current.phase]) {
		throw new Error(`archive operation phase regression: ${current.phase} -> ${phase}`)
	}
	const updated: GcOperationIntent = {
		...current,
		completedTargets,
		phase,
		updatedAt: new Date().toISOString(),
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
export const assertPointerConsistent = (archiveDir: string, intent: CreateOperationIntent): void => {
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
