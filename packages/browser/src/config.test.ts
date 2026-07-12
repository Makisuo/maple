import { describe, expect, it } from "vitest"
import { resolveConfig } from "./config"

describe("resolveConfig", () => {
	it("applies defaults and strips the endpoint's trailing slash", () => {
		const config = resolveConfig({ ingestKey: "maple_pk_x", serviceName: "acme-web" })
		expect(config.endpoint).toBe("https://ingest.maple.dev")
		expect(config.tracingEnabled).toBe(true)
		expect(config.tracingInstrumentFetch).toBe(true)
		expect(config.replayEnabled).toBe(true)
		expect(config.replaySampleRate).toBe(1)
		expect(config.maskAllInputs).toBe(true)
		expect(config.maskAllText).toBe(false)

		const custom = resolveConfig({
			ingestKey: "maple_pk_x",
			serviceName: "acme-web",
			endpoint: "https://ingest.example.com/",
			userId: null,
			tracing: { instrumentFetch: false },
			replay: { sampleRate: 0.25 },
		})
		expect(custom.endpoint).toBe("https://ingest.example.com")
		expect(custom.userId).toBeUndefined()
		expect(custom.tracingInstrumentFetch).toBe(false)
		expect(custom.replaySampleRate).toBe(0.25)
	})
})
