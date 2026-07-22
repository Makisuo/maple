// Reconciliation-only worker for the archive generation lifecycle (Gate 3).
//
// Invokes reconcileArchiveGeneration WITHOUT starting a new export. This models
// the pure crash-recovery path: after a crash, an operator (or the next
// operation's preamble) reconciles the interrupted operation to its exact
// intended state, then a SEPARATE later operation may proceed. Used by the
// native crash-recovery harness to verify recovery independently of a fresh
// export.
//
// Usage:
//   MAPLE_LIBCHDB=<bundle>/libchdb.so \
//   bun apps/cli/test/probes/archive-reconcile-worker.ts \
//     --data-dir <d> --archive-dir <a>
//
// Exit semantics:
//   0 = reconciliation converged (or no active operation existed)
//   1 = reconciliation threw (ambiguous/corrupt state — surfaced to the harness)

import { randomUUID } from "node:crypto"
import { withMaintenanceLock } from "../../src/server/checkpoints"
import { reconcileArchiveGeneration } from "../../src/server/archives/generation"

const get = (name: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	const v = i >= 0 ? process.argv[i + 1] : undefined
	if (!v) {
		console.error(`reconcile-worker: missing --${name}`)
		process.exit(2)
	}
	return v
}

const dataDir = get("data-dir")
const archiveDir = get("archive-dir")
const scratchRoot = get("scratch-root")

withMaintenanceLock(dataDir, randomUUID(), () => reconcileArchiveGeneration(dataDir, archiveDir, scratchRoot))
	.then(() => {
		console.log("reconcile: converged")
		process.exit(0)
	})
	.catch((error) => {
		const msg = error instanceof Error ? error.message : String(error)
		console.error(`reconcile: FAILED ${msg}`)
		process.exit(1)
	})
