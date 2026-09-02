import { createServer } from "node:net"
import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import { choosePort, preferredPort } from "./ports.ts"

describe("preferredPort", () => {
	it("is deterministic and inside the high range", () => {
		expect(preferredPort("maple/api")).toBe(preferredPort("maple/api"))
		expect(preferredPort("maple/api")).not.toBe(preferredPort("maple/web"))
		for (const key of ["maple/api", "maple/web", "x"]) {
			const port = preferredPort(key)
			expect(port).toBeGreaterThanOrEqual(40000)
			expect(port).toBeLessThan(50000)
		}
	})
})

describe("choosePort", () => {
	it("returns the preferred port when it is free", async () => {
		const key = "choosePort-free-test"
		expect(await Effect.runPromise(choosePort(key))).toBe(preferredPort(key))
	})

	it("walks forward when the preferred port is taken", async () => {
		const key = "choosePort-taken-test"
		const preferred = preferredPort(key)
		const blocker = createServer()
		await new Promise<void>((resolve) => blocker.listen({ host: "127.0.0.1", port: preferred }, resolve))
		try {
			expect(await Effect.runPromise(choosePort(key))).toBe(preferred + 1)
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()))
		}
	})
})
