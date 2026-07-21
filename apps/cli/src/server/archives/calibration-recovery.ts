// Calibration interruption recovery.
//
// A calibration run acquires a maintenance lock, a checkpoint pin, an owned
// scratch subdir, and an owned sample-output directory. A SIGKILL or crash at
// any point must leave reconcilable state: the NEXT calibration run reconciles
// the prior record and removes ONLY its exact owned paths and pin — all derived
// from the operation identifier, never accepted as arbitrary strings. This is
// the single authoritative reconciler: normal cleanup calls it too, so the
// crash path and the happy path share one proven removal routine.
//
// SAFETY INVARIANTS (every one enforced here, repairing the prior defects):
//  - ownedPaths are DERIVED from operationId (scratchSubdir=`calibrate-<op>`,
//    sampleDir=`<archiveDir>/calibration/samples/<op>`); a record claiming any
//    other paths is rejected. This was a recursive-deletion primitive before.
//  - the recovery record is read/written through the archive no-symlink
//    classifier + real-file checks; a planted recovery.json symlink is refused.
//  - the pin is DERIVED from the recorded pinId via pinFilePath(), so a crash
//    BETWEEN pin creation and the phase advance (pinPath null in the record)
//    still releases the exact pin. The recorded pinPath is validated against
//    the derived path; the purpose is operation-specific.
//  - reconcile runs INSIDE the maintenance lock (the caller enforces this) and
//    clears the record ONLY after every exact-owned resource is confirmed
//    absent; a real release/removal failure PRESERVES the record for retry.
//  - the checkpoint fingerprint is recorded and validated on reconcile.

import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs"
import { rm, statfs } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { durableJson, durableRemove } from "../durable-files"
import {
	assertCheckpointPinIdentity,
	checkpointRoot,
	checkpointSnapshotDir,
	parseCheckpointId,
	pinFilePath,
	releaseCheckpointPin,
	resolveCheckpoint,
} from "../checkpoints"
import { assertNoSymlinkSync, assertRealFileSync, classifyArchivePathSync, validateArchiveId } from "./paths"

/** The calibration recovery record format version. */
export const CALIBRATION_RECOVERY_FORMAT_VERSION = 1

/** The lifecycle phases a calibration run advances through. */
export type CalibrationPhase =
	| "intent"
	| "pin-acquired"
	| "scratch-allocated"
	| "sampling"
	| "validating"
	| "cleanup"
	| "complete"

/**
 * The durable ownership record for one calibration run. Written before any
 * allocation; advanced per phase. The next run reconciles a prior record by
 * releasing exactly the derived pin and removing exactly the derived owned
 * paths.
 */
export interface CalibrationRecoveryRecord {
	readonly formatVersion: typeof CALIBRATION_RECOVERY_FORMAT_VERSION
	readonly phase: CalibrationPhase
	readonly operationId: string
	readonly pinId: string
	readonly pinPurpose: string
	/** The pin file path returned by acquireCheckpointPin; null until acquired. */
	readonly pinPath: string | null
	readonly checkpointId: string
	readonly checkpointManifestFingerprint: string
	readonly boundRoots: {
		readonly dataDir: string
		readonly archiveDir: string
		readonly scratchRoot: string
	}
	readonly ownedPaths: {
		readonly scratchSubdir: string
		readonly sampleDir: string
	}
	readonly updatedAt: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

/** The recovery record path beneath the archive root. */
export const calibrationRecoveryPath = (archiveDir: string): string =>
	resolve(archiveDir, "calibration", "recovery.json")

/**
 * DERIVE the exact owned scratch subdir from the operation id. A recovery record
 * may only own `calibrate-<operationId>` beneath the scratch root — never an
 * arbitrary path. This is the ownership binding that was missing.
 */
export const derivedScratchSubdir = (operationId: string): string =>
	`calibrate-${validateArchiveId(operationId, "calibration operation")}`

/**
 * DERIVE the exact owned sample directory from the archive root and operation
 * id. A recovery record may only own `<archiveDir>/calibration/samples/<op>`.
 */
export const derivedSampleDir = (archiveDir: string, operationId: string): string =>
	resolve(archiveDir, "calibration", "samples", validateArchiveId(operationId, "calibration operation"))

/**
 * DERIVE the exact pin file path from the recorded pin id, so a crash between
 * pin creation and the phase advance still releases the exact pin.
 */
export const derivedPinPath = (dataDir: string, checkpointId: string, pinId: string): string =>
	pinFilePath(dataDir, checkpointId, pinId)

/** Operation-specific pin purpose, validated on release. */
export const calibrationPinPurpose = (operationId: string): string =>
	`archive-calibrate:${validateArchiveId(operationId, "calibration operation")}`

/**
 * Strictly parse a recovery record, binding it to the expected roots AND
 * deriving/validating the owned paths from the operation id. Rejects:
 *  - unknown format version / phase;
 *  - bound roots that don't resolve exactly to the expected roots (foreign record);
 *  - owned paths that are NOT the derived `calibrate-<op>` / `samples/<op>`;
 *  - a recorded pinPath that doesn't match the derived pin path;
 *  - a checkpoint fingerprint mismatch.
 *
 * Returns the parsed record plus the derived exact paths the reconciler removes.
 */
export const parseCalibrationRecoveryRecord = (
	value: unknown,
	expectedRoots: { dataDir: string; archiveDir: string; scratchRoot: string },
): CalibrationRecoveryRecord => {
	if (!isRecord(value)) throw new Error("malformed calibration recovery record (not a record)")
	if (value.formatVersion !== CALIBRATION_RECOVERY_FORMAT_VERSION) {
		throw new Error(
			`unsupported calibration recovery formatVersion ${String(value.formatVersion)} ` +
				`(expected ${CALIBRATION_RECOVERY_FORMAT_VERSION})`,
		)
	}
	const phase = value.phase
	const knownPhases: ReadonlySet<string> = new Set([
		"intent",
		"pin-acquired",
		"scratch-allocated",
		"sampling",
		"validating",
		"cleanup",
		"complete",
	])
	if (typeof phase !== "string" || !knownPhases.has(phase)) {
		throw new Error(`invalid calibration recovery phase: ${String(phase)}`)
	}
	const str = (k: string): string => {
		const v = value[k]
		if (typeof v !== "string" || v.length === 0)
			throw new Error(`invalid calibration recovery field: ${k}`)
		return v
	}
	// Validate before deriving any filesystem path. Without this, an operation
	// id such as `../../traces` resolves to an in-root but foreign directory and
	// turns reconciliation into an archive deletion primitive.
	const operationId = validateArchiveId(str("operationId"), "calibration operation")
	const pinId = str("pinId")
	const pinPurpose = str("pinPurpose")
	if (pinPurpose !== calibrationPinPurpose(operationId)) {
		throw new Error(
			`calibration recovery pinPurpose mismatch: expected ${calibrationPinPurpose(operationId)}, got ${pinPurpose}`,
		)
	}
	const checkpointId = str("checkpointId")
	const checkpointFingerprint = str("checkpointManifestFingerprint")
	const rootsRaw = value.boundRoots
	if (!isRecord(rootsRaw)) throw new Error("invalid calibration recovery field: boundRoots")
	const dataDir = typeof rootsRaw.dataDir === "string" ? rootsRaw.dataDir : ""
	const archiveDir = typeof rootsRaw.archiveDir === "string" ? rootsRaw.archiveDir : ""
	const scratchRoot = typeof rootsRaw.scratchRoot === "string" ? rootsRaw.scratchRoot : ""
	if (!dataDir || !archiveDir || !scratchRoot) {
		throw new Error("invalid calibration recovery boundRoots (all roots required)")
	}
	if (resolve(dataDir) !== resolve(expectedRoots.dataDir)) {
		throw new Error("calibration recovery dataDir mismatch; refusing to reconcile foreign record")
	}
	if (resolve(archiveDir) !== resolve(expectedRoots.archiveDir)) {
		throw new Error("calibration recovery archiveDir mismatch; refusing to reconcile foreign record")
	}
	if (resolve(scratchRoot) !== resolve(expectedRoots.scratchRoot)) {
		throw new Error("calibration recovery scratchRoot mismatch; refusing to reconcile foreign record")
	}
	// DERIVE the expected owned paths and require the record to match exactly.
	const expectedScratch = derivedScratchSubdir(operationId)
	const expectedSample = derivedSampleDir(archiveDir, operationId)
	const ownedRaw = value.ownedPaths
	if (!isRecord(ownedRaw)) throw new Error("invalid calibration recovery field: ownedPaths")
	const ownedScratch = typeof ownedRaw.scratchSubdir === "string" ? ownedRaw.scratchSubdir : ""
	const ownedSample = typeof ownedRaw.sampleDir === "string" ? ownedRaw.sampleDir : ""
	if (ownedScratch !== expectedScratch) {
		throw new Error(
			`calibration recovery scratchSubdir '${ownedScratch}' != derived '${expectedScratch}'; refusing`,
		)
	}
	if (resolve(ownedSample) !== resolve(expectedSample)) {
		throw new Error(
			`calibration recovery sampleDir '${ownedSample}' != derived '${expectedSample}'; refusing`,
		)
	}
	// DERIVE the expected pin path from pinId and validate the recorded pinPath.
	const expectedPinPath = derivedPinPath(dataDir, checkpointId, pinId)
	const recordedPinPath = typeof value.pinPath === "string" ? value.pinPath : null
	if (recordedPinPath !== null && resolve(recordedPinPath) !== resolve(expectedPinPath)) {
		throw new Error(
			`calibration recovery pinPath '${recordedPinPath}' != derived '${expectedPinPath}'; refusing`,
		)
	}
	return {
		formatVersion: CALIBRATION_RECOVERY_FORMAT_VERSION,
		phase: phase as CalibrationPhase,
		operationId,
		pinId,
		pinPurpose,
		pinPath: recordedPinPath,
		checkpointId,
		checkpointManifestFingerprint: checkpointFingerprint,
		boundRoots: { dataDir, archiveDir, scratchRoot },
		ownedPaths: { scratchSubdir: expectedScratch, sampleDir: expectedSample },
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
	}
}

/**
 * Read a prior recovery record through the archive no-symlink classifier + real
 * file checks (a planted recovery.json symlink is refused). Returns null if no
 * record exists. The parent chain beneath the archive root is validated.
 */
export const readPriorCalibrationRecord = (
	archiveDir: string,
	expectedRoots: { dataDir: string; archiveDir: string; scratchRoot: string },
): CalibrationRecoveryRecord | null => {
	const path = calibrationRecoveryPath(archiveDir)
	const topology = classifyArchivePathSync(archiveDir, path, "calibration recovery record")
	if (topology === "absent") return null
	if (topology !== "real-file") {
		throw new Error(
			`calibration recovery record is not a regular file (topology: ${topology}) at ${path}; refusing`,
		)
	}
	assertNoSymlinkSync(archiveDir, path, "calibration recovery record")
	assertRealFileSync(path, "calibration recovery record")
	const raw = JSON.parse(readFileSync(path, "utf8")) as unknown
	return parseCalibrationRecoveryRecord(raw, expectedRoots)
}

/**
 * Remove a single owned directory only if it is a real (non-symlink) directory
 * contained within its bound root. Idempotent: success if already absent. A
 * non-directory/symlink at the owned path is a hard failure (the caller
 * preserves the recovery record). `classifyArchivePathSync` proves containment
 * and rejects symlinked ancestors.
 */
const removeOwnedDir = async (root: string, dir: string, label: string): Promise<void> => {
	if (!isAbsolute(dir)) throw new Error(`calibration cleanup refused non-absolute ${label}: ${dir}`)
	const topology = classifyArchivePathSync(root, dir, label)
	if (topology === "absent") return // already gone — success
	if (topology !== "real-directory") {
		throw new Error(
			`calibration cleanup refused non-directory or symlinked ${label} at ${dir} (topology: ${topology})`,
		)
	}
	await rm(dir, { recursive: true, force: true })
}

/**
 * An intent is safe to retire without resolving its source checkpoint only when
 * it is provably inert: the record predates pin acquisition, records no pin
 * path, and every exact derived resource is absent. This closes the recovery
 * wedge where normal checkpoint retention removes the still-unpinned source
 * snapshot after a crash at `intent`.
 *
 * Every classification is symlink-aware and rooted. Any present resource,
 * unsafe topology, later phase, or surviving source snapshot keeps the normal
 * fingerprint-validation path fail-closed.
 */
const isInertIntentWithRetiredCheckpoint = (prior: CalibrationRecoveryRecord): boolean => {
	if (prior.phase !== "intent" || prior.pinPath !== null) return false
	const checkpointOwner = checkpointRoot(prior.boundRoots.dataDir)
	const snapshot = checkpointSnapshotDir(prior.boundRoots.dataDir, parseCheckpointId(prior.checkpointId))
	if (classifyArchivePathSync(checkpointOwner, snapshot, "calibration source checkpoint") !== "absent") {
		return false
	}
	const pinPath = derivedPinPath(prior.boundRoots.dataDir, prior.checkpointId, prior.pinId)
	if (classifyArchivePathSync(checkpointOwner, pinPath, "calibration checkpoint pin") !== "absent") {
		return false
	}
	const scratchOwned = resolve(prior.boundRoots.scratchRoot, prior.ownedPaths.scratchSubdir)
	if (
		classifyArchivePathSync(prior.boundRoots.scratchRoot, scratchOwned, "calibration scratch subdir") !==
		"absent"
	) {
		return false
	}
	if (
		classifyArchivePathSync(
			prior.boundRoots.archiveDir,
			prior.ownedPaths.sampleDir,
			"calibration sample dir",
		) !== "absent"
	) {
		return false
	}
	return true
}

/**
 * Reconcile a prior interrupted calibration run: release its exact DERIVED pin
 * and remove its exact DERIVED owned scratch subdir and sample directory, then
 * clear the record. The pin is derived from pinId so even an intent-phase crash
 * (pinPath null in the record, but the pin was actually created) releases it.
 *
 * MUST be called inside the maintenance lock (the caller enforces this).
 *
 * The record is cleared ONLY after every exact-owned resource is confirmed
 * absent. A real release/removal failure PRESERVES the record for retry — an
 * already-absent resource is success, but a real error does not lose authority.
 */
export const reconcileCalibration = async (
	archiveDir: string,
	expectedRoots: { dataDir: string; archiveDir: string; scratchRoot: string },
): Promise<void> => {
	const prior = readPriorCalibrationRecord(archiveDir, expectedRoots)
	if (prior === null) return // nothing to reconcile — idempotent no-op
	// Validate the checkpoint fingerprint against the LIVE checkpoint manifest, so
	// the recorded identity actually binds the reconciled pin to the checkpoint it
	// claims (C2). A stale/foreign fingerprint refuses to reconcile (preserve).
	let resolved
	try {
		resolved = await resolveCheckpoint(prior.boundRoots.dataDir, parseCheckpointId(prior.checkpointId))
	} catch (error) {
		// At intent, no allocation has been authorized yet. If normal checkpoint
		// retention removed the still-unpinned source and every exact derived
		// resource is provably absent, the recovery record itself is the only
		// remaining state and may be retired safely. Any ambiguity preserves it.
		if (isInertIntentWithRetiredCheckpoint(prior)) {
			await durableRemove(calibrationRecoveryPath(archiveDir))
			return
		}
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(
			`calibration reconcile: source checkpoint could not be validated; preserving record: ${message}`,
		)
	}
	const liveFingerprint = `${resolved.manifest.checkpointId}:${resolved.manifest.createdAt}:${resolved.manifest.backupBytes}`
	if (liveFingerprint !== prior.checkpointManifestFingerprint) {
		throw new Error(
			`calibration reconcile: checkpoint fingerprint mismatch (recorded ${prior.checkpointManifestFingerprint} != live ${liveFingerprint}); preserving record`,
		)
	}
	// Derive the exact pin path from pinId (works even at intent phase).
	const pinPath = derivedPinPath(prior.boundRoots.dataDir, prior.checkpointId, prior.pinId)
	let pinReleased = false
	try {
		await releaseCheckpointPin(prior.boundRoots.dataDir, prior.checkpointId, pinPath, prior.pinPurpose)
		pinReleased = true
	} catch (error) {
		// releaseCheckpointPin fails closed on absence too (over-retention safe),
		// so a missing pin is NOT an error here. A genuine identity mismatch,
		// however, is — and we preserve the record so the operator can intervene.
		const msg = error instanceof Error ? error.message : String(error)
		if (!/already absent|already released|not exist|no such|not found/i.test(msg)) {
			throw new Error(
				`calibration reconcile: pin release FAILED for ${pinPath} (preserving record): ${msg}`,
			)
		}
		pinReleased = true // absent pin = success
	}
	// Remove the exact derived owned paths.
	const scratchOwned = resolve(prior.boundRoots.scratchRoot, prior.ownedPaths.scratchSubdir)
	await removeOwnedDir(prior.boundRoots.scratchRoot, scratchOwned, "scratch subdir")
	await removeOwnedDir(prior.boundRoots.archiveDir, prior.ownedPaths.sampleDir, "sample dir")
	// Clear the record ONLY after all resources are confirmed absent.
	if (!pinReleased) {
		throw new Error(`calibration reconcile: pin not confirmed released; preserving record`)
	}
	await durableRemove(calibrationRecoveryPath(archiveDir))
}

/**
 * Validate that a child belongs to the live parent-owned calibration session.
 * Children never resolve `current`, acquire a replacement pin, or release the
 * session pin; they consume only this exact durable checkpoint identity.
 */
export const assertCalibrationSession = async (
	archiveDir: string,
	expectedRoots: { dataDir: string; archiveDir: string; scratchRoot: string },
	expected: {
		operationId: string
		checkpointId: string
		checkpointManifestFingerprint: string
	},
): Promise<CalibrationRecoveryRecord> => {
	const record = readPriorCalibrationRecord(archiveDir, expectedRoots)
	if (
		record === null ||
		record.operationId !== expected.operationId ||
		record.phase !== "pin-acquired" ||
		record.pinPath === null ||
		record.checkpointId !== expected.checkpointId ||
		record.checkpointManifestFingerprint !== expected.checkpointManifestFingerprint
	) {
		throw new Error("calibration child is not bound to the live parent session; refusing")
	}
	const pinTopology = classifyArchivePathSync(
		checkpointRoot(expectedRoots.dataDir),
		derivedPinPath(expectedRoots.dataDir, record.checkpointId, record.pinId),
		"calibration session pin",
	)
	if (pinTopology !== "real-file") {
		throw new Error(`calibration parent session pin is not live (${pinTopology}); refusing child`)
	}
	// Topology alone is not ownership: a same-path regular file could have been
	// substituted. Bind the exact pin id, checkpoint, and operation purpose.
	await assertCheckpointPinIdentity(
		expectedRoots.dataDir,
		record.checkpointId,
		derivedPinPath(expectedRoots.dataDir, record.checkpointId, record.pinId),
		record.pinPurpose,
	)
	return record
}

/** Remove only the session's derived scratch/sample dirs while retaining its pin and record. */
export const cleanupCalibrationSample = async (record: CalibrationRecoveryRecord): Promise<void> => {
	await removeOwnedDir(
		record.boundRoots.scratchRoot,
		resolve(record.boundRoots.scratchRoot, record.ownedPaths.scratchSubdir),
		"scratch subdir",
	)
	await removeOwnedDir(record.boundRoots.archiveDir, record.ownedPaths.sampleDir, "sample dir")
}

/**
 * Write (or advance) the recovery record at the calibration recovery path,
 * validating the owned paths are derived from the operation id. Called before
 * allocation and at each phase transition so a crash at any point leaves a
 * record naming exactly what to release. Writes through the path safety checks.
 */
export const writeCalibrationRecord = async (
	archiveDir: string,
	record: Omit<CalibrationRecoveryRecord, "formatVersion" | "updatedAt">,
): Promise<void> => {
	// Validate owned paths are derived from operationId before writing.
	const expectedScratch = derivedScratchSubdir(record.operationId)
	const expectedSample = derivedSampleDir(archiveDir, record.operationId)
	if (record.ownedPaths.scratchSubdir !== expectedScratch) {
		throw new Error(
			`calibration record scratchSubdir '${record.ownedPaths.scratchSubdir}' != derived '${expectedScratch}'`,
		)
	}
	if (resolve(record.ownedPaths.sampleDir) !== resolve(expectedSample)) {
		throw new Error(
			`calibration record sampleDir '${record.ownedPaths.sampleDir}' != derived '${expectedSample}'`,
		)
	}
	if (record.pinPurpose !== calibrationPinPurpose(record.operationId)) {
		throw new Error(`calibration record pinPurpose must be operation-specific`)
	}
	const path = calibrationRecoveryPath(archiveDir)
	// Validate the parent chain is symlink-safe before durableJson writes.
	assertNoSymlinkSync(archiveDir, path, "calibration recovery record")
	await durableJson(path, {
		formatVersion: CALIBRATION_RECOVERY_FORMAT_VERSION,
		updatedAt: new Date().toISOString(),
		...record,
	})
}

/**
 * Measure the on-disk size of a directory tree (bytes), for peak temporary-disk
 * accounting. Returns 0 if the path is absent (ENOENT). Any non-ENOENT read/stat
 * error is THROWN (fail-loud) — the caller (the watchdog) treats a measurement
 * error as candidate failure, not an undercount. Internal symlinks are followed
 * only when their canonical target remains beneath the canonical owned root.
 * A visited `(dev, ino)` set prevents symlink cycles and physical double-counts.
 * Unknown special entries fail closed.
 */
export const directoryTreeBytes = async (dir: string): Promise<number> => {
	const { lstat, readdir, realpath, stat } = await import("node:fs/promises")
	const { isAbsolute: pathIsAbsolute, join, relative, sep } = await import("node:path")
	const root = resolve(dir)
	let rootInfo
	try {
		rootInfo = await lstat(root)
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === "ENOENT") return 0
		throw new Error(`directoryTreeBytes: failed to inspect root ${root}: ${code ?? error}`)
	}
	if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
		throw new Error(`directoryTreeBytes: owned root must be a real directory: ${root}`)
	}
	const canonicalRoot = await realpath(root)
	const visited = new Set<string>()
	let total = 0

	const contained = (target: string): boolean => {
		const rel = relative(canonicalRoot, target)
		return rel === "" || (!pathIsAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
	}

	const walkResolved = async (p: string, info: Awaited<ReturnType<typeof stat>>): Promise<void> => {
		const identity = `${info.dev}:${info.ino}`
		if (visited.has(identity)) return
		visited.add(identity)
		if (info.isFile()) {
			total += Number(info.size)
			return
		}
		if (!info.isDirectory()) {
			throw new Error(`directoryTreeBytes: refusing special entry ${p}`)
		}
		let entries
		try {
			entries = await readdir(p, { withFileTypes: true })
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code === "ENOENT") return
			throw new Error(`directoryTreeBytes: failed to read ${p}: ${code ?? error}`)
		}
		for (const entry of entries) {
			await walk(join(p, entry.name))
		}
	}

	const walk = async (p: string): Promise<void> => {
		let linkInfo
		try {
			linkInfo = await lstat(p)
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code === "ENOENT") return
			throw new Error(`directoryTreeBytes: failed to inspect ${p}: ${code ?? error}`)
		}
		if (linkInfo.isSymbolicLink()) {
			let target
			try {
				target = await realpath(p)
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code
				if (code === "ENOENT") return
				throw new Error(`directoryTreeBytes: failed to resolve symlink ${p}: ${code ?? error}`)
			}
			if (!contained(target)) {
				throw new Error(`directoryTreeBytes: symlink escapes owned root: ${p} -> ${target}`)
			}
			await walkResolved(target, await stat(target))
			return
		}
		await walkResolved(p, linkInfo)
	}

	await walk(root)
	return total
}

/**
 * Capture the archive-volume identity (device id + filesystem type) for the
 * calibration environment record so a volume change is detectable. Uses the
 * device id from stat (cross-platform) plus the statfs filesystem type.
 */
export const archiveVolumeIdentity = async (archiveDir: string): Promise<{ fsid: string; type: number }> => {
	const statPath = resolve(archiveDir)
	const link = lstatSync(statPath)
	if (!link.isDirectory() || link.isSymbolicLink()) {
		throw new Error(
			`archive volume inspection requires an existing real non-symlink directory: ${statPath}`,
		)
	}
	if (realpathSync(statPath) !== statPath) {
		throw new Error(`archive volume inspection requires a canonical archive root: ${statPath}`)
	}
	const info = await statfs(statPath)
	// Use the device id (cross-platform, from statSync) as the volume id, plus
	// the statfs filesystem type. Together they identify the volume+filesystem.
	const dev = statSync(statPath).dev.toString(16)
	return { fsid: `dev:${dev}`, type: info.type }
}

const existsSyncSafe = (p: string): boolean => {
	try {
		return statSync(p) !== undefined
	} catch {
		return false
	}
}

/**
 * Free-space preflight for the archive volume, reusing the same statfs idiom as
 * the production free-space check. Throws if available free bytes are below the
 * required reserve plus estimated working bytes.
 */
export const preflightCalibrationFreeSpace = async (
	archiveDir: string,
	freeSpaceReserve: number,
	estimatedWorkingBytes: number,
): Promise<void> => {
	let statPath = resolve(archiveDir)
	let climbs = 0
	while (!existsSyncSafe(statPath) && climbs < 64) {
		statPath = dirname(statPath)
		climbs++
	}
	if (!existsSyncSafe(statPath)) {
		throw new Error(
			`calibration free-space preflight could not find an existing ancestor of ${archiveDir}`,
		)
	}
	const info = await statfs(statPath)
	const free = info.bavail * info.bsize
	const required = freeSpaceReserve + estimatedWorkingBytes
	if (free < required) {
		throw new Error(
			`calibration free-space preflight failed: ${free} bytes free on ${statPath} ` +
				`< ${required} required (reserve ${freeSpaceReserve} + working ${estimatedWorkingBytes})`,
		)
	}
}
