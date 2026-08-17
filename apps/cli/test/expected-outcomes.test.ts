import { describe, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect } from "effect"
import { ok, strictEqual } from "node:assert"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chdbConfigPath, resolveChdbConfigFile } from "../src/commands/server"
import { recoverExpected } from "../src/core/outcomes"

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
