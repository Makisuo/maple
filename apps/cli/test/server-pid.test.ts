import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claimPidFileExclusive } from "../src/commands/server"

describe("start PID claim is exclusive", () => {
	it("exactly one claimant wins; the loser fails without touching the file", async () => {
		const root = mkdtempSync(join(tmpdir(), "maple-pid-claim-"))
		try {
			const pidPath = join(root, "maple.pid")
			await Effect.runPromise(claimPidFileExclusive(pidPath))
			expect(readFileSync(pidPath, "utf8")).toBe(String(process.pid))
			// A racing second start must fail with the already-running refusal —
			// before this claim existed, both starts passed the read-then-check
			// guard and raced to open the same chDB store.
			const second = await Effect.runPromiseExit(claimPidFileExclusive(pidPath))
			expect(Exit.isFailure(second)).toBe(true)
			expect(JSON.stringify(second)).toContain("already running or starting")
			expect(readFileSync(pidPath, "utf8")).toBe(String(process.pid))
			expect(existsSync(pidPath)).toBe(true)
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})
