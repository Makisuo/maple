import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert"
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
	checkpointRoot,
	checkpointSnapshotDir,
	checkpointStatePath,
	isMissingBackupConfigurationError,
	LocalQueryError,
	newCheckpointId,
	parseCheckpointManifest,
	parseCheckpointState,
	readCheckpointState,
	reconcileCheckpointRecovery,
	reconcileCheckpointOperations,
	resolveCheckpoint,
	restoreDataPath,
	restoreQuarantinePath,
	restoreRootPath,
	restoreTransactionPath,
	retireCheckpointIfEligible,
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

const manifest = (checkpointId: string, operationId = newCheckpointId()): Record<string, unknown> => ({
	formatVersion: 1,
	checkpointId,
	operationId,
	mapleVersion: MAPLE_VERSION,
	chdbVersion: CHDB_VERSION,
	schemaFingerprint: SCHEMA_FINGERPRINT,
	createdAt: "2026-01-01T00:00:00.000Z",
	sourceDataDir: "/tmp/maple-data",
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

const writeSnapshot = (dataDir: string, checkpointId: string): void => {
	const snapshot = checkpointSnapshotDir(dataDir, checkpointId)
	mkdirSync(join(snapshot, "backup"), { recursive: true })
	writeFileSync(join(snapshot, "backup", "data.bin"), "backup")
	writeFileSync(join(snapshot, "manifest.json"), `${JSON.stringify(manifest(checkpointId))}\n`)
}

const writeState = (
	dataDir: string,
	current: string,
	previous: string | null = null,
	revision = newCheckpointId(),
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
	operationId: string,
	checkpointId: string,
	quarantineId: string,
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

const writeRestoreReady = (dataDir: string, operationId: string, checkpointId: string): void => {
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
			/invalid logs/,
		)
	})

	it("accepts versioned current/previous state and rejects malformed selection", () => {
		const current = newCheckpointId()
		const previous = newCheckpointId()
		const revision = newCheckpointId()
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
})

describe("checkpoint reconciliation and retention", () => {
	it("quarantines only an exactly owned incomplete operation and preserves its bytes", async () => {
		await withDataDir(async (dataDir) => {
			const operationId = newCheckpointId()
			const checkpointId = newCheckpointId()
			const operationDir = join(checkpointRoot(dataDir), "operations", `checkpoint-${operationId}`)
			const snapshot = checkpointSnapshotDir(dataDir, checkpointId)
			mkdirSync(join(snapshot, "backup"), { recursive: true })
			writeFileSync(join(snapshot, "backup", "partial.bin"), "partial")
			mkdirSync(operationDir, { recursive: true })
			writeFileSync(
				join(operationDir, "intent.json"),
				`${JSON.stringify({
					formatVersion: 1,
					operationId,
					checkpointId,
					phase: "backup-complete",
					startedAt: "2026-01-01T00:00:00.000Z",
				})}\n`,
			)

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

describe("live restore transaction reconciliation", () => {
	it("is a no-op when no transaction or restore debris exists", async () => {
		await withDataDir(async (dataDir) => {
			await Effect.runPromise(reconcileCheckpointRecovery(dataDir))
			ok(existsSync(dataDir))
		})
	})

	it("preserves an interrupted pre-ready restore and leaves the old live store selected", async () => {
		await withDataDir(async (dataDir) => {
			const operationId = newCheckpointId()
			const checkpointId = newCheckpointId()
			const quarantineId = newCheckpointId()
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
			const operationId = newCheckpointId()
			const checkpointId = newCheckpointId()
			const quarantineId = newCheckpointId()
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
			const operationId = newCheckpointId()
			const checkpointId = newCheckpointId()
			const quarantineId = newCheckpointId()
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

	it("fails closed on malformed or unrecorded restore state without deleting it", async () => {
		await withDataDir(async (dataDir) => {
			writeFileSync(restoreTransactionPath(dataDir), "{bad json")
			await rejects(Effect.runPromise(reconcileCheckpointRecovery(dataDir)))
			ok(existsSync(restoreTransactionPath(dataDir)))
			rmSync(restoreTransactionPath(dataDir))

			const debris = `${dataDir}.restore-${newCheckpointId()}`
			mkdirSync(debris)
			await rejects(
				Effect.runPromise(reconcileCheckpointRecovery(dataDir)),
				/without a valid transaction/,
			)
			ok(existsSync(debris))
		})
	})
})

describe("backup configuration classification", () => {
	it("classifies only backup-specific errors", () => {
		ok(
			isMissingBackupConfigurationError(
				new LocalQueryError(500, "INVALID_CONFIG_PARAMETER: backups.allowed_disk is not set"),
			),
		)
		ok(
			isMissingBackupConfigurationError(
				new LocalQueryError(500, "Disk default is not allowed for backups"),
			),
		)
		ok(!isMissingBackupConfigurationError(new LocalQueryError(500, "INVALID_CONFIG_PARAMETER")))
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
