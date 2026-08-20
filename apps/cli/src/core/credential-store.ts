import { Effect, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const SERVICE = "maple-cli"

interface HelperResult {
	readonly ok: boolean
	readonly stdout: string
}

const notRun: HelperResult = { ok: false, stdout: "" }

/**
 * Run a native credential helper and collect its exit status and stdout.
 *
 * A missing, non-executable, or signal-killed helper means "this machine has no
 * usable native credential store", which every caller already handles by
 * falling back to file storage. That still degrades to `ok: false` — but the
 * cause is logged rather than discarded, so a broken keychain is no longer
 * indistinguishable from a machine that simply has none.
 */
const run = (
	cmd: readonly [string, ...ReadonlyArray<string>],
	stdin?: string,
): Effect.Effect<HelperResult, never, ChildProcessSpawner> => {
	const [command, ...args] = cmd
	return Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner
		const handle = yield* spawner.spawn(
			ChildProcess.make(command, args, {
				stdin: stdin === undefined ? "ignore" : Stream.make(new TextEncoder().encode(stdin)),
				stdout: "pipe",
				stderr: "ignore",
			}),
		)
		// Collect the exit status and drain stdout concurrently: the helper cannot
		// exit until its output is consumed, and stdout is not complete until the
		// pipe closes.
		const [exitCode, stdout] = yield* Effect.all(
			[handle.exitCode, Stream.mkString(Stream.decodeText(handle.stdout))],
			{ concurrency: "unbounded" },
		)
		return { ok: exitCode === 0, stdout: stdout.trim() }
	}).pipe(
		Effect.scoped,
		Effect.tapCause((cause) => Effect.logDebug(`credential helper ${command} failed`, cause)),
		Effect.orElseSucceed(() => notRun),
	)
}

export const credentialAccount = (apiUrl: string): string => new URL(apiUrl).origin

export const readNativeCredential = (
	apiUrl: string,
): Effect.Effect<string | undefined, never, ChildProcessSpawner> =>
	Effect.gen(function* () {
		const account = credentialAccount(apiUrl)
		if (process.platform === "darwin") {
			const result = yield* run([
				"/usr/bin/security",
				"find-generic-password",
				"-s",
				SERVICE,
				"-a",
				account,
				"-w",
			])
			return result.ok && result.stdout ? result.stdout : undefined
		}
		if (process.platform === "linux") {
			const result = yield* run(["secret-tool", "lookup", "service", SERVICE, "origin", account])
			return result.ok && result.stdout ? result.stdout : undefined
		}
		return undefined
	})

export const writeNativeCredential = (
	apiUrl: string,
	token: string,
): Effect.Effect<boolean, never, ChildProcessSpawner> =>
	Effect.gen(function* () {
		const account = credentialAccount(apiUrl)
		if (process.platform === "darwin") {
			// With -w as the final option and no argument, `security` reads the secret
			// from stdin instead of exposing it in the process list.
			const result = yield* run(
				["/usr/bin/security", "add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w"],
				`${token}\n`,
			)
			return result.ok
		}
		if (process.platform === "linux") {
			const result = yield* run(
				["secret-tool", "store", "--label=Maple CLI", "service", SERVICE, "origin", account],
				`${token}\n`,
			)
			return result.ok
		}
		return false
	})

export const deleteNativeCredential = (apiUrl: string): Effect.Effect<void, never, ChildProcessSpawner> =>
	Effect.gen(function* () {
		const account = credentialAccount(apiUrl)
		if (process.platform === "darwin") {
			yield* run(["/usr/bin/security", "delete-generic-password", "-s", SERVICE, "-a", account])
			return
		}
		if (process.platform === "linux") {
			yield* run(["secret-tool", "clear", "service", SERVICE, "origin", account])
		}
	})
