import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, expect, vi } from "vitest"
import { make } from "./flushable.js"

// Regression: a failed resource resolution used to be memoized as a rejected
// promise, which disabled telemetry for the process lifetime AND turned the
// auto-flush timer's `void flush()` into a recurring unhandled rejection (fatal
// under `--unhandled-rejections=strict`).
//
// `resolveResource` is `Effect.orDie`, so any defect inside it becomes a
// rejection. `crypto.randomUUID` is the realistic trigger — `resolveResource`
// calls it for `service.instance.id`, and it is absent on older/exotic runtimes.
//
// Lives in its own file because the resolution memo and the `service.instance.id`
// memo are both module-level: a sibling test that flushed successfully would
// prime them and mask the bug.

// This file is intentionally the only one exercising a failing resolve.
describe("MapleFlush.make (server) — resource resolution failure", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("does not reject, and retries on the next flush", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const uuidSpy = vi.spyOn(globalThis.crypto, "randomUUID").mockImplementationOnce(() => {
			throw new Error("randomUUID unavailable")
		})

		const calls: Array<string> = []
		const originalFetch = globalThis.fetch
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
			return new Response(null, { status: 200 })
		}) as typeof fetch

		try {
			const telemetry = make({
				serviceName: "unit-test",
				endpoint: "https://collector.test",
				ingestKey: "secret",
				autoFlushInterval: false,
			})

			await Effect.runPromise(
				Effect.succeed(undefined).pipe(Effect.withSpan("op-1"), Effect.provide(telemetry.layer)),
			)

			// The contract is "never rejects" — an unhandled rejection here is the bug.
			await expect(telemetry.flush()).resolves.toBeUndefined()
			expect(calls).toEqual([])
			expect(errorSpy).toHaveBeenCalled()

			// The failure must not be cached: with `randomUUID` working again, the
			// next flush resolves the resource and exports the retained span.
			expect(uuidSpy).toHaveBeenCalledTimes(1)
			await telemetry.flush()
			expect(calls.some((url) => url.endsWith("/v1/traces"))).toBe(true)
		} finally {
			globalThis.fetch = originalFetch
		}
	})
})
