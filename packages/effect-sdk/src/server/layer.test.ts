import { describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { afterEach, expect, vi } from "vitest"
import { layer } from "./layer.js"

// `Maple.layer` had no tests, which is how the "no-op when no endpoint" guard
// survived long after `resolveResource` started defaulting the endpoint — the
// branch was unreachable and nothing noticed. These cover both sides of the
// real disable rule: no ingest key resolved → no-op.

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

	it("no-ops when no ingest key is configured", async () => {
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
		const fetchSpy = vi.spyOn(globalThis, "fetch")

		const keys = await serviceKeys({ serviceName: "unit-test", endpoint: "https://collector.test" })

		expect(keys).toEqual([])
		expect(fetchSpy).not.toHaveBeenCalled()
		// One-shot notice so a keyless local run says why it is silent.
		expect(infoSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
			"no ingest key configured",
		)
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

	it("does not treat a missing endpoint as a disable signal", async () => {
		// The endpoint always resolves (public ingest is the fallback), so a key
		// with no endpoint must still produce a live layer.
		const keys = await serviceKeys({ serviceName: "unit-test", ingestKey: "secret" })

		expect(keys).toContain("effect/Tracer")
	})
})
