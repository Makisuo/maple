import { describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { makeRecoverablePromiseMemo } from "./recoverable-promise-memo"

describe("makeRecoverablePromiseMemo", () => {
	it("shares a concurrent build, retains success, and retries rejection", async () => {
		let builds = 0
		const memo = makeRecoverablePromiseMemo(async () => {
			builds++
			if (builds === 1) throw new Error("first build failed")
			return { build: builds }
		})

		const first = memo.get()
		expect(memo.get()).toBe(first)
		await expect(first).rejects.toThrow("first build failed")

		const recovered = await memo.get()
		expect(recovered).toEqual({ build: 2 })
		expect(await memo.get()).toBe(recovered)
		expect(builds).toBe(2)
	})

	it("evicts a handler after rejected lazy layer acquisition", async () => {
		let acquisitions = 0
		const memo = makeRecoverablePromiseMemo(async () => {
			const acquisition = Layer.effectDiscard(
				Effect.sync(() => {
					acquisitions++
					if (acquisitions === 1) throw new Error("first handler acquisition failed")
				}),
			)
			const routes = Layer.merge(
				HttpRouter.use((router) => router.add("GET", "/test", HttpServerResponse.text("OK"))),
				acquisition,
			)
			return HttpRouter.toWebHandler(routes, { disableLogger: true })
		})

		const firstPending = memo.get()
		expect(memo.get()).toBe(firstPending)
		const first = await firstPending
		await expect(first.handler(new Request("https://worker.invalid/test"))).rejects.toThrow(
			"first handler acquisition failed",
		)
		expect(memo.evict(firstPending)).toBe(true)
		expect(memo.evict(firstPending)).toBe(false)
		await first.dispose()

		const recovered = await memo.get()
		expect((await recovered.handler(new Request("https://worker.invalid/test"))).status).toBe(200)
		expect(acquisitions).toBe(2)
		await recovered.dispose()
	})

	it("retries a rejected ManagedRuntime layer acquisition", async () => {
		let acquisitions = 0
		const memo = makeRecoverablePromiseMemo(async () => {
			const runtime = ManagedRuntime.make(
				Layer.effectDiscard(
					Effect.sync(() => {
						acquisitions++
						if (acquisitions === 1) throw new Error("first runtime acquisition failed")
					}),
				),
			)
			try {
				await runtime.context()
				return runtime
			} catch (error) {
				await runtime.dispose()
				throw error
			}
		})

		await expect(memo.get()).rejects.toThrow("first runtime acquisition failed")
		const recovered = await memo.get()
		expect(await recovered.runPromise(Effect.succeed("ok"))).toBe("ok")
		expect(acquisitions).toBe(2)
		await recovered.dispose()
	})
})
