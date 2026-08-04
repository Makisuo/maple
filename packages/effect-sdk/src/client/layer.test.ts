import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, expect, vi } from "vitest"
import { layer } from "./layer.js"

// Regression guard for the `withSessionLink` extraction: `Maple.layer` (the
// Otlp-based client preset) must still wire the replay-session decorator, so a
// span created under it reports its trace id to the published session sink.
// (That the decorator also stamps `session.id` onto the OTLP span is asserted
// robustly — off the actual exported body — in flushable.test.ts.)

const setupFetch = () => {
	const original = globalThis.fetch
	globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch
	return () => void (globalThis.fetch = original)
}

describe("Maple.layer (client) — session linking after refactor", () => {
	let restore: () => void

	afterEach(() => {
		restore?.()
	})

	it("records the trace id and stamps session.id via the published session sink", async () => {
		const restoreFetch = setupFetch()
		const g = globalThis as Record<string, any>
		const recordTraceId = vi.fn()
		g.__MAPLE_BROWSER_SESSION__ = { sessionId: "sess-xyz", recordTraceId }
		restore = () => {
			restoreFetch()
			delete g.__MAPLE_BROWSER_SESSION__
		}

		const TracerLive = layer({
			serviceName: "web-test",
			endpoint: "https://collector.test",
			ingestKey: "secret",
		})

		await Effect.runPromise(
			Effect.sync(() => undefined).pipe(Effect.withSpan("page-load"), Effect.provide(TracerLive)),
		)

		// The session sink saw this span's trace id — proves the decorator is
		// still wired into Maple.layer post-extraction.
		expect(recordTraceId).toHaveBeenCalledTimes(1)
		expect(recordTraceId.mock.calls[0][0]).toMatch(/^[0-9a-f]{32}$/i)
	})

	it("no-ops cleanly when no session sink is published", async () => {
		const restoreFetch = setupFetch()
		const g = globalThis as Record<string, any>
		delete g.__MAPLE_BROWSER_SESSION__
		restore = restoreFetch

		const TracerLive = layer({
			serviceName: "web-test",
			endpoint: "https://collector.test",
		})

		// Just has to run without throwing — proves the layer still composes.
		await Effect.runPromise(
			Effect.sync(() => undefined).pipe(Effect.withSpan("page-load"), Effect.provide(TracerLive)),
		)
	})
})
