import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, expect } from "vitest"
import { make } from "./flushable.js"
import { identify } from "./user.js"

// `withSessionLink` (shared by Maple.layer and MapleFlush.make) stamps the
// signed-in end-user as `user.id` on every span, read per span from the
// module-level identity that `identify()` sets. Assertions run off the actual
// exported OTLP body. Module state (`currentUserId`) is fresh per test file, so
// ordering within this file is authoritative: the "anonymous" case runs before
// any `identify()` call.

interface FetchCall {
	readonly url: string
	readonly body: unknown
}

const setupFetch = () => {
	const calls: Array<FetchCall> = []
	const original = globalThis.fetch
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : undefined
		calls.push({ url, body })
		return new Response(null, { status: 200 })
	}) as typeof fetch
	return { calls, restore: () => void (globalThis.fetch = original) }
}

const baseConfig = {
	serviceName: "unit-test",
	endpoint: "https://collector.test",
	ingestKey: "secret",
	environment: "test",
	autoFlushInterval: false as const,
	flushOnUnload: false as const,
}

const firstSpanAttrs = (calls: Array<FetchCall>) => {
	const traceCall = calls.find((c) => c.url.endsWith("/v1/traces"))!
	const span = (
		traceCall.body as {
			resourceSpans: Array<{
				scopeSpans: Array<{
					spans: Array<{ attributes: Array<{ key: string; value: { stringValue?: string } }> }>
				}>
			}>
		}
	).resourceSpans[0].scopeSpans[0].spans[0]
	return span.attributes
}

describe("withSessionLink — user.id span stamping", () => {
	let restore: () => void

	afterEach(() => {
		restore?.()
	})

	// Must run before any identify() call — asserts the anonymous baseline.
	it("stamps no user.id before identify() is called", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make(baseConfig)

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("anon-op"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush()

		const attrs = firstSpanAttrs(calls)
		expect(attrs.find((a) => a.key === "user.id")).toBeUndefined()
	})

	it("stamps user.id on spans after identify()", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r
		identify("user_abc123")
		const telemetry = make(baseConfig)

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("known-op"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush()

		const attrs = firstSpanAttrs(calls)
		expect(attrs.find((a) => a.key === "user.id")?.value.stringValue).toBe("user_abc123")
	})
})
