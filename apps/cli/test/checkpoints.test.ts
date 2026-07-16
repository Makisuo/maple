import { describe, it } from "@effect/vitest"
import { Effect, Exit, Option } from "effect"
import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert"
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import {
	assertCheckpointRootSafe,
	type CheckpointId,
	type CheckpointOperationId,
	type CheckpointQuarantineId,
	checkpointRoot,
	checkpointSnapshotDir,
	checkpointStatePath,
	isMissingBackupConfigurationError,
	LocalQueryError,
	newCheckpointId,
	newCheckpointOperationId,
	newCheckpointQuarantineId,
	parseCheckpointManifest,
	parseCheckpointState,
	readCheckpointState,
	reconcileCheckpointRecovery,
	reconcileCheckpointOperations,
	resetTransactionPath,
	resetLiveStorePreservingCheckpoints,
	type RestoreRecoveryFaults,
	resolveCheckpoint,
	restoreDataPath,
	restoreQuarantinePath,
	restoreRootPath,
	restoreTransactionPath,
	retireCheckpointIfEligible,
	validateCheckpointDataDir,
	writeBackupConfig,
} from "../src/server/checkpoints"
import {
	durableWrite,
	isUnsupportedDirectorySyncError,
	syncDirectory,
	syncTree,
} from "../src/server/durable-files"
import { SCHEMA_FINGERPRINT } from "../src/server/serve"
import { storeMarkerPath, storeOpenMarkerPath } from "../src/server/store-version"
import { CHDB_VERSION, MAPLE_VERSION } from "../src/version"

const withDataDir = async (run: (dataDir: string) => Promise<void> | void): Promise<void> => {
	const parent = mkdtempSync(join(tmpdir(), "maple-checkpoint-test-"))
	const dataDir = join(parent, "data")
	mkdirSync(dataDir, { recursive: true })
	try {
		await run(dataDir)
	} finally {
		rmSync(parent, { recursive: true, force: true })
	}
}

const manifest = (
	checkpointId: CheckpointId,
	operationId = newCheckpointOperationId(),
	sourceDataDir = "/tmp/maple-data",
): Record<string, unknown> => ({
	formatVersion: 1,
	checkpointId,
	operationId,
	mapleVersion: MAPLE_VERSION,
	chdbVersion: CHDB_VERSION,
	schemaFingerprint: SCHEMA_FINGERPRINT,
	createdAt: "2026-01-01T00:00:00.000Z",
	sourceDataDir,
	backupRelativePath: `snapshots/${checkpointId}/backup`,
	backupBytes: 123,
	validation: {
		validatedAt: "2026-01-01T00:00:01.000Z",
		traces: 1,
		logs: 2,
		metricsSum: 3,
		metricsGauge: 4,
		metricsHistogram: 5,
		metricsExponentialHistogram: 6,
		materializedViews: 33,
	},
})

describe("fresh-process checkpoint reopen probe", () => {
	it("rejects a non-normalized or relative data directory before opening chDB", () => {
		throws(() => validateCheckpointDataDir("relative/data"), /normalized absolute data directory/)
	})
})

const writeSnapshot = (
	dataDir: string,
	checkpointId: CheckpointId,
	operationId = newCheckpointOperationId(),
): void => {
	const snapshot = checkpointSnapshotDir(dataDir, checkpointId)
	mkdirSync(join(snapshot, "backup"), { recursive: true })
	writeFileSync(join(snapshot, "backup", "data.bin"), "backup")
	const value = manifest(checkpointId, operationId, dataDir)
	value.backupBytes = 6
	writeFileSync(join(snapshot, "manifest.json"), `${JSON.stringify(value)}\n`)
}

const writeState = (
	dataDir: string,
	current: CheckpointId,
	previous: CheckpointId | null = null,
	revision = newCheckpointOperationId(),
): void => {
	mkdirSync(checkpointRoot(dataDir), { recursive: true })
	writeFileSync(
		checkpointStatePath(dataDir),
		`${JSON.stringify({
			formatVersion: 1,
			revision,
			current,
			previous,
			committedAt: "2026-01-01T00:00:02.000Z",
		})}\n`,
	)
}

const writeCheckpointOperation = (
	dataDir: string,
	operationId: CheckpointOperationId,
	checkpointId: CheckpointId,
	phase: "intent" | "backup-complete" | "manifest-complete" | "pointer-complete" | "retention-complete",
	base: {
		readonly revision: CheckpointOperationId | null
		readonly current: CheckpointId | null
		readonly previous: CheckpointId | null
	} = { revision: null, current: null, previous: null },
): string => {
	const dir = join(checkpointRoot(dataDir), "operations", `checkpoint-${operationId}`)
	mkdirSync(dir, { recursive: true })
	writeFileSync(
		join(dir, "intent.json"),
		`${JSON.stringify({
			formatVersion: 1,
			operationId,
			checkpointId,
			baseRevision: base.revision,
			baseCurrent: base.current,
			basePrevious: base.previous,
			phase,
			startedAt: "2026-01-01T00:00:00.000Z",
		})}\n`,
	)
	return dir
}

const restoreValidation = {
	validatedAt: "2026-01-01T00:00:01.000Z",
	traces: 1,
	logs: 2,
	metricsSum: 3,
	metricsGauge: 4,
	metricsHistogram: 5,
	metricsExponentialHistogram: 6,
	materializedViews: 33,
}

const writeRestoreTransaction = (
	dataDir: string,
	operationId: CheckpointOperationId,
	checkpointId: CheckpointId,
	quarantineId: CheckpointQuarantineId,
	phase: "intent" | "restore-ready" | "old-quarantined" | "new-live" | "markers-committed",
): void => {
	writeFileSync(
		restoreTransactionPath(dataDir),
		`${JSON.stringify({
			formatVersion: 1,
			operationId,
			checkpointId,
			quarantineId,
			phase,
			createdAt: "2026-01-01T00:00:00.000Z",
			validation: phase === "intent" ? null : restoreValidation,
		})}\n`,
	)
}

const writeRestoreReady = (
	dataDir: string,
	operationId: CheckpointOperationId,
	checkpointId: CheckpointId,
): void => {
	const restoreData = restoreDataPath(dataDir, operationId)
	mkdirSync(restoreData, { recursive: true })
	writeFileSync(
		join(restoreData, ".maple-restore-ready.json"),
		`${JSON.stringify({ formatVersion: 1, operationId, checkpointId })}\n`,
	)
}

describe("writeBackupConfig", () => {
	it("writes restrictive runtime and escaped restore configurations", async () => {
		await withDataDir((dataDir) => {
			const runtimePath = join(dataDir, "runtime.xml")
			writeBackupConfig(runtimePath)
			const runtime = readFileSync(runtimePath, "utf8")
			ok(runtime.includes("<allowed_disk>default</allowed_disk>"))
			ok(runtime.includes("<allowed_path>backups</allowed_path>"))
			strictEqual(lstatSync(runtimePath).mode & 0o777, 0o600)

			const restorePath = join(dataDir, "restore.xml")
			writeBackupConfig(restorePath, join(dataDir, "source & <store>"))
			const restore = readFileSync(restorePath, "utf8")
			ok(restore.includes("<allowed_disk>src</allowed_disk>"))
			ok(restore.includes("source &amp; &lt;store&gt;"))
		})
	})
})

describe("checkpoint IDs and strict parsers", () => {
	it("generates collision-resistant UUIDs", () => {
		const ids = new Set(Array.from({ length: 2_000 }, () => newCheckpointId()))
		strictEqual(ids.size, 2_000)
		for (const id of ids) match(id, /^[0-9a-f-]{36}$/)
	})

	it("accepts a complete manifest and rejects ID, path, compatibility, and count corruption", () => {
		const id = newCheckpointId()
		strictEqual(parseCheckpointManifest(manifest(id), id).checkpointId, id)
		strictEqual(parseCheckpointManifest(manifest(id), id, "/tmp/maple-data").checkpointId, id)
		throwsMessage(
			() => parseCheckpointManifest(manifest(id), id, "/tmp/different-owner"),
			/configured owner/,
		)
		const wrong = newCheckpointId()
		ok(wrong !== id)
		throwsMessage(() => parseCheckpointManifest(manifest(id), wrong), /does not match/)
		throwsMessage(
			() => parseCheckpointManifest({ ...manifest(id), backupRelativePath: "../escape" }, id),
			/backup path/,
		)
		throwsMessage(
			() => parseCheckpointManifest({ ...manifest(id), chdbVersion: "v0.0.0" }, id),
			/version mismatch/,
		)
		throwsMessage(
			() =>
				parseCheckpointManifest({
					...manifest(id),
					validation: { ...(manifest(id).validation as object), logs: -1 },
				}),
			/validation.*logs|greater than or equal to 0/s,
		)
	})

	it("accepts versioned current/previous state and rejects malformed selection", () => {
		const current = newCheckpointId()
		const previous = newCheckpointId()
		const revision = newCheckpointOperationId()
		deepStrictEqual(
			parseCheckpointState({
				formatVersion: 1,
				revision,
				current,
				previous,
				committedAt: "2026-01-01T00:00:00.000Z",
			}),
			{
				formatVersion: 1,
				revision,
				current,
				previous,
				committedAt: "2026-01-01T00:00:00.000Z",
			},
		)
		throwsMessage(
			() =>
				parseCheckpointState({
					formatVersion: 1,
					revision,
					current,
					previous: current,
					committedAt: "2026-01-01T00:00:00.000Z",
				}),
			/must differ/,
		)
		throwsMessage(
			() =>
				parseCheckpointState({
					formatVersion: 99,
					revision,
					current,
					previous: null,
					committedAt: "2026-01-01T00:00:00.000Z",
				}),
			/unsupported/,
		)
	})
})

describe("checkpoint state resolution", () => {
	it("resolves immutable current, previous, and explicit IDs", async () => {
		await withDataDir(async (dataDir) => {
			const current = newCheckpointId()
			const previous = newCheckpointId()
			writeSnapshot(dataDir, current)
			writeSnapshot(dataDir, previous)
			writeState(dataDir, current, previous)

			const state = await readCheckpointState(dataDir)
			strictEqual(state.current, current)
			strictEqual((await resolveCheckpoint(dataDir, "current")).checkpointId, current)
			strictEqual((await resolveCheckpoint(dataDir, "previous")).checkpointId, previous)
			strictEqual((await resolveCheckpoint(dataDir, previous)).checkpointId, previous)
		})
	})

	it("fails closed for missing/malformed state, incomplete snapshots, and legacy aliases", async () => {
		await withDataDir(async (dataDir) => {
			await rejects(readCheckpointState(dataDir), /state not found/)

			mkdirSync(join(checkpointRoot(dataDir), "snapshots", newCheckpointId()), {
				recursive: true,
			})
			await rejects(readCheckpointState(dataDir), /state missing while checkpoint data exists/)

			writeFileSync(checkpointStatePath(dataDir), "{bad json")
			await rejects(readCheckpointState(dataDir), /JSON/)

			rmSync(checkpointRoot(dataDir), { recursive: true })
			mkdirSync(join(checkpointRoot(dataDir), "current"), { recursive: true })
			await rejects(readCheckpointState(dataDir), /legacy preview/)
		})
	})

	it("rejects symlink roots and symlinked snapshot paths", async () => {
		await withDataDir(async (dataDir) => {
			const outside = join(dirname(dataDir), "outside")
			mkdirSync(outside)
			symlinkSync(outside, checkpointRoot(dataDir))
			throwsMessage(() => assertCheckpointRootSafe(dataDir), /symlink/)
		})
	})

	it("rejects symlinked manifest and backup leaves outside the registry", async () => {
		await withDataDir(async (dataDir) => {
			const checkpointId = newCheckpointId()
			const snapshot = checkpointSnapshotDir(dataDir, checkpointId)
			const outside = join(dirname(dataDir), "outside-checkpoint")
			mkdirSync(outside)
			writeFileSync(
				join(outside, "manifest.json"),
				`${JSON.stringify(manifest(checkpointId, newCheckpointId(), dataDir))}\n`,
			)
			mkdirSync(join(outside, "backup"))
			mkdirSync(snapshot, { recursive: true })
			symlinkSync(join(outside, "manifest.json"), join(snapshot, "manifest.json"))
			symlinkSync(join(outside, "backup"), join(snapshot, "backup"))
			writeState(dataDir, checkpointId)

			await rejects(readCheckpointState(dataDir), /symlink/)
			ok(existsSync(join(outside, "manifest.json")))
			ok(existsSync(join(outside, "backup")))
		})
	})

	it("rejects nested symlinks inside an otherwise real checkpoint backup", async () => {
		await withDataDir(async (dataDir) => {
			const checkpointId = newCheckpointId()
			const outside = join(dirname(dataDir), "outside-backup.bin")
			writeFileSync(outside, "sensitive")
			writeSnapshot(dataDir, checkpointId)
			symlinkSync(outside, join(checkpointSnapshotDir(dataDir, checkpointId), "backup", "nested-link"))
			writeState(dataDir, checkpointId)

			await rejects(readCheckpointState(dataDir), /symlink/)
			strictEqual(readFileSync(outside, "utf8"), "sensitive")
		})
	})
})

describe("checkpoint reconciliation and retention", () => {
	it("quarantines only an exactly owned incomplete operation and preserves its bytes", async () => {
		await withDataDir(async (dataDir) => {
			const operationId = newCheckpointOperationId()
			const checkpointId = newCheckpointId()
			const snapshot = checkpointSnapshotDir(dataDir, checkpointId)
			mkdirSync(join(snapshot, "backup"), { recursive: true })
			writeFileSync(join(snapshot, "backup", "partial.bin"), "partial")
			writeCheckpointOperation(dataDir, operationId, checkpointId, "backup-complete")

			await reconcileCheckpointOperations(dataDir)

			ok(!existsSync(snapshot))
			const quarantineRoot = join(checkpointRoot(dataDir), "quarantine")
			const quarantines = readdirSync(quarantineRoot)
			strictEqual(quarantines.length, 1)
			ok(
				existsSync(
					join(quarantineRoot, quarantines[0]!, "incomplete-snapshot", "backup", "partial.bin"),
				),
			)
			ok(existsSync(join(quarantineRoot, quarantines[0]!, "operation", "intent.json")))
		})
	})

	it("fails closed and preserves a malformed operation", async () => {
		await withDataDir(async (dataDir) => {
			const operationDir = join(checkpointRoot(dataDir), "operations", "checkpoint-not-a-uuid")
			mkdirSync(operationDir, { recursive: true })
			writeFileSync(join(operationDir, "intent.json"), "{bad json")
			await rejects(reconcileCheckpointOperations(dataDir))
			ok(existsSync(join(operationDir, "intent.json")))
		})
	})

	it("rejects a symlinked operations root without touching its target", async () => {
		await withDataDir(async (dataDir) => {
			const outside = join(dirname(dataDir), "outside-operations")
			const sentinel = join(outside, "sentinel")
			mkdirSync(outside)
			writeFileSync(sentinel, "preserve")
			mkdirSync(checkpointRoot(dataDir), { recursive: true })
			symlinkSync(outside, join(checkpointRoot(dataDir), "operations"))

			await rejects(reconcileCheckpointOperations(dataDir), /real directory|symlink/)
			strictEqual(readFileSync(sentinel, "utf8"), "preserve")
		})
	})

	it("rejects mismatched operation directory and intent identities without mutation", async () => {
		await withDataDir(async (dataDir) => {
			const directoryId = newCheckpointOperationId()
			const intentId = newCheckpointOperationId()
			const checkpointId = newCheckpointId()
			const directory = writeCheckpointOperation(dataDir, directoryId, checkpointId, "backup-complete")
			const intent = JSON.parse(readFileSync(join(directory, "intent.json"), "utf8"))
			intent.operationId = intentId
			writeFileSync(join(directory, "intent.json"), `${JSON.stringify(intent)}\n`)

			await rejects(reconcileCheckpointOperations(dataDir), /identity mismatch/)
			ok(existsSync(join(directory, "intent.json")))
		})
	})

	it("publishes a completed first checkpoint after an interrupted pointer update", async () => {
		await withDataDir(async (dataDir) => {
			const operationId = newCheckpointOperationId()
			const checkpointId = newCheckpointId()
			writeSnapshot(dataDir, checkpointId, operationId)
			writeCheckpointOperation(dataDir, operationId, checkpointId, "manifest-complete")

			await reconcileCheckpointOperations(dataDir)

			const state = await readCheckpointState(dataDir)
			strictEqual(state.revision, operationId)
			strictEqual(state.current, checkpointId)
			strictEqual(state.previous, null)
			ok(!existsSync(join(checkpointRoot(dataDir), "operations", `checkpoint-${operationId}`)))
		})
	})

	it("resumes a based promotion and retires only the superseded previous checkpoint", async () => {
		await withDataDir(async (dataDir) => {
			const oldCurrent = newCheckpointId()
			const oldPrevious = newCheckpointId()
			const baseRevision = newCheckpointOperationId()
			writeSnapshot(dataDir, oldCurrent)
			writeSnapshot(dataDir, oldPrevious)
			writeState(dataDir, oldCurrent, oldPrevious, baseRevision)

			const operationId = newCheckpointOperationId()
			const checkpointId = newCheckpointId()
			writeSnapshot(dataDir, checkpointId, operationId)
			writeCheckpointOperation(dataDir, operationId, checkpointId, "manifest-complete", {
				revision: baseRevision,
				current: oldCurrent,
				previous: oldPrevious,
			})

			await reconcileCheckpointOperations(dataDir)

			const state = await readCheckpointState(dataDir)
			strictEqual(state.current, checkpointId)
			strictEqual(state.previous, oldCurrent)
			ok(existsSync(checkpointSnapshotDir(dataDir, oldCurrent)))
			ok(!existsSync(checkpointSnapshotDir(dataDir, oldPrevious)))
		})
	})

	it("converges after every retirement intent, data-removal, and completion boundary", async () => {
		for (const boundary of [
			"afterRetirementIntent",
			"afterRetirementRename",
			"afterRetiredSnapshotRemoval",
			"afterRetirementComplete",
		] as const) {
			await withDataDir(async (dataDir) => {
				const current = newCheckpointId()
				const previous = newCheckpointId()
				const old = newCheckpointId()
				const retirementId = newCheckpointOperationId()
				writeSnapshot(dataDir, current)
				writeSnapshot(dataDir, previous)
				writeSnapshot(dataDir, old)
				writeState(dataDir, current, previous)
				const state = await readCheckpointState(dataDir)

				await rejects(
					retireCheckpointIfEligible(dataDir, old, state, retirementId, {
						[boundary]: () => {
							throw new Error(`injected ${boundary}`)
						},
					}),
					/injected/,
				)
				const retirement = await retireCheckpointIfEligible(dataDir, old, state, retirementId)

				ok(!existsSync(checkpointSnapshotDir(dataDir, old)), boundary)
				ok(retirement !== null && existsSync(join(retirement, "complete.json")), boundary)
				ok(existsSync(checkpointSnapshotDir(dataDir, current)), boundary)
				ok(existsSync(checkpointSnapshotDir(dataDir, previous)), boundary)
			})
		}
	})

	it("converges after every retirement cleanup and completed-operation boundary", async () => {
		for (const boundary of [
			"afterRetirementCleanupRename",
			"afterRetirementCleanupRemoval",
			"afterCompletedOperationPreserved",
		] as const) {
			await withDataDir(async (dataDir) => {
				const oldCurrent = newCheckpointId()
				const oldPrevious = newCheckpointId()
				const baseRevision = newCheckpointOperationId()
				const operationId = newCheckpointOperationId()
				const checkpointId = newCheckpointId()
				writeSnapshot(dataDir, oldCurrent)
				writeSnapshot(dataDir, oldPrevious)
				writeSnapshot(dataDir, checkpointId, operationId)
				writeState(dataDir, checkpointId, oldCurrent, operationId)
				writeCheckpointOperation(dataDir, operationId, checkpointId, "pointer-complete", {
					revision: baseRevision,
					current: oldCurrent,
					previous: oldPrevious,
				})
				let injected = false

				await rejects(
					reconcileCheckpointOperations(dataDir, {
						[boundary]: () => {
							if (injected) return
							injected = true
							throw new Error(`injected ${boundary}`)
						},
					}),
					/injected/,
				)
				await reconcileCheckpointOperations(dataDir)

				strictEqual((await readCheckpointState(dataDir)).current, checkpointId)
				ok(!existsSync(checkpointSnapshotDir(dataDir, oldPrevious)), boundary)
				ok(
					!existsSync(join(checkpointRoot(dataDir), "operations", `checkpoint-${operationId}`)),
					boundary,
				)
			})
		}
	})

	it("cleans an exactly completed retirement after the operation completion record", async () => {
		for (const keepRetirementRecord of [true, false]) {
			await withDataDir(async (dataDir) => {
				const oldCurrent = newCheckpointId()
				const oldPrevious = newCheckpointId()
				const baseRevision = newCheckpointOperationId()
				const operationId = newCheckpointOperationId()
				const checkpointId = newCheckpointId()
				writeSnapshot(dataDir, oldCurrent)
				writeSnapshot(dataDir, checkpointId, operationId)
				writeState(dataDir, checkpointId, oldCurrent, operationId)
				writeCheckpointOperation(dataDir, operationId, checkpointId, "retention-complete", {
					revision: baseRevision,
					current: oldCurrent,
					previous: oldPrevious,
				})
				const retirement = join(checkpointRoot(dataDir), "retiring", `retirement-${operationId}`)
				const interruptedCleanup = `${retirement}.cleanup-${newCheckpointId()}`
				if (keepRetirementRecord) {
					mkdirSync(retirement, { recursive: true })
					const record = {
						formatVersion: 1,
						retirementId: operationId,
						checkpointId: oldPrevious,
						stateRevision: operationId,
					}
					writeFileSync(join(retirement, "intent.json"), `${JSON.stringify(record)}\n`)
					writeFileSync(join(retirement, "complete.json"), `${JSON.stringify(record)}\n`)
				} else {
					mkdirSync(interruptedCleanup, { recursive: true })
					writeFileSync(join(interruptedCleanup, "preserve"), "completed cleanup debris")
				}

				await reconcileCheckpointOperations(dataDir)

				ok(!existsSync(retirement))
				if (!keepRetirementRecord) {
					strictEqual(
						readFileSync(join(interruptedCleanup, "preserve"), "utf8"),
						"completed cleanup debris",
					)
				}
				ok(!existsSync(join(checkpointRoot(dataDir), "operations", `checkpoint-${operationId}`)))
				strictEqual((await readCheckpointState(dataDir)).current, checkpointId)
			})
		}
	})

	it("retains current, previous, pinned, and malformed candidates; retires only proven safe", async () => {
		await withDataDir(async (dataDir) => {
			const current = newCheckpointId()
			const previous = newCheckpointId()
			const old = newCheckpointId()
			writeSnapshot(dataDir, current)
			writeSnapshot(dataDir, previous)
			writeSnapshot(dataDir, old)
			writeState(dataDir, current, previous)
			const state = await readCheckpointState(dataDir)

			await retireCheckpointIfEligible(dataDir, current, state)
			await retireCheckpointIfEligible(dataDir, previous, state)
			ok(existsSync(checkpointSnapshotDir(dataDir, current)))
			ok(existsSync(checkpointSnapshotDir(dataDir, previous)))

			const pinDir = join(checkpointRoot(dataDir), "pins", old)
			mkdirSync(pinDir, { recursive: true })
			writeFileSync(join(pinDir, "pin.json"), "{}")
			await retireCheckpointIfEligible(dataDir, old, state)
			ok(existsSync(checkpointSnapshotDir(dataDir, old)))

			rmSync(pinDir, { recursive: true })
			await retireCheckpointIfEligible(dataDir, old, state)
			ok(!existsSync(checkpointSnapshotDir(dataDir, old)))

			const malformed = newCheckpointId()
			writeSnapshot(dataDir, malformed)
			writeFileSync(join(checkpointSnapshotDir(dataDir, malformed), "manifest.json"), "{bad json")
			await rejects(retireCheckpointIfEligible(dataDir, malformed, state))
			ok(existsSync(checkpointSnapshotDir(dataDir, malformed)))
		})
	})
})

describe("live-store reset safety", () => {
	it("removes live chDB data and sibling markers while preserving the checkpoint registry", async () => {
		await withDataDir(async (dataDir) => {
			const checkpointId = newCheckpointId()
			writeSnapshot(dataDir, checkpointId)
			writeState(dataDir, checkpointId)
			mkdirSync(join(dataDir, "store"), { recursive: true })
			mkdirSync(join(dataDir, "metadata"), { recursive: true })
			mkdirSync(join(dataDir, "tmp"), { recursive: true })
			writeFileSync(join(dataDir, "store", "part.bin"), "live")
			writeFileSync(join(dataDir, "metadata", "table.sql"), "live")
			writeFileSync(join(dataDir, "status"), "live")
			writeFileSync(join(dataDir, "tmp", "scratch.bin"), "live")
			writeFileSync(storeMarkerPath(dataDir), "{}")
			writeFileSync(storeOpenMarkerPath(dataDir), "999\n")

			await Effect.runPromise(resetLiveStorePreservingCheckpoints(dataDir))

			strictEqual((await readCheckpointState(dataDir)).current, checkpointId)
			ok(existsSync(checkpointSnapshotDir(dataDir, checkpointId)))
			ok(!existsSync(join(dataDir, "store")))
			ok(!existsSync(join(dataDir, "metadata")))
			ok(!existsSync(join(dataDir, "status")))
			ok(!existsSync(join(dataDir, "tmp")))
			ok(!existsSync(storeMarkerPath(dataDir)))
			ok(!existsSync(storeOpenMarkerPath(dataDir)))
			ok(!existsSync(resetTransactionPath(dataDir)))
		})
	})

	it("fails closed before deleting live data when checkpoint infrastructure is unsafe", async () => {
		await withDataDir(async (dataDir) => {
			const outside = join(dirname(dataDir), "outside-pins")
			mkdirSync(outside)
			mkdirSync(checkpointRoot(dataDir), { recursive: true })
			symlinkSync(outside, join(checkpointRoot(dataDir), "pins"))
			mkdirSync(join(dataDir, "store"), { recursive: true })
			writeFileSync(join(dataDir, "store", "preserve.bin"), "live")

			await rejects(Effect.runPromise(resetLiveStorePreservingCheckpoints(dataDir)), /real directory/)
			strictEqual(readFileSync(join(dataDir, "store", "preserve.bin"), "utf8"), "live")
		})
	})

	it("preserves and reports unknown data-directory entries before any deletion", async () => {
		await withDataDir(async (dataDir) => {
			mkdirSync(join(dataDir, "store"), { recursive: true })
			writeFileSync(join(dataDir, "store", "preserve.bin"), "live")
			writeFileSync(join(dataDir, "user-owned.txt"), "preserve")

			await rejects(
				Effect.runPromise(resetLiveStorePreservingCheckpoints(dataDir)),
				/unrecognized data-directory entries were preserved/,
			)

			strictEqual(readFileSync(join(dataDir, "store", "preserve.bin"), "utf8"), "live")
			strictEqual(readFileSync(join(dataDir, "user-owned.txt"), "utf8"), "preserve")
			ok(!existsSync(resetTransactionPath(dataDir)))
		})
	})

	it("reconciles interruption at every reset deletion, marker, and journal boundary", async () => {
		const boundaries: ReadonlyArray<keyof RestoreRecoveryFaults> = [
			"afterResetIntent",
			"afterResetEntryRemoval",
			"afterResetLiveClearedRecord",
			"afterResetStoreMarkerRemoval",
			"afterResetOpenMarkerRemoval",
			"afterResetMarkersClearedRecord",
			"afterResetTransactionRemoval",
		]
		for (const boundary of boundaries) {
			await withDataDir(async (dataDir) => {
				const checkpointId = newCheckpointId()
				writeSnapshot(dataDir, checkpointId)
				writeState(dataDir, checkpointId)
				for (const entry of ["data", "metadata", "store", "tmp"]) {
					mkdirSync(join(dataDir, entry), { recursive: true })
					writeFileSync(join(dataDir, entry, "live.bin"), "live")
				}
				writeFileSync(join(dataDir, "status"), "live")
				writeFileSync(storeMarkerPath(dataDir), "{}")
				writeFileSync(storeOpenMarkerPath(dataDir), "999\n")
				let injected = false
				const faults = {
					[boundary]: () => {
						if (injected) return
						injected = true
						throw new Error(`injected ${boundary}`)
					},
				} as RestoreRecoveryFaults

				await rejects(
					Effect.runPromise(resetLiveStorePreservingCheckpoints(dataDir, faults)),
					/injected/,
				)
				await Effect.runPromise(reconcileCheckpointRecovery(dataDir))

				for (const entry of ["data", "metadata", "status", "store", "tmp"]) {
					ok(!existsSync(join(dataDir, entry)), `${boundary}: ${entry}`)
				}
				strictEqual((await readCheckpointState(dataDir)).current, checkpointId)
				ok(!existsSync(storeMarkerPath(dataDir)), boundary)
				ok(!existsSync(storeOpenMarkerPath(dataDir)), boundary)
				ok(!existsSync(resetTransactionPath(dataDir)), boundary)
			})
		}
	})

	it("rejects malformed or escaping reset journals without mutation", async () => {
		await withDataDir(async (dataDir) => {
			const outside = join(dirname(dataDir), "outside-reset")
			mkdirSync(outside)
			writeFileSync(join(outside, "preserve"), "outside")
			writeFileSync(
				resetTransactionPath(dataDir),
				`${JSON.stringify({
					formatVersion: 1,
					operationId: newCheckpointOperationId(),
					dataDir,
					targets: ["../outside-reset"],
					phase: "intent",
					createdAt: "2026-01-01T00:00:00.000Z",
				})}\n`,
			)

			const exit = await Effect.runPromise(Effect.exit(reconcileCheckpointRecovery(dataDir)))
			ok(Exit.isFailure(exit))
			const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
			ok(failure)
			strictEqual(failure._tag, "@maple/cli/CheckpointRecoveryError")
			match(failure.message, /targets|outside-reset/)
			strictEqual(readFileSync(join(outside, "preserve"), "utf8"), "outside")
			ok(existsSync(resetTransactionPath(dataDir)))
		})
	})
})

describe("live restore transaction reconciliation", () => {
	it("is a no-op when no transaction or restore debris exists", async () => {
		await withDataDir(async (dataDir) => {
			await Effect.runPromise(reconcileCheckpointRecovery(dataDir))
			ok(existsSync(dataDir))
		})
	})

	it("preserves an interrupted pre-ready restore and leaves the old live store selected", async () => {
		await withDataDir(async (dataDir) => {
			const operationId = newCheckpointOperationId()
			const checkpointId = newCheckpointId()
			const quarantineId = newCheckpointQuarantineId()
			writeFileSync(join(dataDir, "old-live"), "old")
			writeRestoreTransaction(dataDir, operationId, checkpointId, quarantineId, "intent")
			mkdirSync(restoreDataPath(dataDir, operationId), { recursive: true })
			writeFileSync(join(restoreDataPath(dataDir, operationId), "partial"), "partial")

			await Effect.runPromise(reconcileCheckpointRecovery(dataDir))

			ok(existsSync(join(dataDir, "old-live")))
			ok(!existsSync(restoreRootPath(dataDir, operationId)))
			ok(!existsSync(restoreTransactionPath(dataDir)))
			const siblingNames = readdirSync(dirname(dataDir))
			ok(
				siblingNames.some((name) =>
					name.startsWith(`${basename(dataDir)}.restore-${operationId}.quarantine-`),
				),
			)
			ok(
				siblingNames.some((name) =>
					name.startsWith(`${basename(dataDir)}.restore-transaction.json.quarantine-`),
				),
			)
		})
	})

	it("resumes from restore-ready through quarantine, swap, durable markers, and completion", async () => {
		await withDataDir(async (dataDir) => {
			const operationId = newCheckpointOperationId()
			const checkpointId = newCheckpointId()
			const quarantineId = newCheckpointQuarantineId()
			const quarantine = restoreQuarantinePath(dataDir, operationId, quarantineId)
			writeFileSync(join(dataDir, "old-live"), "old")
			writeFileSync(storeOpenMarkerPath(dataDir), "999\n")
			writeRestoreReady(dataDir, operationId, checkpointId)
			writeFileSync(join(restoreDataPath(dataDir, operationId), "new-live"), "new")
			writeRestoreTransaction(dataDir, operationId, checkpointId, quarantineId, "restore-ready")

			await Effect.runPromise(reconcileCheckpointRecovery(dataDir))

			ok(existsSync(join(dataDir, "new-live")))
			ok(existsSync(join(quarantine, "old-live")))
			ok(existsSync(storeMarkerPath(dataDir)))
			ok(!existsSync(storeOpenMarkerPath(dataDir)))
			ok(!existsSync(restoreTransactionPath(dataDir)))
			ok(!existsSync(restoreRootPath(dataDir, operationId)))
			await Effect.runPromise(reconcileCheckpointRecovery(dataDir))
		})
	})

	it("infers the recorded rename boundary from exact topology and completes idempotently", async () => {
		await withDataDir(async (dataDir) => {
			const operationId = newCheckpointOperationId()
			const checkpointId = newCheckpointId()
			const quarantineId = newCheckpointQuarantineId()
			const quarantine = restoreQuarantinePath(dataDir, operationId, quarantineId)
			writeFileSync(join(dataDir, "old-live"), "old")
			writeRestoreReady(dataDir, operationId, checkpointId)
			writeFileSync(join(restoreDataPath(dataDir, operationId), "new-live"), "new")
			writeRestoreTransaction(dataDir, operationId, checkpointId, quarantineId, "restore-ready")
			renameSync(dataDir, quarantine)

			await Effect.runPromise(reconcileCheckpointRecovery(dataDir))

			ok(existsSync(join(dataDir, "new-live")))
			ok(existsSync(join(quarantine, "old-live")))
			ok(!existsSync(restoreTransactionPath(dataDir)))
			await Effect.runPromise(reconcileCheckpointRecovery(dataDir))
		})
	})

	it("converges after interruption at every live-swap, marker, and cleanup boundary", async () => {
		const boundaries: ReadonlyArray<keyof RestoreRecoveryFaults> = [
			"afterLiveQuarantineRename",
			"afterOldQuarantinedRecord",
			"afterRestoredLiveRename",
			"afterNewLiveRecord",
			"afterStoreMarkerWrite",
			"afterOpenMarkerRemoval",
			"afterMarkersCommittedRecord",
			"afterReadyMarkerRemoval",
			"afterRestoreRootRemoval",
		]
		for (const boundary of boundaries) {
			await withDataDir(async (dataDir) => {
				const operationId = newCheckpointOperationId()
				const checkpointId = newCheckpointId()
				const quarantineId = newCheckpointQuarantineId()
				const quarantine = restoreQuarantinePath(dataDir, operationId, quarantineId)
				writeFileSync(join(dataDir, "old-live"), "old")
				writeFileSync(storeOpenMarkerPath(dataDir), "999\n")
				writeRestoreReady(dataDir, operationId, checkpointId)
				writeFileSync(join(restoreDataPath(dataDir, operationId), "new-live"), "new")
				writeRestoreTransaction(dataDir, operationId, checkpointId, quarantineId, "restore-ready")
				const faults = {
					[boundary]: () => {
						throw new Error(`injected ${boundary}`)
					},
				} as RestoreRecoveryFaults

				await rejects(Effect.runPromise(reconcileCheckpointRecovery(dataDir, faults)), /injected/)
				await Effect.runPromise(reconcileCheckpointRecovery(dataDir))

				ok(existsSync(join(dataDir, "new-live")), boundary)
				ok(existsSync(join(quarantine, "old-live")), boundary)
				ok(existsSync(storeMarkerPath(dataDir)), boundary)
				ok(!existsSync(storeOpenMarkerPath(dataDir)), boundary)
				ok(!existsSync(restoreTransactionPath(dataDir)), boundary)
				ok(!existsSync(restoreRootPath(dataDir, operationId)), boundary)
			})
		}
	})

	it("fails closed on malformed or unrecorded restore state without deleting it", async () => {
		await withDataDir(async (dataDir) => {
			writeFileSync(restoreTransactionPath(dataDir), "{bad json")
			await rejects(Effect.runPromise(reconcileCheckpointRecovery(dataDir)))
			ok(existsSync(restoreTransactionPath(dataDir)))
			rmSync(restoreTransactionPath(dataDir))

			const debris = `${dataDir}.restore-${newCheckpointOperationId()}`
			mkdirSync(debris)
			await rejects(
				Effect.runPromise(reconcileCheckpointRecovery(dataDir)),
				/without a valid transaction/,
			)
			ok(existsSync(debris))
		})
	})

	it("rejects symlinked transaction and restore topology without touching targets", async () => {
		await withDataDir(async (dataDir) => {
			const outside = join(dirname(dataDir), "outside-transaction")
			writeFileSync(outside, "{}")
			symlinkSync(outside, restoreTransactionPath(dataDir))
			await rejects(Effect.runPromise(reconcileCheckpointRecovery(dataDir)), /real file/)
			strictEqual(readFileSync(outside, "utf8"), "{}")
		})
		await withDataDir(async (dataDir) => {
			const operationId = newCheckpointOperationId()
			const checkpointId = newCheckpointId()
			const quarantineId = newCheckpointQuarantineId()
			const outside = join(dirname(dataDir), "outside-restore")
			mkdirSync(outside)
			writeFileSync(join(outside, "sentinel"), "preserve")
			writeRestoreTransaction(dataDir, operationId, checkpointId, quarantineId, "intent")
			symlinkSync(outside, restoreRootPath(dataDir, operationId))

			await rejects(Effect.runPromise(reconcileCheckpointRecovery(dataDir)), /real directory/)
			strictEqual(readFileSync(join(outside, "sentinel"), "utf8"), "preserve")
		})
	})
})

describe("backup configuration classification", () => {
	it("classifies only backup-specific errors", () => {
		const queryError = (detail: string) =>
			new LocalQueryError({
				status: 500,
				detail,
				message: `local query failed (500): ${detail}`,
				cause: detail,
			})
		ok(
			isMissingBackupConfigurationError(
				queryError("INVALID_CONFIG_PARAMETER: backups.allowed_disk is not set"),
			),
		)
		ok(isMissingBackupConfigurationError(queryError("Disk default is not allowed for backups")))
		ok(!isMissingBackupConfigurationError(queryError("INVALID_CONFIG_PARAMETER")))
		ok(!isMissingBackupConfigurationError(new Error("UNKNOWN_TABLE")))
		ok(!isMissingBackupConfigurationError(new Error("connection refused")))
	})
})

describe("durable filesystem primitives", () => {
	it("atomically replaces a file and syncs a directory on this platform", async () => {
		await withDataDir(async (dataDir) => {
			const path = join(dataDir, "state.json")
			await durableWrite(path, "old\n")
			await durableWrite(path, "new\n")
			strictEqual(readFileSync(path, "utf8"), "new\n")
			strictEqual(lstatSync(path).mode & 0o777, 0o600)
			await syncDirectory(dataDir)
		})
	})

	it("leaves the old destination intact when injected before file sync or rename", async () => {
		await withDataDir(async (dataDir) => {
			const path = join(dataDir, "state.json")
			await durableWrite(path, "old\n")
			await rejects(
				durableWrite(path, "new\n", {
					beforeFileSync: () => {
						throw new Error("sync fault")
					},
				}),
				/sync fault/,
			)
			strictEqual(readFileSync(path, "utf8"), "old\n")
			await rejects(
				durableWrite(path, "new\n", {
					beforeRename: () => {
						throw new Error("rename fault")
					},
				}),
				/rename fault/,
			)
			strictEqual(readFileSync(path, "utf8"), "old\n")
			strictEqual(readFileSync(path, "utf8"), "old\n", "fault must not partially publish new bytes")
		})
	})

	it("does not treat descriptor/type errors as unsupported directory sync", () => {
		ok(isUnsupportedDirectorySyncError({ code: "EINVAL" }))
		ok(isUnsupportedDirectorySyncError({ code: "ENOTSUP" }))
		ok(!isUnsupportedDirectorySyncError({ code: "EBADF" }))
		ok(!isUnsupportedDirectorySyncError({ code: "EISDIR" }))
	})

	it("refuses symlinks while syncing a checkpoint tree", async () => {
		await withDataDir(async (dataDir) => {
			const outside = join(dirname(dataDir), "outside.txt")
			writeFileSync(outside, "outside")
			symlinkSync(outside, join(dataDir, "link"))
			await rejects(syncTree(dataDir), /non-file checkpoint entry/)
			await syncTree(dataDir, { allowSymlinks: true })
			ok(existsSync(outside))
		})
	})
})

const throwsMessage = (run: () => unknown, expected: RegExp): void => {
	try {
		run()
		throw new Error("expected function to throw")
	} catch (error) {
		match(error instanceof Error ? error.message : String(error), expected)
	}
}
