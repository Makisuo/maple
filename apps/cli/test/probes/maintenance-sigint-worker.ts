// Real-process SIGINT worker for the maintenance-lock Effect boundary.
//
// This is a committed TEST SEAM, not production code. It exists because the
// property under test is a property of the PROCESS, not of a function: whether
// `<dataDir>.maple-maintenance-lock` survives a Ctrl-C depends on the
// interaction between `BunRuntime.runMain`'s SIGINT handler, the fiber's
// interruptibility, and a `finally` that lives inside promise land. Nothing
// here is stubbed — real runMain, real signal, real lock directory.
//
// The worker takes the maintenance lock through the same `withMaintenanceLock`
// production uses, prints READY once it is held, and stays inside the locked
// section for --hold-ms. The harness sends SIGINT during that window.
//
// Usage:
//   bun apps/cli/test/probes/maintenance-sigint-worker.ts \
//     --data-dir <d> --hold-ms <n> [--boundary maintenance|bare]
//
// `--boundary bare` reproduces the pre-fix `Effect.tryPromise` shape, so the
// harness can assert the probe distinguishes the two rather than passing
// vacuously.

import { BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"
import { maintenanceOperation, withMaintenanceLock } from "../../src/server/checkpoints"

const arg = (name: string): string | undefined => {
	const index = process.argv.indexOf(`--${name}`)
	return index === -1 ? undefined : process.argv[index + 1]
}

const dataDir = arg("data-dir")
if (dataDir === undefined) {
	process.stderr.write("missing --data-dir\n")
	process.exit(2)
}
const holdMs = Number.parseInt(arg("hold-ms") ?? "1500", 10)
const boundary = arg("boundary") ?? "maintenance"

const locked = () =>
	withMaintenanceLock(dataDir, crypto.randomUUID(), async () => {
		// Announce only AFTER the lock is on disk, so the harness's SIGINT can
		// never land before the window it means to test.
		process.stdout.write("READY\n")
		await new Promise((resolve) => setTimeout(resolve, holdMs))
		process.stdout.write("COMPLETED\n")
	})

const program =
	boundary === "bare"
		? Effect.tryPromise({ try: locked, catch: (error) => error })
		: maintenanceOperation({ operation: "probe.sigint", try: locked, catch: (error) => error })

BunRuntime.runMain(program)
