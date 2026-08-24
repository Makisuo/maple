import { describe, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect } from "effect"
import { ok, strictEqual } from "node:assert"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	chdbConfigPath,
	dirtyStoreRecoveryAdvice,
	needsInitialCheckpoint,
	resolveChdbConfigFile,
} from "../src/commands/server"
import { CheckpointPreconditionError, parseCheckpointId } from "../src/server/checkpoints"
import { recoverExpected } from "../src/core/outcomes"
import {
	BackgroundServerSpawnError,
	BackgroundServerTimeoutError,
	CheckpointUnavailableError,
	LocalStoreDirtyError,
	LocalStoreIncompatibleError,
	LocalStoreMigrationError,
	LocalStoreSchemaStaleError,
	ServerOptionError,
	ServerStopTimeoutError,
} from "../src/commands/server-errors"

/** Run an effect, capturing anything written to stderr and restoring the real
 *  writer + exit code afterwards. */
const captureStderr = async (effect: Effect.Effect<void>): Promise<string> => {
	const original = process.stderr.write.bind(process.stderr)
	const previousExitCode = process.exitCode
	let captured = ""
	process.stderr.write = ((chunk: string) => {
		captured += chunk
		return true
	}) as typeof process.stderr.write
	try {
		await Effect.runPromise(effect)
		return captured
	} finally {
		process.stderr.write = original
		// `?? 0`, not the raw value: assigning `undefined` back is a no-op in Bun, so
		// the 1 these helpers set would leak out and fail the whole test run.
		process.exitCode = previousExitCode ?? 0
	}
}

describe("expected CLI outcomes", () => {
	// The point of the recovery is that the root span stays Ok. That is only
	// observable through the *absence* of a failure, so the assertion is that the
	// effect succeeds while still reporting to the user.
	it("succeeds instead of failing, so the root span closes Ok", async () => {
		const output = await captureStderr(
			recoverExpected({
				_tag: "@maple/cli/ServerStateError",
				message: "maple is already running (PID 4242) — stop it with `maple stop`",
			}),
		)
		strictEqual(output, "maple is already running (PID 4242) — stop it with `maple stop`\n")
	})

	// The "no `<backups>` stanza" refusal used to bill two error events: an Error
	// span on `CheckpointService.create` plus the `ServerError` the command
	// re-wrapped it into. It is now an expected outcome carrying the same text.
	it("recovers the checkpoint precondition refusal with its message intact", async () => {
		const refusal = new CheckpointPreconditionError({
			dataDir: "/home/u/.maple/data",
			message:
				"the running server's chDB config has no `<backups>` stanza, so it " +
				"cannot take checkpoints. Restart `maple start` without " +
				"`--chdb-config-file` to use the generated default, or add " +
				"`<backups><allowed_disk>default</allowed_disk>" +
				"<allowed_path>backups</allowed_path></backups>` to your config.",
		})

		strictEqual(refusal._tag, "@maple/cli/CheckpointPreconditionError")
		strictEqual(refusal.expected, true)
		strictEqual(await captureStderr(recoverExpected(refusal)), `${refusal.message}\n`)
	})

	it("still exits non-zero, so scripts and CI keep their old behaviour", async () => {
		const original = process.exitCode
		const restoreStderr = process.stderr.write.bind(process.stderr)
		process.stderr.write = (() => true) as typeof process.stderr.write
		try {
			process.exitCode = 0
			await Effect.runPromise(
				recoverExpected({ _tag: "@maple/cli/ServerStateError", message: "not running" }),
			)
			strictEqual(process.exitCode, 1)
		} finally {
			process.stderr.write = restoreStderr
			process.exitCode = original ?? 0
		}
	})
})

describe("dirty-store recovery advice", () => {
	// The dead end this guards: `maple start` refused to open an unclean store and
	// told the user to run `maple restore --yes`, which aborted with "checkpoint
	// state not found" because no checkpoint had ever been taken. Both messages
	// were accurate and neither named a command that would get them running.
	it("never sends the user to restore when there is no checkpoint to restore", () => {
		const none = dirtyStoreRecoveryAdvice({ available: false, reason: "none" })
		ok(!none.includes("maple restore"))
		ok(none.includes("maple start --reset"))
		ok(none.includes("maple checkpoint"))

		const unusable = dirtyStoreRecoveryAdvice({
			available: false,
			reason: "unusable",
			detail: "checkpoint backup size mismatch",
		})
		ok(!unusable.includes("maple restore"))
		ok(unusable.includes("checkpoint backup size mismatch"))
		ok(unusable.includes("maple start --reset"))
	})

	it("offers restore, naming the checkpoint, once one exists", () => {
		const advice = dirtyStoreRecoveryAdvice({
			available: true,
			checkpointId: parseCheckpointId("00000000-0000-4000-8000-000000000000"),
		})
		ok(advice.includes("maple restore --yes"))
		ok(advice.includes("00000000-0000-4000-8000-000000000000"))
		ok(advice.includes("maple start --reset"))
	})
})

describe("default chDB backups config", () => {
	it("places the generated config beside the data dir, not inside it", () => {
		strictEqual(chdbConfigPath("/home/u/.maple/data"), "/home/u/.maple/chdb-config.xml")
	})

	it("generates a backups-enabled config when no --chdb-config-file is given", async () => {
		const root = mkdtempSync(join(tmpdir(), "maple-chdb-config-"))
		try {
			const dataDir = join(root, "data")
			const resolved = await Effect.runPromise(
				resolveChdbConfigFile(dataDir, undefined).pipe(Effect.provide(BunServices.layer)),
			)

			strictEqual(resolved, chdbConfigPath(dataDir))
			ok(resolved !== undefined && existsSync(resolved))

			// Without these two, `BACKUP DATABASE default TO Disk('default', …)`
			// fails with Code 318 and checkpoints are impossible — which is exactly
			// the state this default exists to prevent.
			const xml = readFileSync(resolved, "utf8")
			ok(xml.includes("<allowed_disk>default</allowed_disk>"))
			ok(xml.includes("<allowed_path>backups</allowed_path>"))
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	it("honours a user-supplied config untouched and writes nothing", async () => {
		const root = mkdtempSync(join(tmpdir(), "maple-chdb-config-"))
		try {
			const dataDir = join(root, "data")
			const supplied = join(root, "mine.xml")
			const resolved = await Effect.runPromise(
				resolveChdbConfigFile(dataDir, supplied).pipe(Effect.provide(BunServices.layer)),
			)

			strictEqual(resolved, supplied)
			strictEqual(existsSync(chdbConfigPath(dataDir)), false)
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})

describe("initial checkpoint on start", () => {
	// The dead end this exists to close: nothing created a checkpoint except a
	// user typing `maple checkpoint`, so an unclean shutdown left `maple start`
	// with only one honest remedy — wipe the store. That was the CLI's largest
	// source of real errors, and every one was someone losing their telemetry.
	it("takes one when the store has never been checkpointed", () => {
		strictEqual(needsInitialCheckpoint({ available: false, reason: "none" }), true)
	})

	it("never takes a second one", () => {
		strictEqual(
			needsInitialCheckpoint({
				available: true,
				checkpointId: parseCheckpointId("00000000-0000-4000-8000-000000000000"),
			}),
			false,
		)
	})

	// Overwriting a broken registry would destroy the evidence of why it broke,
	// and `maple restore` reports that state deliberately.
	it("leaves an unusable registry alone rather than papering over it", () => {
		strictEqual(
			needsInitialCheckpoint({
				available: false,
				reason: "unusable",
				detail: "checkpoint backup size mismatch",
			}),
			false,
		)
	})
})
