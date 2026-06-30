// The single reconciliation decision engine (Gate 3b r5).
//
// ONE pure transition-table function (`decideReconciliation`) consumes a
// validated snapshot (or a fail-closed/no-op inspection result) and returns a
// `ReconciliationDecision`. Dry-run renders it; apply executes its branch via
// the proven mutation helpers. This pure function is the sole branch logic —
// there is no second `if phase...` implementation anywhere.
//
// Validation failures (root/pin/scratch/pointer-CAS/owned-path/identity) surface
// as FailClosed inspections that enter the SAME decision function, so every
// unsafe state is decided uniformly: fail-closed, zero mutation.

import {
	PHASE_ORDER,
	phaseAtLeast,
	type ArchiveOperationIntent,
	type CreateOperationIntent,
	type GcOperationIntent,
} from "./journal"

// ---------------------------------------------------------------------------
// Inspection result: the complete output of read-only validation.
// ---------------------------------------------------------------------------

/**
 * The read-only validation outcome. `inspectReconciliationState` returns one of:
 * - `null` — no active operation;
 * - `{ kind: "FailClosed", reason }` — unsafe/ambiguous state (the validation
 *   threw; nothing was mutated);
 * - `{ kind: "ValidSnapshot", snapshot }` — a fully validated snapshot.
 *
 * This is the sole input shape to `decideReconciliation`, so validation failures
 * enter the SAME decision function as valid state.
 */
export type ReconciliationInspection = null | FailClosedInspection | ValidSnapshotInspection

export interface FailClosedInspection {
	readonly kind: "FailClosed"
	readonly reason: string
}

export interface ValidSnapshotInspection {
	readonly kind: "ValidSnapshot"
	readonly snapshot: ReconciliationSnapshot
}

/**
 * A complete, read-only, validated snapshot of the active operation + topology.
 * Every field the pure decision function needs; nothing observed twice.
 *
 * The inspector (`inspectReconciliationState`, to be implemented in the wiring
 * commit) runs ALL read-only validation before producing this:
 * - guarded V2/V3 journal (no-symlink, real-file, directory/record binding);
 * - the lifted v3 record for v2 (preserving its EXACT phase/topology — a v2
 *   record can hold any create-eligible phase, not just "intent");
 * - `assertReconciliationRoots` (archive/data/scratch root safety);
 * - `validateReconciliationTopology` (building/final real non-symlink dirs, the
 *   both-present gate, owned-scratch safety);
 * - `validateOwnedPinState` (pin presence matches phase + identity);
 * - pointer/manifest/catalog observations;
 * - GC target/tombstone topology.
 * Any failure → FailClosed (zero mutation).
 */
export interface ReconciliationSnapshot {
	readonly operationId: string
	readonly journalDigest: string
	readonly migrationRequired: boolean
	/** The v3 intent selecting the branch (on-disk v3, or the lifted v2 record). */
	readonly intent: ArchiveOperationIntent
	// Create-kind topology (meaningful when intent.kind === "create"):
	readonly promoted: boolean
	readonly manifestAtFinal: boolean
	readonly buildingPresent: boolean
	/** building && finalGeneration both present — an impossible topology. */
	readonly buildingAndFinalBothPresent: boolean
	// GC-kind observations (meaningful when intent.kind === "gc"):
	readonly remainingTargets: number
	readonly affectedSignals: ReadonlyArray<string>
}

// ---------------------------------------------------------------------------
// Decision: the sole output of the pure transition table.
// ---------------------------------------------------------------------------

export type ReconciliationDecision =
	| { readonly kind: "NoOp" }
	| { readonly kind: "FailClosed"; readonly reason: string; readonly operationId?: string }
	| {
			readonly kind: "CreateVerifyComplete"
			readonly operationId: string
			readonly journalDigest: string
			readonly migrationRequired: boolean
			readonly intent: CreateOperationIntent
	  }
	| {
			readonly kind: "CreateAbortPrepublication"
			readonly operationId: string
			readonly journalDigest: string
			readonly migrationRequired: boolean
			readonly intent: CreateOperationIntent
			readonly buildingPresent: boolean
	  }
	| {
			readonly kind: "CreateFinishPublication"
			readonly operationId: string
			readonly journalDigest: string
			readonly migrationRequired: boolean
			readonly intent: CreateOperationIntent
			readonly affectedSignals: ReadonlyArray<string>
	  }
	| {
			readonly kind: "GcVerifyComplete"
			readonly operationId: string
			readonly journalDigest: string
			readonly migrationRequired: boolean
			readonly intent: GcOperationIntent
	  }
	| {
			readonly kind: "GcResume"
			readonly operationId: string
			readonly journalDigest: string
			readonly migrationRequired: boolean
			readonly intent: GcOperationIntent
			readonly remainingTargets: number
			readonly affectedSignals: ReadonlyArray<string>
	  }

/**
 * The ONE pure transition table. No I/O, no mutation. Consumes a
 * `ReconciliationInspection` (which already encodes no-op / fail-closed / valid)
 * and returns the exact decision branch.
 *
 * The impossible-topology gates (building+final both present, promoted without
 * manifest, final before manifest-written, phase≥promoted without final, aborted
 * in active) are decided HERE from the validated snapshot — they are the sole
 * branch logic, testable without I/O.
 */
export const decideReconciliation = (inspection: ReconciliationInspection): ReconciliationDecision => {
	if (inspection === null) return { kind: "NoOp" }
	if (inspection.kind === "FailClosed") {
		return { kind: "FailClosed", reason: inspection.reason }
	}
	const snapshot = inspection.snapshot
	const { intent } = snapshot

	if (intent.kind === "gc") {
		return decideGc(snapshot, intent)
	}
	return decideCreate(snapshot, intent)
}

const decideGc = (snapshot: ReconciliationSnapshot, intent: GcOperationIntent): ReconciliationDecision => {
	const { operationId, journalDigest, migrationRequired } = snapshot
	if (intent.phase === "complete") {
		return { kind: "GcVerifyComplete", operationId, journalDigest, migrationRequired, intent }
	}
	return {
		kind: "GcResume",
		operationId,
		journalDigest,
		migrationRequired,
		intent,
		remainingTargets: snapshot.remainingTargets,
		affectedSignals: snapshot.affectedSignals,
	}
}

const decideCreate = (
	snapshot: ReconciliationSnapshot,
	intent: CreateOperationIntent,
): ReconciliationDecision => {
	const phase = intent.phase
	const { operationId, journalDigest, migrationRequired } = snapshot

	// Impossible-topology gates — every one is FailClosed (zero mutation):
	// 1. building && finalGeneration both present.
	if (snapshot.buildingAndFinalBothPresent) {
		return {
			kind: "FailClosed",
			reason: "archive operation has both building and final generation state",
			operationId,
		}
	}
	// 2. promoted without a manifest at the final location.
	if (phase !== "aborted" && snapshot.promoted && !snapshot.manifestAtFinal) {
		return { kind: "FailClosed", reason: "published a generation without a manifest", operationId }
	}
	// 3. final generation exists before the manifest-written phase.
	if (snapshot.promoted && !phaseAtLeast(phase, "manifest-written") && phase !== "aborted") {
		return {
			kind: "FailClosed",
			reason: "final generation exists before manifest-written phase",
			operationId,
		}
	}
	// 4. phase >= promoted but no final generation (phase ahead of reality).
	if (!snapshot.promoted && phaseAtLeast(phase, "promoted") && phase !== "aborted") {
		return { kind: "FailClosed", reason: `phase ${phase} requires its final generation`, operationId }
	}
	// 5. aborted operation still in the active directory.
	if (phase === "aborted") {
		return { kind: "FailClosed", reason: "aborted operation still in active dir", operationId }
	}

	// Terminal verify-only: phase >= complete.
	if (phaseAtLeast(phase, "complete")) {
		return { kind: "CreateVerifyComplete", operationId, journalDigest, migrationRequired, intent }
	}

	// Pre-publication abort: not promoted.
	if (!snapshot.promoted) {
		return {
			kind: "CreateAbortPrepublication",
			operationId,
			journalDigest,
			migrationRequired,
			intent,
			buildingPresent: snapshot.buildingPresent,
		}
	}

	// Post-promotion repair: promoted (always re-select pointer + rebuild catalog).
	return {
		kind: "CreateFinishPublication",
		operationId,
		journalDigest,
		migrationRequired,
		intent,
		affectedSignals: [intent.signal],
	}
}

/** Helper for tests/snapshot builders: derive the journal digest of an intent. */
export const digestOfIntent = (intent: ArchiveOperationIntent): string => {
	const c = require("node:crypto") as typeof import("node:crypto")
	return c.createHash("sha256").update(JSON.stringify(intent)).digest("hex")
}

void PHASE_ORDER
