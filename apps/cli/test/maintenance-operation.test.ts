// The maintenance lock's release lives in a `finally` inside promise land, so
// whether it runs is decided entirely by the Effect boundary above it. These
// tests pin that boundary from both sides: the bare `Effect.tryPromise` shape
// that used to wrap every archive/migration entry point leaks the lock on
// interruption, and `maintenanceOperation` does not.
import { describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber } from "effect"
import { ok, strictEqual } from "node:assert"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { maintenanceOperation, withMaintenanceLock } from "../src/server/checkpoints"

// Deliberately recomputed from the on-disk contract rather than imported: this
// pins the sibling path a *different* process must find and reconcile.
const lockPathOf = (dataDir: string): string => `${resolve(dataDir)}.maple-maintenance-lock`

const withTempDataDir = async (run: (dataDir: string) => Promise<void>): Promise<void> => {
	const root = mkdtempSync(join(tmpdir(), "maple-maintenance-boundary-"))
	const dataDir = join(root, "data")
	mkdirSync(dataDir, { recursive: true, mode: 0o700 })
	try {
		await run(dataDir)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

/** A locked operation that parks until released, so a test can interrupt it
 *  at a known point: strictly after the lock is taken, strictly before the
 *  `finally` that releases it. */
const parkedOperation = (dataDir: string) => {
	let signalEntered!: () => void
	let signalFinish!: () => void
	const entered = new Promise<void>((r) => (signalEntered = r))
	const finish = new Promise<void>((r) => (signalFinish = r))
	const state = { completed: false }
	const body = () =>
		withMaintenanceLock(dataDir, crypto.randomUUID(), async () => {
			signalEntered()
			await finish
			state.completed = true
		})
	return { body, entered, release: signalFinish, state }
}

describe("maintenance lock Effect boundary", () => {
	it("bare Effect.tryPromise abandons the operation and leaks the lock", async () => {
		await withTempDataDir(async (dataDir) => {
			const op = parkedOperation(dataDir)
			const fiber = Effect.runFork(Effect.tryPromise({ try: op.body, catch: (error) => error }))
			await op.entered
			ok(existsSync(lockPathOf(dataDir)), "precondition: the lock is held")

			// Exactly what `BunRuntime.runMain`'s SIGINT handler does.
			fiber.interruptUnsafe()
			const exit = await Effect.runPromise(Fiber.await(fiber))

			// The fiber is gone while the promise is still parked mid-operation.
			ok(Exit.hasInterrupts(exit), "the fiber was interrupted")
			strictEqual(op.state.completed, false, "the operation never finished")
			ok(
				existsSync(lockPathOf(dataDir)),
				"THE BUG: the lock survives because the promise's `finally` never ran",
			)

			// Let the abandoned promise finish so the temp dir can be removed.
			op.release()
			await new Promise((r) => setTimeout(r, 50))
		})
	})

	it("maintenanceOperation waits for the operation, so the lock is always released", async () => {
		await withTempDataDir(async (dataDir) => {
			const op = parkedOperation(dataDir)
			const fiber = Effect.runFork(
				maintenanceOperation({ operation: "test.parked", try: op.body, catch: (error) => error }),
			)
			await op.entered
			ok(existsSync(lockPathOf(dataDir)), "precondition: the lock is held")

			// Interrupt while the operation holds the lock, the same way
			// `BunRuntime.runMain`'s SIGINT handler does. Nothing may unwind yet:
			// the interrupt is recorded on the fiber, not delivered.
			const interrupting = Effect.runPromise(Fiber.await(fiber))
			fiber.interruptUnsafe()
			await new Promise((r) => setTimeout(r, 50))
			strictEqual(op.state.completed, false, "still parked — the interrupt did not abandon it")
			ok(existsSync(lockPathOf(dataDir)), "still holding the lock it took")

			op.release()
			const exit = await interrupting

			strictEqual(op.state.completed, true, "the operation ran to completion")
			ok(Exit.hasInterrupts(exit), "the deferred interrupt is still delivered afterwards")
			ok(!existsSync(lockPathOf(dataDir)), "THE FIX: the lock was released")
		})
	})

	it("releases the lock on the ordinary success and failure paths too", async () => {
		await withTempDataDir(async (dataDir) => {
			const okExit = await Effect.runPromise(
				maintenanceOperation({
					operation: "test.success",
					try: () => withMaintenanceLock(dataDir, crypto.randomUUID(), async () => 7),
					catch: (error) => error,
				}),
			)
			strictEqual(okExit, 7)
			ok(!existsSync(lockPathOf(dataDir)), "released after success")

			const failed = await Effect.runPromise(
				Effect.exit(
					maintenanceOperation({
						operation: "test.failure",
						try: () =>
							withMaintenanceLock(dataDir, crypto.randomUUID(), async () => {
								throw new Error("boom")
							}),
						catch: (error) => (error instanceof Error ? error.message : String(error)),
					}),
				),
			)
			strictEqual(Exit.isFailure(failed), true)
			ok(!existsSync(lockPathOf(dataDir)), "released after failure")
		})
	})
})
