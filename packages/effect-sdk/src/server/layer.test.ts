import { describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { afterEach, expect, vi } from "vitest"
import { layer } from "./layer.js"

// `Maple.layer` had no tests, which is how a dead `if (!resolved.endpoint)`
// guard survived long after `resolveResource` started defaulting the endpoint.
// These pin the real contract: this layer ALWAYS exports. A missing ingest key
// is not a disable signal — keyless export to a local `maple start` sink or a
// self-hosted collector is supported, and silently no-op'ing would break it.

const serviceKeys = async (config: Parameters<typeof layer>[0]): Promise<Array<string>> => {
	const context = await Effect.runPromise(Effect.scoped(Layer.build(layer(config))))
	// `CurrentMemoMap` is bookkeeping every `Layer.build` adds, including
	// `Layer.empty`'s — it is not a service the layer contributed.
	return [...context.mapUnsafe.keys()].filter((key) => key !== "effect/Layer/CurrentMemoMap")
}

describe("Maple.layer", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("installs tracer, logger, and exporter when an ingest key is configured", async () => {
		const keys = await serviceKeys({
			serviceName: "unit-test",
			endpoint: "https://collector.test",
			ingestKey: "secret",
		})

		expect(keys).toContain("effect/Tracer")
		expect(keys).toContain("effect/Loggers/CurrentLoggers")
		expect(keys).toContain("effect/observability/OtlpExporter/Flusher")
	})

	it("still exports to a custom endpoint with no ingest key", async () => {
		// The `examples/effect-todo` shape: local-mode sink, no key. Disabling
		// this was a real regression, so it gets a test of its own.
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		const keys = await serviceKeys({ serviceName: "unit-test", endpoint: "http://127.0.0.1:4318" })

		expect(keys).toContain("effect/Tracer")
		// A self-hosted collector taking unauthenticated writes is legitimate —
		// no scolding.
		expect(warnSpy).not.toHaveBeenCalled()
	})

	it("warns once when keyless against the public ingest, but still builds", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		// No endpoint → defaults to the public ingest, which 401s without a key.
		const keys = await serviceKeys({ serviceName: "unit-test" })

		expect(keys).toContain("effect/Tracer")
		expect(warnSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain("401")
	})
})
