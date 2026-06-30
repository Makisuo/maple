import { createHash, randomUUID } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { lstat, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { durableRename, syncDirectory } from "../durable-files"
import {
	activePointerPath,
	archiveRoot,
	assertNoSymlink,
	assertNoSymlinkSync,
	assertRealFile,
	ensurePrivateDirectory,
	generationManifestPath,
	generationRoot,
	generationsRoot,
	signalRoot,
} from "./paths"
import {
	readArchiveGenerationManifest,
	type ArchiveGenerationManifest,
	type ArchiveShardRecord,
} from "./manifest"
import { archiveSignal, type ArchiveSignalName, ARCHIVE_SIGNALS } from "./signals"
import {
	archiveCompletedOperation,
	operationDir,
	persistGcProgress,
	readActiveOperation,
	writeGcIntent,
	type GcOperationIntent,
	type GcTarget,
} from "./journal"
import { assertCatalogExact, rebuildCatalog } from "./listing"
import { withMaintenanceLock } from "../checkpoints"

// Garbage collection of superseded archive generations (Gate 3b).
//
// GC reclaims disk space by deleting generations that a later generation
// superseded. It is the ONLY archive operation that deletes published
// generations, so it is conservative to a fault: it deletes only superseded
// generations it can PROVE are not the active pointer target, with manifest +
// per-shard evidence recorded in a frozen journal before any deletion, and it
// collects via a tombstone rename (never an in-place recursive delete) so a
// SIGKILL mid-collection leaves state the next reconcile can prove it owns.
//
// A GC operation shares the single permitted `operations/active/` slot with
// create operations and is reconciled by the same
// `reconcileArchiveGeneration` entry point (dispatched on `kind: "gc"`). So a
// crashed GC must be reconcilable or it blocks all future archive work.

export interface GcShardEvidence {
	readonly name: string
	readonly bytes: number
	readonly sha256: string
}

export interface GcDeleteCandidate {
	readonly signal: string
	readonly rangeStart: string
	readonly generationId: string
	readonly createdAt: string
	readonly manifestSha256: string
	readonly bytes: number
	readonly shards: ReadonlyArray<GcShardEvidence>
	readonly recordedActiveGenerationId: string
	readonly sourcePath: string
}

export interface GcRetained {
	readonly signal: string
	readonly rangeStart: string
	readonly generationId: string
	readonly createdAt: string
	readonly reason: "active" | "kept" | "uncertain"
}

export interface GcExcludedRange {
	readonly signal: string
	readonly rangeStart: string
	readonly reason: string
}

export interface GcExcludedSignal {
	readonly signal: string
	readonly reason: string
}

export interface GcPlan {
	readonly archiveDir: string
	readonly keep: number
	readonly deleteSet: ReadonlyArray<GcDeleteCandidate>
	readonly retained: ReadonlyArray<GcRetained>
	readonly excludedRanges: ReadonlyArray<GcExcludedRange>
	readonly excludedSignals: ReadonlyArray<GcExcludedSignal>
	readonly reclaimableBytes: number
}

/**
 * Fault seams for crash-safety validation (Gate 3b). Committed test seam, not a
 * production switch. The crash harness SIGKILLs the worker at these exact
 * intra-boundary points where unwinding would mask a real crash. Each is AWAITED
 * AFTER the named boundary is durable, before the next destructive step.
 */
export interface GcFaults {
	/** After the frozen GC intent is durably written, before any collection. */
	readonly afterIntentDurable?: () => void | Promise<void>
	/** After the source→tombstone rename of the FIRST target, before its removal. */
	readonly afterFirstTargetRenamed?: () => void | Promise<void>
	/**
	 * After a target's gc-collecting progress record is durably written (the target
	 * fully removed + progress persisted). `index` is the 0-based target index;
	 * `total` is targets.length. Fired for EVERY target including the final one.
	 * This is the authoritative seam for the nonfinal-progress boundary (index <
	 * total-1), which exposes the premature-complete defect: a SIGKILL here must
	 * leave the op at gc-collecting (not complete), so reconcile resumes and
	 * collects the remaining targets.
	 */
	readonly afterTargetProgress?: (index: number, total: number) => void | Promise<void>
	/** After every target is removed (cursor full), before catalog rebuild. */
	readonly afterAllRemovals?: () => void | Promise<void>
	/** After the affected catalogs are rebuilt, before the journal is marked complete. */
	readonly afterCatalogRebuilt?: () => void | Promise<void>
}

/** SHA-256 of a file's contents (whole-file read; GC targets are bounded shards). */
const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex")

/** Validate a generation dir + manifest + shards, returning the evidence. Throws on any defect. */
const verifyGenerationEvidence = (
	archiveDir: string,
	signal: string,
	rangeStart: string,
	generationId: string,
): {
	readonly manifest: ArchiveGenerationManifest
	readonly manifestSha256: string
	readonly bytes: number
	readonly shards: ReadonlyArray<GcShardEvidence>
} => {
	const sourcePath = generationRoot(archiveDir, signal, rangeStart, generationId)
	assertNoSymlinkSync(archiveDir, sourcePath, "archive generation")
	const manifestPath = generationManifestPath(archiveDir, signal, rangeStart, generationId)
	assertNoSymlinkSync(archiveDir, manifestPath, "archive generation manifest")
	assertRealFile(manifestPath, "archive generation manifest")
	const manifestSha256 = sha256File(manifestPath)
	const manifest = readArchiveGenerationManifest(archiveDir, signal, rangeStart, generationId)
	if (
		manifest.generationId !== generationId ||
		manifest.signal !== signal ||
		manifest.rangeStart !== rangeStart
	) {
		throw new Error(`archive generation manifest identity mismatch: ${sourcePath}`)
	}
	let bytes = 0
	const shards: GcShardEvidence[] = []
	for (const shard of manifest.shards as ReadonlyArray<ArchiveShardRecord>) {
		const shardPath = join(sourcePath, "shards", shard.name)
		assertNoSymlinkSync(archiveDir, shardPath, `archive shard ${shard.name}`)
		assertRealFile(shardPath, `archive shard ${shard.name}`)
		const actualBytes = statSync(shardPath).size
		if (actualBytes !== shard.bytes) {
			throw new Error(
				`archive shard ${shard.name} byte mismatch: manifest ${shard.bytes}, actual ${actualBytes}`,
			)
		}
		const actualSha = sha256File(shardPath)
		if (actualSha !== shard.sha256) {
			throw new Error(`archive shard ${shard.name} SHA-256 mismatch (tampered)`)
		}
		bytes += actualBytes
		shards.push({ name: shard.name, bytes: actualBytes, sha256: actualSha })
	}
	return { manifest, manifestSha256, bytes, shards }
}

/**
 * Plan a GC run: enumerate superseded generations and decide the delete/retain
 * sets. Strict and fail-closed; NEVER called before acquiring the maintenance
 * lock. If a signal cannot be authoritatively catalog-reconstructed (any
 * malformed manifest/shard/pointer), the ENTIRE signal is excluded — GC never
 * deletes a range and then discovers reconstruction is impossible.
 *
 * `keep` is the number of newest superseded generations to retain per range.
 */
export const planArchiveGc = (archiveDir: string, keep: number): GcPlan => {
	if (!Number.isSafeInteger(keep) || keep < 0) {
		throw new Error(`invalid gc keep value: ${keep}`)
	}
	const deleteSet: GcDeleteCandidate[] = []
	const retained: GcRetained[] = []
	const excludedRanges: GcExcludedRange[] = []
	const excludedSignals: GcExcludedSignal[] = []
	let reclaimableBytes = 0

	for (const signalEntry of ARCHIVE_SIGNALS) {
		const signal = signalEntry.name
		const sRoot = signalRoot(archiveDir, signal)
		if (!existsSync(sRoot)) continue
		// Signal-level proof: can this signal's catalog be authoritatively
		// reconstructed? If any range/generation is malformed, exclude the WHOLE
		// signal before touching any of its ranges.
		try {
			// Authoritative reconstruction requires the signal root to exist; if it
			// does, assert the catalog is provably reconstructable by attempting the
			// exact check against current manifests (rebuild is non-mutating on
			// failure, but assertCatalogExact only reads — it does not write).
			const sigName = archiveSignal(signal).name as ArchiveSignalName
			if (existsSync(signalRoot(archiveDir, signal))) assertCatalogExact(archiveDir, sigName)
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			excludedSignals.push({ signal, reason: `signal catalog not provably reconstructable: ${reason}` })
			continue
		}
		let ranges: string[]
		try {
			ranges = readdirSync(sRoot)
				.filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e))
				.sort()
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			excludedSignals.push({ signal, reason: `signal root unreadable: ${reason}` })
			continue
		}
		for (const rangeStart of ranges) {
			const gensRoot = generationsRoot(archiveDir, signal, rangeStart)
			if (!existsSync(gensRoot)) continue
			// Resolve the active generation for this range strictly.
			let activeGenerationId: string | null
			try {
				activeGenerationId = readActiveGenerationIdStrict(archiveDir, signal, rangeStart)
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error)
				excludedRanges.push({ signal, rangeStart, reason: `ambiguous active pointer: ${reason}` })
				continue
			}
			// A MISSING active pointer is uncertain state: without it, every
			// generation is ambiguous (none is provably active), and recording an
			// empty-string sentinel would produce an invalid journal the parser
			// rejects on recovery (blocker 4). Over-retain the ENTIRE range.
			if (activeGenerationId === null) {
				excludedRanges.push({
					signal,
					rangeStart,
					reason: "no active pointer; range is uncertain (over-retained)",
				})
				continue
			}
			let generationIds: string[]
			try {
				generationIds = readdirSync(gensRoot).sort()
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error)
				excludedRanges.push({ signal, rangeStart, reason: `generations root unreadable: ${reason}` })
				continue
			}
			// Verify every generation in the range up front; any defect excludes the
			// range (conservative — never partially collect a range).
			const verified: Array<{
				generationId: string
				createdAt: string
				manifestSha256: string
				bytes: number
				shards: ReadonlyArray<GcShardEvidence>
			}> = []
			try {
				for (const generationId of generationIds) {
					const ev = verifyGenerationEvidence(archiveDir, signal, rangeStart, generationId)
					verified.push({
						generationId,
						createdAt: ev.manifest.createdAt,
						manifestSha256: ev.manifestSha256,
						bytes: ev.bytes,
						shards: ev.shards,
					})
				}
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error)
				excludedRanges.push({
					signal,
					rangeStart,
					reason: `malformed generation prevents range collection: ${reason}`,
				})
				continue
			}
			// Partition: active (never deleted) vs superseded.
			const superseded = verified
				.filter((g) => g.generationId !== activeGenerationId)
				.sort((a, b) =>
					a.createdAt < b.createdAt
						? 1
						: a.createdAt > b.createdAt
							? -1
							: a.generationId < b.generationId
								? 1
								: -1,
				)
			for (const g of verified.filter((g) => g.generationId === activeGenerationId)) {
				retained.push({
					signal,
					rangeStart,
					generationId: g.generationId,
					createdAt: g.createdAt,
					reason: "active",
				})
			}
			// Keep newest N superseded; delete the older ones.
			const keepers = superseded.slice(0, keep)
			const targets = superseded.slice(keep)
			for (const g of keepers) {
				retained.push({
					signal,
					rangeStart,
					generationId: g.generationId,
					createdAt: g.createdAt,
					reason: "kept",
				})
			}
			for (const g of targets) {
				deleteSet.push({
					signal,
					rangeStart,
					generationId: g.generationId,
					createdAt: g.createdAt,
					manifestSha256: g.manifestSha256,
					bytes: g.bytes,
					shards: g.shards,
					// activeGenerationId is guaranteed non-null here: a missing
					// pointer excludes the whole range above (blocker 4).
					recordedActiveGenerationId: activeGenerationId as string,
					sourcePath: generationRoot(archiveDir, signal, rangeStart, g.generationId),
				})
				reclaimableBytes += g.bytes
			}
		}
	}
	return { archiveDir, keep, deleteSet, retained, excludedRanges, excludedSignals, reclaimableBytes }
}

/** Strictly read the active pointer; throws on a malformed/ambiguous pointer. */
const readActiveGenerationIdStrict = (
	archiveDir: string,
	signal: string,
	rangeDate: string,
): string | null => {
	const pointerPath = activePointerPath(archiveDir, signal, rangeDate)
	if (!existsSync(pointerPath)) return null
	assertNoSymlinkSync(archiveDir, pointerPath, "archive active pointer")
	assertRealFile(pointerPath, "archive active pointer")
	const raw = JSON.parse(readFileSync(pointerPath, "utf8")) as Record<string, unknown>
	if (
		raw.formatVersion !== 1 ||
		typeof raw.generationId !== "string" ||
		raw.signal !== signal ||
		raw.rangeStart !== rangeDate
	) {
		throw new Error(`malformed active pointer at ${pointerPath}`)
	}
	return raw.generationId
}

/** Deterministic tombstone path for a GC target beneath the operation dir. */
const tombstonePath = (
	archiveDir: string,
	operationId: string,
	target: GcTarget | GcDeleteCandidate,
): string => join(operationDir(archiveDir, operationId), "tombstones", target.generationId)

const revalidateSource = (archiveDir: string, target: GcTarget | GcDeleteCandidate): void => {
	const sourcePath = generationRoot(archiveDir, target.signal, target.rangeStart, target.generationId)
	if (!existsSync(sourcePath)) return // absent handled by topology switch
	assertNoSymlinkSync(archiveDir, sourcePath, "archive generation")
	const manifestPath = generationManifestPath(
		archiveDir,
		target.signal,
		target.rangeStart,
		target.generationId,
	)
	assertNoSymlinkSync(archiveDir, manifestPath, "archive generation manifest")
	assertRealFile(manifestPath, "archive generation manifest")
	const actualManifestSha = sha256File(manifestPath)
	if (actualManifestSha !== target.manifestSha256) {
		throw new Error(`archive gc target manifest changed after planning: ${sourcePath}`)
	}
	const manifest = readArchiveGenerationManifest(
		archiveDir,
		target.signal,
		target.rangeStart,
		target.generationId,
	)
	if (manifest.generationId !== target.generationId) {
		throw new Error(`archive gc target identity changed after planning: ${sourcePath}`)
	}
	for (const shardEv of target.shards) {
		const shardPath = join(sourcePath, "shards", shardEv.name)
		assertNoSymlinkSync(archiveDir, shardPath, `archive shard ${shardEv.name}`)
		assertRealFile(shardPath, `archive shard ${shardEv.name}`)
		const actualSha = sha256File(shardPath)
		if (actualSha !== shardEv.sha256) {
			throw new Error(`archive gc target shard ${shardEv.name} changed after planning: ${sourcePath}`)
		}
	}
}

const revalidatePointer = (archiveDir: string, target: GcTarget | GcDeleteCandidate): void => {
	// The pointer must STILL select the exact recorded active generation — not
	// merely "some generation other than the target." A pointer that came back
	// onto the target (re-selection) stops collection and preserves it.
	const current = readActiveGenerationIdStrict(archiveDir, target.signal, target.rangeStart)
	if (current !== target.recordedActiveGenerationId) {
		throw new Error(
			`archive gc pointer changed for ${target.signal}/${target.rangeStart}: ` +
				`recorded active ${target.recordedActiveGenerationId}, now ${current} (refusing to collect)`,
		)
	}
	if (current === target.generationId) {
		// The pointer now selects our target — it was re-selected. Preserve it.
		throw new Error(
			`archive gc target is now the active generation (re-selected): ${target.generationId}`,
		)
	}
}

/**
 * Run a GC operation under the maintenance lock. Apply mode: reconcile any prior
 * op, plan, journal the frozen set, collect via tombstone rename, rebuild
 * catalogs, prove terminal invariants, complete. Dry-run mode: take the lock for
 * a consistent view, plan, and return the plan WITHOUT any mutation — including
 * NO implicit reconciliation (a dry-run that reconciles would rename tombstones,
 * repair catalogs, release pins, and archive an op). If an active op prevents a
 * trustworthy GC plan, dry-run reports that blocker rather than predicting a
 * deletion set from unstable state.
 */
export const runArchiveGc = async (args: {
	readonly dataDir: string
	readonly archiveDir: string
	readonly scratchRoot: string
	readonly keep: number
	readonly dryRun: boolean
	readonly faults?: GcFaults
}): Promise<{ readonly plan: GcPlan; readonly deleted: ReadonlyArray<GcTarget> }> => {
	const { dataDir, archiveDir, scratchRoot, keep, dryRun } = args
	const operationId = cryptoRandomUuid()
	return withMaintenanceLock(dataDir, operationId, async () => {
		if (!dryRun) {
			// Reconcile any prior op first (create or gc) before planning new work.
			// DRY-RUN must NOT do this — it would mutate (blocker 3).
			const { reconcileArchiveGeneration } = await import("./generation")
			await reconcileArchiveGeneration(dataDir, archiveDir, scratchRoot)
		}
		const plan = planArchiveGc(archiveDir, keep)
		// If an active op is present, a dry-run cannot predict a trustworthy
		// deletion set from unstable state; report the blocker instead.
		const activePresent =
			existsSync(join(archiveDir, "operations", "active")) &&
			readdirSync(join(archiveDir, "operations", "active")).length > 0
		if (dryRun) {
			if (activePresent) {
				return {
					plan: {
						...plan,
						deleteSet: [],
						excludedSignals: [
							...plan.excludedSignals,
							{
								signal: "(active operation)",
								reason: "an active operation is present; reconcile before planning GC",
							},
						],
					},
					deleted: [],
				}
			}
			return { plan, deleted: [] }
		}
		if (plan.deleteSet.length === 0) return { plan, deleted: [] }
		const targets: GcTarget[] = plan.deleteSet.map((c) => ({
			signal: c.signal,
			rangeStart: c.rangeStart,
			generationId: c.generationId,
			createdAt: c.createdAt,
			manifestSha256: c.manifestSha256,
			bytes: c.bytes,
			shards: c.shards,
			recordedActiveGenerationId: c.recordedActiveGenerationId,
		}))
		await writeGcIntent({ archiveDir, operationId, dataDir, scratchRoot, keep, targets })
		await args.faults?.afterIntentDurable?.()
		const deleted = await collectTargets(archiveDir, operationId, targets, args.faults)
		// Recheck every affected pointer, rebuild affected catalogs, assert exact.
		await args.faults?.afterAllRemovals?.()
		const affectedSignals = new Set(targets.map((t) => t.signal))
		for (const signal of affectedSignals) {
			const sigName = archiveSignal(signal).name as ArchiveSignalName
			await rebuildCatalog(archiveDir, sigName)
			assertCatalogExact(archiveDir, sigName)
		}
		await args.faults?.afterCatalogRebuilt?.()
		// complete is written ONLY after every affected catalog is asserted exact.
		// Then the terminal invariant is proved before archival by re-reading the
		// durable record (a phase label is never proof — observe the reality).
		await persistGcProgress(archiveDir, operationId, targets.length, "complete")
		const completed = readActiveOperation(archiveDir, dataDir, scratchRoot)
		if (completed === null || completed.intent.kind !== "gc") {
			throw new Error("archive gc operation vanished after completion")
		}
		await verifyCompletedGcInvariants(archiveDir, completed.intent)
		await archiveCompletedOperation(archiveDir, operationId)
		return { plan, deleted }
	})
}

/**
 * Crash-safe collection via tombstone rename. For each target, revalidate source
 * + pointer, atomically rename source → tombstone, then remove only the
 * tombstone. Progress is persisted per target as the NONTERMINAL gc-collecting
 * phase (NEVER complete) so a crash here leaves the op resumable. `complete` is
 * written only by the caller after catalog rebuild + assert. Returns the
 * targets that completed (including those already done).
 */
const collectTargets = async (
	archiveDir: string,
	operationId: string,
	targets: ReadonlyArray<GcTarget>,
	faults?: GcFaults,
): Promise<GcTarget[]> => {
	const completed: GcTarget[] = []
	for (let i = 0; i < targets.length; i++) {
		const target = targets[i]!
		await collectOneTarget(archiveDir, operationId, target, faults)
		completed.push(target)
		// Persist the NONTERMINAL gc-collecting phase with the advanced cursor.
		// This is true for EVERY target including the final one — the legitimate
		// crash state after the final deletion but before catalog repair is
		// gc-collecting with a full cursor, NOT complete.
		await persistGcProgress(archiveDir, operationId, i + 1, "gc-collecting")
		// Awaited crash seam: fires after the durable progress write. For a
		// nonfinal target (index < total-1) this is the window where the old code
		// wrote a premature complete; a SIGKILL here must leave gc-collecting.
		await faults?.afterTargetProgress?.(i, targets.length)
	}
	return completed
}

const collectOneTarget = async (
	archiveDir: string,
	operationId: string,
	target: GcTarget,
	faults?: GcFaults,
): Promise<void> => {
	const sourcePath = generationRoot(archiveDir, target.signal, target.rangeStart, target.generationId)
	const tomb = tombstonePath(archiveDir, operationId, target)
	const sourceExists = existsSync(sourcePath)
	const tombExists = existsSync(tomb)
	if (sourceExists && tombExists) {
		// Both present — ambiguous topology; preserve everything.
		throw new Error(`archive gc target has both source and tombstone: ${target.generationId}`)
	}
	if (!sourceExists && !tombExists) {
		// Already completed (idempotent resume). Still CAS-check the pointer.
		revalidatePointer(archiveDir, target)
		return
	}
	if (!sourceExists && tombExists) {
		// Resume: source already renamed to tombstone; finish removing the tombstone.
		revalidatePointer(archiveDir, target)
		await removeTombstone(tomb)
		return
	}
	// sourceExists && !tombExists: revalidate source + pointer, then rename.
	revalidateSource(archiveDir, target)
	revalidatePointer(archiveDir, target)
	await ensurePrivateDirectory(dirname(tomb), archiveRoot(archiveDir))
	await assertNoSymlink(archiveDir, tomb, "archive gc tombstone")
	await durableRename(sourcePath, tomb)
	await syncDirectory(dirname(sourcePath))
	await syncDirectory(dirname(tomb))
	// Crash seam: AFTER the source→tombstone rename of the first target, BEFORE
	// tombstone removal. A SIGKILL here leaves source absent + tombstone present,
	// which reconcile resumes (the "during-removal" boundary).
	await faults?.afterFirstTargetRenamed?.()
	// Now the tombstone is the sole copy; remove only it.
	await removeTombstone(tomb)
}

const removeTombstone = async (tomb: string): Promise<void> => {
	// Containment: the tombstone must be a real directory (not a symlink).
	const info = await lstat(tomb)
	if (info.isSymbolicLink() || !info.isDirectory()) {
		throw new Error(`refusing to remove non-directory tombstone: ${tomb}`)
	}
	await rm(tomb, { recursive: true, force: true })
	await syncDirectory(dirname(tomb))
}

/**
 * Exported alias of {@link collectOneTarget} for the action-driven reconcile
 * executor (Gate 3b r4): the plan decides WHICH targets to collect; this helper
 * executes ONE target's topology switch (rename/remove/verify) with its source +
 * pointer precondition revalidation.
 */
export const collectOneTargetForReconcile = collectOneTarget

/**
 * Reconcile an interrupted GC operation. Drives the FROZEN target set to
 * completion idempotently — NEVER re-expands the set. A pointer change or source
 * divergence at any stage stops collection and preserves remaining state.
 *
 * State machine (the core fix for the premature-complete defect):
 * - `gc-collecting` (any cursor, including a full cursor after the final
 *   deletion but before catalog repair): resume collection from the cursor,
 *   collect the remainder, then rebuild + assert affected catalogs.
 * - `complete`: prove all terminal invariants (verifyCompletedGcInvariants),
 *   then retire the journal. A phase label is NEVER proof — observe the reality.
 */
export const reconcileGcOperation = async (
	dataDir: string,
	archiveDir: string,
	intent: GcOperationIntent,
): Promise<void> => {
	void dataDir
	if (intent.kind !== "gc") throw new Error(`reconcileGcOperation called on non-gc intent`)
	if (intent.phase === "complete") {
		// Terminal: prove invariants before archival. A failure preserves the
		// active journal (fail closed) — never blindly archives.
		await verifyCompletedGcInvariants(archiveDir, intent)
		await archiveCompletedOperation(archiveDir, intent.operationId)
		return
	}
	// gc-collecting (or intent, which is cursor 0): resume collection from the
	// recorded cursor. collectOneTarget is idempotent per target.
	for (let i = intent.completedTargets; i < intent.targets.length; i++) {
		const target = intent.targets[i]!
		await collectOneTarget(archiveDir, intent.operationId, target)
		await persistGcProgress(archiveDir, intent.operationId, i + 1, "gc-collecting")
	}
	// Recheck pointers + rebuild affected catalogs + assert exact.
	const affectedSignals = new Set(intent.targets.map((t) => t.signal))
	for (const signal of affectedSignals) {
		const sigName = archiveSignal(signal).name as ArchiveSignalName
		await rebuildCatalog(archiveDir, sigName)
		assertCatalogExact(archiveDir, sigName)
	}
	await persistGcProgress(archiveDir, intent.operationId, intent.targets.length, "complete")
	// Re-read the durable record to verify (a phase label is never proof; the
	// in-memory intent has the stale resume cursor, not the persisted full cursor).
	const retired = readActiveOperation(archiveDir, intent.dataDir, intent.scratchRoot)
	if (retired === null || retired.intent.kind !== "gc") {
		throw new Error("archive gc operation vanished after completion")
	}
	await verifyCompletedGcInvariants(archiveDir, retired.intent)
	await archiveCompletedOperation(archiveDir, intent.operationId)
}

/**
 * Prove a GC operation's terminal invariants before retiring its journal — a
 * phase label is never proof of durable reality (mirrors 3a's
 * verifyCompletedOperationInvariants). Verifies:
 * - completedTargets === targets.length;
 * - every frozen target's source is absent AND no operation tombstone holds data;
 * - every affected active pointer still equals its recorded CAS identity;
 * - every affected catalog is assertCatalogExact.
 * Any failure throws (the caller preserves the active journal; fail closed).
 */
export const verifyCompletedGcInvariants = async (
	archiveDir: string,
	intent: GcOperationIntent,
): Promise<void> => {
	if (intent.completedTargets !== intent.targets.length) {
		throw new Error(
			`archive gc operation complete requires completedTargets === targets.length (${intent.targets.length}), got ${intent.completedTargets}`,
		)
	}
	for (const target of intent.targets) {
		const sourcePath = generationRoot(archiveDir, target.signal, target.rangeStart, target.generationId)
		if (existsSync(sourcePath)) {
			throw new Error(`archive gc complete but target source still exists: ${sourcePath}`)
		}
		// No operation tombstone may hold a generation dir.
		const tomb = tombstonePath(archiveDir, intent.operationId, target)
		if (existsSync(tomb)) {
			throw new Error(`archive gc complete but tombstone still exists: ${tomb}`)
		}
	}
	// Every affected active pointer must still equal its recorded identity.
	for (const target of intent.targets) {
		const current = readActiveGenerationIdStrict(archiveDir, target.signal, target.rangeStart)
		if (current !== target.recordedActiveGenerationId) {
			throw new Error(
				`archive gc complete but active pointer changed for ${target.signal}/${target.rangeStart}: ` +
					`recorded ${target.recordedActiveGenerationId}, now ${current}`,
			)
		}
	}
	// Every affected catalog must be exact.
	const affectedSignals = new Set(intent.targets.map((t) => t.signal))
	for (const signal of affectedSignals) {
		const sigName = archiveSignal(signal).name as ArchiveSignalName
		assertCatalogExact(archiveDir, sigName)
	}
}

const cryptoRandomUuid = (): string => randomUUID()
