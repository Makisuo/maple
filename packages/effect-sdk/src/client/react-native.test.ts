// SAFETY-FILE: OTLP payloads are produced by the real SDK and decoded only for assertions.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

interface Attribute {
	readonly key: string
	readonly value: { readonly stringValue?: string }
}

interface OtlpPayload {
	readonly resourceSpans?: ReadonlyArray<{
		readonly scopeSpans: ReadonlyArray<{
			readonly spans: ReadonlyArray<{
				readonly name: string
				readonly attributes: ReadonlyArray<Attribute>
			}>
		}>
	}>
	readonly resourceLogs?: ReadonlyArray<{
		readonly scopeLogs: ReadonlyArray<{
			readonly logRecords: ReadonlyArray<{ readonly body: { readonly stringValue?: string } }>
		}>
	}>
	readonly resourceMetrics?: ReadonlyArray<{
		readonly scopeMetrics: ReadonlyArray<{
			readonly metrics: ReadonlyArray<{ readonly name: string }>
		}>
	}>
}

const config = {
	serviceName: "native-test",
	endpoint: "https://collector.test",
	ingestKey: "test-key",
	autoFlushInterval: false as const,
}

beforeEach(() => {
	vi.resetModules()
	// React Native exposes window, but has neither a DOM nor Web Crypto.
	// Keep its fetch/encoding primitives: this suite mocks only the transport.
	vi.stubGlobal("window", globalThis)
	vi.stubGlobal("navigator", { product: "ReactNative" })
	for (const name of [
		"document",
		"crypto",
		"location",
		"localStorage",
		"sessionStorage",
		"addEventListener",
		"removeEventListener",
	])
		vi.stubGlobal(name, undefined)
})

afterEach(async () => {
	const { clearIdentity } = await import("./index.js")
	const { resetConsentForTests } = await import("@maple/browser-session")
	clearIdentity()
	resetConsentForTests()
	vi.unstubAllGlobals()
})

describe("React Native client telemetry", () => {
	it.each(["layer", "flushable"] as const)(
		"imports and exports traces, logs, metrics, and identity with %s",
		async (preset) => {
			const posts: Array<{ readonly request: Request; readonly body: OtlpPayload }> = []
			vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init)
				posts.push({ request, body: await request.json() })
				return new Response(null, { status: 200 })
			})
			// Import the public client entry only after removing browser globals, so
			// eager module initialization is covered too. No telemetry modules are mocked.
			const { Maple, MapleFlush } = await import("./index.js")
			const { Effect, ManagedRuntime, Metric } = await import("effect")
			const telemetry = preset === "flushable" ? MapleFlush.make(config) : undefined
			const runtime = ManagedRuntime.make(telemetry?.layer ?? Maple.layer(config))
			try {
				await runtime.runPromise(
					Effect.gen(function* () {
						yield* Maple.identify("native-user")
						yield* Effect.log("native-log").pipe(Effect.withSpan("native-span"))
						yield* Maple.clearIdentity
						yield* Effect.void.pipe(Effect.withSpan("anonymous-span"))
						yield* Metric.update(Metric.counter("native_counter"), 1)
					}),
				)
			} finally {
				try {
					await runtime.dispose()
				} finally {
					await telemetry?.dispose()
				}
			}

			const spans = posts.flatMap(
				({ body }) =>
					body.resourceSpans?.flatMap((resource) =>
						resource.scopeSpans.flatMap((scope) => scope.spans),
					) ?? [],
			)
			expect(spans.map((span) => span.name)).toEqual(["native-span", "anonymous-span"])
			expect(spans[0].attributes).toContainEqual({
				key: "user.id",
				value: { stringValue: "native-user" },
			})
			expect(spans[1].attributes.some((attribute) => attribute.key === "user.id")).toBe(false)
			expect(
				spans.every((span) => span.attributes.every((attribute) => attribute.key !== "session.id")),
			).toBe(true)
			const logs = posts.flatMap(
				({ body }) =>
					body.resourceLogs?.flatMap((resource) =>
						resource.scopeLogs.flatMap((scope) => scope.logRecords),
					) ?? [],
			)
			expect(logs).toContainEqual(expect.objectContaining({ body: { stringValue: "native-log" } }))
			const metrics = posts.flatMap(
				({ body }) =>
					body.resourceMetrics?.flatMap((resource) =>
						resource.scopeMetrics.flatMap((scope) => scope.metrics),
					) ?? [],
			)
			expect(metrics).toContainEqual(expect.objectContaining({ name: "native_counter" }))
			expect(new Set(posts.map(({ request }) => request.url))).toEqual(
				new Set([
					"https://collector.test/v1/traces",
					"https://collector.test/v1/logs",
					"https://collector.test/v1/metrics",
				]),
			)
			for (const { request } of posts) {
				expect(request.headers.get("authorization")).toBe("Bearer test-key")
			}
		},
	)

	it("skips standalone browser metadata without requiring Web Crypto", async () => {
		const { setupStandaloneSession } = await import("./standalone-session.js")
		expect(setupStandaloneSession(config)).toBeUndefined()
	})

	it("still configures consent when browser session startup is skipped", async () => {
		const { startClientSession } = await import("./replay-loader.js")
		const { getActiveSink, hasConsent } = await import("@maple/browser-session")
		const session = startClientSession({ ...config, privacy: { requireConsent: true } })
		try {
			expect(hasConsent()).toBe(false)
			expect(getActiveSink()).toBeUndefined()
		} finally {
			await session.stop()
		}
	})
})
