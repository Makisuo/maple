import { describe, it } from "@effect/vitest"
import { strictEqual } from "node:assert"
import { randomUUID } from "node:crypto"
import {
	decideReconciliation,
	digestOfIntent,
	type ReconciliationInspection,
	type ReconciliationSnapshot,
} from "../src/server/archives/reconcile"
import type { CreateOperationIntent, GcOperationIntent } from "../src/server/archives/journal"

// Exhaustive transition-table tests for the pure decision function (Gate 3b r5).
// These test the SOLE branch logic with NO I/O: every (kind, phase, topology)
// row maps to exactly one decision. The wiring commit will add integration tests
// proving CLI/create/GC route through this same function.

// Use the indexed-access type so we don't import ArchiveOperationPhase (which
// oxlint's no-unused-vars flags in type-only positions).
const createIntent = (phase: CreateOperationIntent["phase"]): CreateOperationIntent => {
	const gid = randomUUID()
	return {
		formatVersion: 3,
		kind: "create",
		operationId: randomUUID(),
		generationId: gid,
		signal: "traces",
		rangeStart: "2026-06-01",
		checkpointId: randomUUID(),
		archiveDir: "/archive",
		dataDir: "/data",
		scratchRoot: "/scratch",
		pinId: randomUUID(),
		pinPurpose: `archive:${gid}`,
		scratchSubdir: `archive-${randomUUID()}`,
		manifestSha256: null,
		baseActiveGenerationId: null,
		phase,
		createdAt: "2026-06-01T00:00:00.000Z",
		updatedAt: "2026-06-01T00:00:00.000Z",
	} as CreateOperationIntent
}

const gcIntent = (
	phase: "intent" | "gc-collecting" | "complete",
	completedTargets: number,
	targetCount: number,
): GcOperationIntent => {
	const targets = Array.from({ length: targetCount }, () => ({
		signal: "traces",
		rangeStart: "2026-06-01",
		generationId: randomUUID(),
		createdAt: "2026-06-02T00:00:00.000Z",
		manifestSha256: "b".repeat(64),
		bytes: 100,
		shards: [{ name: "00.parquet", bytes: 100, sha256: "c".repeat(64) }],
		recordedActiveGenerationId: randomUUID(),
	}))
	return {
		formatVersion: 3,
		kind: "gc",
		operationId: randomUUID(),
		keep: 0,
		targets,
		completedTargets,
		archiveDir: "/archive",
		dataDir: "/data",
		scratchRoot: "/scratch",
		phase,
		createdAt: "2026-06-01T00:00:00.000Z",
		updatedAt: "2026-06-01T00:00:00.000Z",
	} as GcOperationIntent
}

const createSnapshot = (
	intent: CreateOperationIntent,
	topology: {
		promoted?: boolean
		manifestAtFinal?: boolean
		buildingPresent?: boolean
		buildingAndFinalBothPresent?: boolean
		migrationRequired?: boolean
	},
): ReconciliationSnapshot => ({
	operationId: intent.operationId,
	journalDigest: digestOfIntent(intent),
	migrationRequired: topology.migrationRequired ?? false,
	intent,
	promoted: topology.promoted ?? false,
	manifestAtFinal: topology.manifestAtFinal ?? false,
	buildingPresent: topology.buildingPresent ?? false,
	buildingAndFinalBothPresent: topology.buildingAndFinalBothPresent ?? false,
	remainingTargets: 0,
	affectedSignals: [],
})

const gcSnapshot = (
	intent: GcOperationIntent,
	affectedSignals: string[] = ["traces"],
): ReconciliationSnapshot => ({
	operationId: intent.operationId,
	journalDigest: digestOfIntent(intent),
	migrationRequired: false,
	intent,
	promoted: false,
	manifestAtFinal: false,
	buildingPresent: false,
	buildingAndFinalBothPresent: false,
	remainingTargets: intent.targets.length - intent.completedTargets,
	affectedSignals,
})

const valid = (snapshot: ReconciliationSnapshot): ReconciliationInspection => ({
	kind: "ValidSnapshot",
	snapshot,
})
const failClosed = (reason: string): ReconciliationInspection => ({ kind: "FailClosed", reason })

describe("decideReconciliation — null and fail-closed inputs", () => {
	it("returns NoOp for null (no active operation)", () => {
		strictEqual(decideReconciliation(null).kind, "NoOp")
	})
	it("returns FailClosed for a FailClosed inspection (validation failure enters the same function)", () => {
		const d = decideReconciliation(failClosed("unsafe state: debris"))
		strictEqual(d.kind, "FailClosed")
		if (d.kind === "FailClosed") strictEqual(d.reason, "unsafe state: debris")
	})
})

describe("decideReconciliation — CREATE transition table", () => {
	it("phase >= complete → CreateVerifyComplete (verify-only, no repair)", () => {
		const intent = createIntent("complete")
		const d = decideReconciliation(
			valid(createSnapshot(intent, { promoted: true, manifestAtFinal: true })),
		)
		strictEqual(d.kind, "CreateVerifyComplete")
	})

	it("phase = scratch-removed (< complete) → CreateFinishPublication (NOT verify-only)", () => {
		const intent = createIntent("scratch-removed")
		// scratch-removed is BEFORE complete in PHASE_ORDER, so it is repair not verify-only.
		const d = decideReconciliation(
			valid(createSnapshot(intent, { promoted: true, manifestAtFinal: true })),
		)
		strictEqual(d.kind, "CreateFinishPublication")
	})

	it("!promoted → CreateAbortPrepublication (repair: quarantine + abort)", () => {
		const intent = createIntent("intent")
		const d = decideReconciliation(
			valid(createSnapshot(intent, { promoted: false, buildingPresent: true })),
		)
		strictEqual(d.kind, "CreateAbortPrepublication")
		if (d.kind === "CreateAbortPrepublication") strictEqual(d.buildingPresent, true)
	})

	it("!promoted with no building → CreateAbortPrepublication (buildingPresent=false)", () => {
		const intent = createIntent("restored")
		const d = decideReconciliation(
			valid(createSnapshot(intent, { promoted: false, buildingPresent: false })),
		)
		strictEqual(d.kind, "CreateAbortPrepublication")
		if (d.kind === "CreateAbortPrepublication") strictEqual(d.buildingPresent, false)
	})

	it("promoted (post-promotion) → CreateFinishPublication (repair: unconditional select + rebuild)", () => {
		const intent = createIntent("promoted")
		const d = decideReconciliation(
			valid(createSnapshot(intent, { promoted: true, manifestAtFinal: true })),
		)
		strictEqual(d.kind, "CreateFinishPublication")
	})

	it("promoted at pointer-complete → CreateFinishPublication (repair, NOT verify-only)", () => {
		const intent = createIntent("pointer-complete")
		const d = decideReconciliation(
			valid(createSnapshot(intent, { promoted: true, manifestAtFinal: true })),
		)
		strictEqual(d.kind, "CreateFinishPublication")
	})

	it("promoted at catalog-complete → CreateFinishPublication (repair, NOT verify-only)", () => {
		const intent = createIntent("catalog-complete")
		const d = decideReconciliation(
			valid(createSnapshot(intent, { promoted: true, manifestAtFinal: true })),
		)
		strictEqual(d.kind, "CreateFinishPublication")
	})
})

describe("decideReconciliation — CREATE impossible-topology FailClosed gates", () => {
	it("building && final both present → FailClosed", () => {
		const intent = createIntent("intent")
		const d = decideReconciliation(
			valid(
				createSnapshot(intent, {
					promoted: true,
					buildingPresent: true,
					manifestAtFinal: true,
					buildingAndFinalBothPresent: true,
				}),
			),
		)
		strictEqual(d.kind, "FailClosed")
	})

	it("promoted && !manifestAtFinal → FailClosed", () => {
		const intent = createIntent("promoted")
		const d = decideReconciliation(
			valid(createSnapshot(intent, { promoted: true, manifestAtFinal: false })),
		)
		strictEqual(d.kind, "FailClosed")
	})

	it("promoted && phase < manifest-written → FailClosed", () => {
		const intent = createIntent("shards-written")
		const d = decideReconciliation(
			valid(createSnapshot(intent, { promoted: true, manifestAtFinal: true })),
		)
		strictEqual(d.kind, "FailClosed")
	})

	it("phase >= promoted && !promoted → FailClosed (phase ahead of reality)", () => {
		const intent = createIntent("promoted")
		const d = decideReconciliation(valid(createSnapshot(intent, { promoted: false })))
		strictEqual(d.kind, "FailClosed")
	})

	it("aborted in active/ → FailClosed", () => {
		const intent = createIntent("aborted")
		const d = decideReconciliation(valid(createSnapshot(intent, { promoted: false })))
		strictEqual(d.kind, "FailClosed")
	})
})

describe("decideReconciliation — GC transition table", () => {
	it("phase = complete → GcVerifyComplete (verify-only, no repair)", () => {
		const intent = gcIntent("complete", 2, 2)
		const d = decideReconciliation(valid(gcSnapshot(intent)))
		strictEqual(d.kind, "GcVerifyComplete")
	})

	it("phase = gc-collecting → GcResume (repair)", () => {
		const intent = gcIntent("gc-collecting", 1, 2)
		const d = decideReconciliation(valid(gcSnapshot(intent)))
		strictEqual(d.kind, "GcResume")
		if (d.kind === "GcResume") {
			strictEqual(d.remainingTargets, 1)
			strictEqual(d.affectedSignals.length, 1)
		}
	})

	it("phase = intent (cursor 0) → GcResume", () => {
		const intent = gcIntent("intent", 0, 3)
		const d = decideReconciliation(valid(gcSnapshot(intent)))
		strictEqual(d.kind, "GcResume")
		if (d.kind === "GcResume") strictEqual(d.remainingTargets, 3)
	})

	it("multi-signal GC carries all affected signals", () => {
		const intent = gcIntent("gc-collecting", 0, 2)
		const d = decideReconciliation(valid(gcSnapshot(intent, ["traces", "logs"])))
		strictEqual(d.kind, "GcResume")
		if (d.kind === "GcResume") strictEqual(d.affectedSignals.length, 2)
	})
})

describe("decideReconciliation — V2 migration flag preserved", () => {
	it("a v2 snapshot (migrationRequired=true) preserves the flag in the decision", () => {
		const intent = createIntent("intent")
		const d = decideReconciliation(
			valid(createSnapshot(intent, { promoted: false, migrationRequired: true })),
		)
		strictEqual(d.kind, "CreateAbortPrepublication")
		if (d.kind === "CreateAbortPrepublication") strictEqual(d.migrationRequired, true)
	})

	it("a v2 snapshot at a non-intent phase preserves the phase exactly", () => {
		// A v2 record can hold any create-eligible phase; the lifted record's phase
		// selects the branch, not a hardcoded "intent".
		const intent = createIntent("promoted")
		const d = decideReconciliation(
			valid(createSnapshot(intent, { promoted: true, manifestAtFinal: true, migrationRequired: true })),
		)
		strictEqual(d.kind, "CreateFinishPublication")
		if (d.kind === "CreateFinishPublication") strictEqual(d.migrationRequired, true)
	})
})

describe("decideReconciliation — decision identities", () => {
	it("every valid decision carries operationId + journalDigest", () => {
		const intent = createIntent("promoted")
		const snap = createSnapshot(intent, { promoted: true, manifestAtFinal: true })
		const d = decideReconciliation(valid(snap))
		if (d.kind !== "NoOp" && d.kind !== "FailClosed") {
			strictEqual(d.operationId, intent.operationId)
			strictEqual(d.journalDigest, snap.journalDigest)
		}
	})
})
