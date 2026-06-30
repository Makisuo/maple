import { describe, it } from "@effect/vitest"
import { ok, rejects, strictEqual } from "node:assert"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
	acquireCheckpointPin,
	checkpointPinsRoot,
	checkpointRoot,
	checkpointSnapshotDir,
	checkpointStatePath,
	newCheckpointId,
	releaseCheckpointPin,
	retireCheckpointIfEligible,
	readCheckpointState,
	withMaintenanceLock,
} from "../src/server/checkpoints"
import { SCHEMA_FINGERPRINT } from "../src/server/serve"
import { CHDB_VERSION, MAPLE_VERSION } from "../src/version"

// Pin and maintenance-lock API for the dependent archive branch. These tests
// mirror the checkpoint suite's conventions: a throwaway parent/data dir,
// hand-built fixtures (no real chDB), node:assert, and fail-closed assertions
// proving uncertain state is preserved rather than deleted.
const withDataDir = async (run: (dataDir: string) => Promise<void> | void): Promise<void> => {
	const parent = mkdtempSync(join(tmpdir(), "maple-archive-pin-test-"))
	const dataDir = join(parent, "data")
	mkdirSync(dataDir, { recursive: true })
	try {
		await run(dataDir)
	} finally {
		rmSync(parent, { recursive: true, force: true })
	}
}

const manifest = (checkpointId: string, sourceDataDir: string) => ({
	formatVersion: 1 as const,
	checkpointId,
	operationId: newCheckpointId(),
	mapleVersion: MAPLE_VERSION,
	chdbVersion: CHDB_VERSION,
	schemaFingerprint: SCHEMA_FINGERPRINT,
	createdAt: new Date().toISOString(),
	sourceDataDir,
	backupRelativePath: `snapshots/${checkpointId}/backup`,
	backupBytes: 6,
	validation: {
		validatedAt: new Date().toISOString(),
		traces: 0,
		logs: 0,
		metricsSum: 0,
		metricsGauge: 0,
		metricsHistogram: 0,
		metricsExponentialHistogram: 0,
		materializedViews: 0,
	},
})

const writeSnapshot = (dataDir: string, checkpointId: string): void => {
	const snapshot = checkpointSnapshotDir(dataDir, checkpointId)
	mkdirSync(join(snapshot, "backup"), { recursive: true })
	writeFileSync(join(snapshot, "backup", "data.bin"), "backup")
	writeFileSync(join(snapshot, "manifest.json"), `${JSON.stringify(manifest(checkpointId, dataDir))}\n`)
}

const writeState = (dataDir: string, current: string, previous: string | null = null): void => {
	mkdirSync(checkpointRoot(dataDir), { recursive: true })
	writeFileSync(
		checkpointStatePath(dataDir),
		`${JSON.stringify({
			formatVersion: 1,
			revision: newCheckpointId(),
			current,
			previous,
			committedAt: "2026-01-01T00:00:02.000Z",
		})}\n`,
	)
}

describe("checkpoint pin API", () => {
	it("acquires a persistent pin that prevents retirement and resolves by exact identity", async () => {
		await withDataDir(async (dataDir) => {
			const checkpointId = newCheckpointId()
			writeSnapshot(dataDir, checkpointId)
			writeState(dataDir, checkpointId)
			const pinPath = await acquireCheckpointPin(dataDir, checkpointId, "archive")
			ok(existsSync(pinPath), "pin file written")
			const parsed = JSON.parse(readFileSync(pinPath, "utf8")) as {
				checkpointId: string
				purpose: string
				pinId: string
			}
			strictEqual(parsed.checkpointId, checkpointId)
			strictEqual(parsed.purpose, "archive")
			ok(parsed.pinId.length > 0)
			strictEqual(readdirSync(join(checkpointPinsRoot(dataDir), checkpointId)).length, 1)
		})
	})

	it("a pinned unreferenced snapshot is retained by retirement", async () => {
		await withDataDir(async (dataDir) => {
			const current = newCheckpointId()
			const old = newCheckpointId()
			writeSnapshot(dataDir, current)
			writeSnapshot(dataDir, old)
			writeState(dataDir, current, old)
			const state = await readCheckpointState(dataDir)
			await acquireCheckpointPin(dataDir, old)
			// old is neither current nor previous-resolvable-after-promotion; with a
			// pin it must survive retirement.
			const retired = await retireCheckpointIfEligible(dataDir, old, state)
			strictEqual(retired, null, "pinned snapshot not retired")
			ok(existsSync(checkpointSnapshotDir(dataDir, old)), "pinned snapshot retained")
		})
	})

	it("releases an owned pin and removes only that pin file", async () => {
		await withDataDir(async (dataDir) => {
			const checkpointId = newCheckpointId()
			writeSnapshot(dataDir, checkpointId)
			writeState(dataDir, checkpointId)
			const pinPath = await acquireCheckpointPin(dataDir, checkpointId)
			await releaseCheckpointPin(dataDir, checkpointId, pinPath)
			ok(!existsSync(pinPath), "pin file removed")
		})
	})

	it("preserves an owned pin when its purpose does not match the journal expectation", async () => {
		await withDataDir(async (dataDir) => {
			const checkpointId = newCheckpointId()
			writeSnapshot(dataDir, checkpointId)
			writeState(dataDir, checkpointId)
			const pinPath = await acquireCheckpointPin(dataDir, checkpointId, "archive:generation-a")
			await rejects(
				releaseCheckpointPin(dataDir, checkpointId, pinPath, "archive:generation-b"),
				/identity mismatch/,
			)
			ok(existsSync(pinPath), "purpose-mismatched pin preserved")
		})
	})

	it("fails closed and preserves a pin whose recorded identity does not match", async () => {
		await withDataDir(async (dataDir) => {
			const checkpointId = newCheckpointId()
			const other = newCheckpointId()
			writeSnapshot(dataDir, checkpointId)
			writeSnapshot(dataDir, other)
			writeState(dataDir, checkpointId, other)
			// A pin file physically under `checkpointId`'s pin dir, but whose recorded
			// checkpointId is `other`. Releasing it as `checkpointId` must refuse.
			const pinDir = join(checkpointPinsRoot(dataDir), checkpointId)
			mkdirSync(pinDir, { recursive: true })
			const bogusPinPath = join(pinDir, `${newCheckpointId()}.json`)
			writeFileSync(
				bogusPinPath,
				`${JSON.stringify({
					formatVersion: 1,
					pinId: newCheckpointId(),
					checkpointId: other,
					purpose: "archive",
					createdAt: new Date().toISOString(),
				})}\n`,
			)
			await rejects(releaseCheckpointPin(dataDir, checkpointId, bogusPinPath), /identity mismatch/)
			ok(existsSync(bogusPinPath), "mismatched pin preserved")
		})
	})

	it("fails closed when releasing an already-absent pin", async () => {
		await withDataDir(async (dataDir) => {
			const checkpointId = newCheckpointId()
			writeSnapshot(dataDir, checkpointId)
			writeState(dataDir, checkpointId)
			const pinPath = await acquireCheckpointPin(dataDir, checkpointId)
			await releaseCheckpointPin(dataDir, checkpointId, pinPath)
			await rejects(releaseCheckpointPin(dataDir, checkpointId, pinPath), /not found/)
		})
	})

	it("refuses to pin a checkpoint that is not selected", async () => {
		await withDataDir(async (dataDir) => {
			const missing = newCheckpointId()
			writeSnapshot(dataDir, missing)
			// No state.json selecting `missing` -> resolveCheckpoint fails closed.
			await rejects(acquireCheckpointPin(dataDir, missing), /state not found|refusing to infer/)
		})
	})

	it("rejects an invalid pin purpose", async () => {
		await withDataDir(async (dataDir) => {
			const checkpointId = newCheckpointId()
			writeSnapshot(dataDir, checkpointId)
			writeState(dataDir, checkpointId)
			await rejects(acquireCheckpointPin(dataDir, checkpointId, "bad;purpose"), /purpose/)
		})
	})

	it("refuses a pin path that escapes the checkpoint pin directory", async () => {
		await withDataDir(async (dataDir) => {
			const checkpointId = newCheckpointId()
			writeSnapshot(dataDir, checkpointId)
			writeState(dataDir, checkpointId)
			await acquireCheckpointPin(dataDir, checkpointId)
			await rejects(releaseCheckpointPin(dataDir, checkpointId, "/tmp/escape.json"), /pin directory/)
		})
	})

	it("rejects a symlinked pin reservation without touching the target", async () => {
		await withDataDir(async (dataDir) => {
			const checkpointId = newCheckpointId()
			writeSnapshot(dataDir, checkpointId)
			writeState(dataDir, checkpointId)
			const outside = join(dirname(dataDir), "outside-pin-target")
			mkdirSync(outside, { recursive: true })
			writeFileSync(join(outside, "sensitive"), "preserve")
			// Point the pin reservation dir at an outside target.
			mkdirSync(checkpointPinsRoot(dataDir), { recursive: true })
			symlinkSync(outside, join(checkpointPinsRoot(dataDir), checkpointId))
			await rejects(acquireCheckpointPin(dataDir, checkpointId), /symlink/)
			// The outside target is untouched.
			strictEqual(readFileSync(join(outside, "sensitive"), "utf8"), "preserve")
		})
	})
})

describe("maintenance lock", () => {
	it("runs the task and releases the lock on success", async () => {
		await withDataDir(async (dataDir) => {
			const result = await withMaintenanceLock(dataDir, newCheckpointId(), async () => "done")
			strictEqual(result, "done")
			ok(!existsSync(`${dataDir}.maple-maintenance-lock`), "maintenance lock released")
		})
	})

	it("releases the lock even when the task throws", async () => {
		await withDataDir(async (dataDir) => {
			await rejects(
				withMaintenanceLock(dataDir, newCheckpointId(), async () => {
					throw new Error("boom")
				}),
				/boom/,
			)
			ok(!existsSync(`${dataDir}.maple-maintenance-lock`), "maintenance lock released after failure")
		})
	})

	it("rejects a concurrent owner while the lock is held", async () => {
		await withDataDir(async (dataDir) => {
			// Acquire the lock directly and hold it across the second attempt.
			const firstOperation = newCheckpointId()
			const held = await withMaintenanceLock(dataDir, firstOperation, async () => {
				// While this call holds the lock, a second acquirer must be refused.
				// The first owner's PID is this process (alive), so the refusal is
				// "another Maple maintenance operation is active".
				await rejects(
					withMaintenanceLock(dataDir, newCheckpointId(), async () => "nope"),
					/active/,
				)
			})
			await held
			ok(!existsSync(`${dataDir}.maple-maintenance-lock`), "lock released after nested refusal")
		})
	})
})
